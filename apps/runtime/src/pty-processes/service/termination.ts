import { Effect, Result } from 'effect';

import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import type { InternalEvents } from '../../platform/events/index.js';
import type { PtyBackendCatalog } from '../backend.js';
import type { PtyRepository } from '../repository.js';
import type { PtyProcessRecord } from '../types.js';
import { PtyServiceError, PtyTeardownError, PtyTerminationInProgressError } from '../types.js';
import type { ActiveAttachment } from './attachments.js';
import { detachActiveAttachment } from './attachments.js';
import { decodeBackendRef } from './backend-ref.js';
import { transitionProcessAndPublish } from './events.js';
import {
  persistCapturedExitAndRelease,
  releaseTerminationFromAttempt,
  reservePtyTermination,
  retryPersistKilledUntilSuccess,
  type DurablePtyTerminationReason,
  type PtyTerminations,
  type PtyTerminationState,
} from './lifecycle.js';
import type { PtyPersistenceRetry } from './retry.js';

// What this attempt actually did, never what the row happens to say afterwards.
// `terminated_live` means this attempt killed a live process — the only outcome
// a caller may bind its own stop cause to. `already_absent` means nothing was
// there to stop, so the incarnation's terminal fact stays owned by whatever
// really caused it. A failure carries no terminal evidence at all.
export type PtyTerminateOutcome = 'terminated_live' | 'already_absent';

/**
 * Terminates several processes at once for an owner tearing down its durable entities (a deleted
 * worktree, a deleted surface). Every termination runs concurrently and every failure is logged.
 * `required` fails with `PtyTeardownError` naming every process that could not be stopped;
 * `best_effort` logs and succeeds.
 */
export function terminatePtyProcesses<E>(
  terminate: (input: {
    readonly ptyProcessId: number;
    readonly gracefulTimeoutMs: number;
  }) => Effect.Effect<PtyTerminateOutcome, E>,
  input: {
    readonly failurePolicy: 'best_effort' | 'required';
    readonly gracefulTimeoutMs: number;
    readonly operation: string;
    readonly ptyProcessIds: readonly number[];
  },
): Effect.Effect<void, PtyTeardownError> {
  return Effect.gen(function* () {
    const results = yield* Effect.all(
      input.ptyProcessIds.map((ptyProcessId) =>
        terminate({ ptyProcessId, gracefulTimeoutMs: input.gracefulTimeoutMs }).pipe(
          Effect.result,
          Effect.map((result) => ({ ptyProcessId, result })),
        ),
      ),
      { concurrency: 'unbounded' },
    );
    const failures = results.flatMap(({ ptyProcessId, result }) =>
      Result.isFailure(result) ? [{ ptyProcessId, cause: result.failure }] : [],
    );
    if (failures.length === 0) return;

    for (const failure of failures) {
      yield* Effect.logWarning('Failed to terminate PTY process').pipe(
        Effect.annotateLogs({
          operation: input.operation,
          ptyProcessId: failure.ptyProcessId,
          cause: describeOperationalCause(failure.cause),
        }),
      );
    }

    if (input.failurePolicy === 'required') {
      return yield* Effect.fail(
        new PtyTeardownError({
          operation: input.operation,
          ptyProcessIds: failures.map((failure) => failure.ptyProcessId),
          cause: failures[0]?.cause,
        }),
      );
    }
  });
}

export function terminatePtyProcess(input: {
  readonly repository: PtyRepository['Service'];
  readonly catalog: PtyBackendCatalog['Service'];
  readonly eventBus: InternalEvents['Service'];
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly terminations: PtyTerminations;
  readonly retry: PtyPersistenceRetry;
  readonly ptyProcessId: number;
  readonly reason: DurablePtyTerminationReason;
  readonly gracefulTimeoutMs?: number | undefined;
}) {
  return Effect.gen(function* () {
    const session = yield* findPtyProcessOrFail(input.repository, input.ptyProcessId);

    // Reserve before any suspension point. Everything below — ref decoding, the
    // availability probe, detaching, the backend call — can yield the fiber, so a
    // later check-and-set would let two attempts both believe they hold the row.
    const termination = reservePtyTermination(input.terminations, session.id, input.reason);
    if (!termination) {
      // Not `already_absent`: no absence was observed. Not joined either —
      // handing this caller the other attempt's affirmative kill would lend it a
      // causality it never established.
      return yield* Effect.fail(new PtyTerminationInProgressError({ ptyProcessId: session.id }));
    }

    return yield* Effect.uninterruptibleMask((restore) =>
      runReservedTermination(input, session, termination, restore),
    ).pipe(
      // Owns only the intervals the reserved region did not resolve itself:
      // interruption or a defect before an affirmative result was delivered. A
      // no-op once a persistence retry has taken ownership.
      Effect.ensuring(concludeReservation(input, session.id, termination)),
    );
  });
}

function runReservedTermination(
  input: {
    readonly repository: PtyRepository['Service'];
    readonly catalog: PtyBackendCatalog['Service'];
    readonly eventBus: InternalEvents['Service'];
    readonly activeAttachments: Map<number, ActiveAttachment>;
    readonly terminations: PtyTerminations;
    readonly retry: PtyPersistenceRetry;
    readonly reason: DurablePtyTerminationReason;
    readonly gracefulTimeoutMs?: number | undefined;
  },
  session: PtyProcessRecord,
  termination: PtyTerminationState,
  restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    // Ref decoding, the availability probe, and the backend call stay
    // cancellable; everything else — detaching, and every path after the backend
    // answers — runs uninterruptibly, so an affirmative kill is always converted
    // into a durable fact or into retry ownership rather than being lost to a
    // cancelled request.
    const ref = yield* restore(decodeBackendRef(session));
    // The incarnation is operated through the transport that created it, not the
    // current launch preference. Termination has no `unavailable` outcome of its
    // own, so the adapter is probed first to keep a genuinely missing backend a
    // structured `backend_unavailable` rather than a raw kill failure.
    const backend = yield* input.catalog.forBackend(session.backend);
    if (!(yield* restore(backend.available))) {
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'backend_unavailable',
          message: `PTY backend ${session.backend} is unavailable.`,
          ptyProcessId: session.id,
        }),
      );
    }

    yield* detachActiveAttachment(input.activeAttachments, session.id);

    const killResult = yield* restore(
      backend.terminate
        ? backend.terminate({ ref, gracefulTimeoutMs: input.gracefulTimeoutMs ?? 2_000 })
        : backend.kill(ref),
    ).pipe(Effect.result);

    // Affirmative kill. The captured exit, if any, describes the death this
    // attempt caused, so it is discarded rather than persisted as an
    // independent fact.
    if (Result.isSuccess(killResult) && killResult.success.terminated) {
      const transition = yield* persistKilledTransition(input, session).pipe(Effect.result);
      if (Result.isFailure(transition)) {
        // The kill is real even though its write is not durable yet; the retry
        // takes over both the write and the reservation.
        yield* retryPersistKilledUntilSuccess(
          input.repository,
          input.eventBus,
          input.retry,
          input.terminations,
          session.id,
          termination,
        );
      } else {
        releaseTerminationFromAttempt(input.terminations, session.id, termination);
      }
      yield* Effect.logInfo('PTY process terminated').pipe(
        Effect.annotateLogs({
          ptyProcessId: session.id,
          reason: input.reason,
          outcome: 'terminated_live',
        }),
      );
      return 'terminated_live' as const;
    }

    // No affirmative kill. Any exit captured during the window is independent
    // terminal evidence: persist it under the still-held reservation, but never
    // let it bind this attempt's cause.
    if (termination.exit) {
      yield* persistCapturedExitAndRelease(
        input.repository,
        input.eventBus,
        input.retry,
        input.activeAttachments,
        input.terminations,
        session.id,
        termination,
        termination.exit,
      );
      if (Result.isFailure(killResult)) {
        yield* Effect.logInfo('PTY termination found an independent exit').pipe(
          Effect.annotateLogs({
            ptyProcessId: session.id,
            reason: input.reason,
            cause: describeOperationalCause(killResult.failure),
          }),
        );
      }
      return 'already_absent' as const;
    }

    releaseTerminationFromAttempt(input.terminations, session.id, termination);
    if (Result.isFailure(killResult)) {
      // Failed with no terminal evidence: the process may well still be alive,
      // so nothing is written and the caller decides what to do about it.
      return yield* Effect.fail(killResult.failure);
    }
    return 'already_absent' as const;
  });
}

function concludeReservation(
  input: {
    readonly repository: PtyRepository['Service'];
    readonly eventBus: InternalEvents['Service'];
    readonly activeAttachments: Map<number, ActiveAttachment>;
    readonly terminations: PtyTerminations;
    readonly retry: PtyPersistenceRetry;
  },
  ptyProcessId: number,
  termination: PtyTerminationState,
) {
  return Effect.suspend(() => {
    if (termination.ownership !== 'attempt') return Effect.void;
    if (termination.exit) {
      return persistCapturedExitAndRelease(
        input.repository,
        input.eventBus,
        input.retry,
        input.activeAttachments,
        input.terminations,
        ptyProcessId,
        termination,
        termination.exit,
      ).pipe(Effect.asVoid);
    }
    return Effect.sync(() =>
      releaseTerminationFromAttempt(input.terminations, ptyProcessId, termination),
    );
  });
}

function findPtyProcessOrFail(repository: PtyRepository['Service'], ptyProcessId: number) {
  return Effect.gen(function* () {
    const session = yield* repository.findProcess(ptyProcessId);
    if (!session) {
      return yield* Effect.fail(
        new PtyServiceError({
          code: 'session_not_found',
          message: `PTY process ${ptyProcessId} was not found.`,
          ptyProcessId,
        }),
      );
    }
    return session;
  });
}

function persistKilledTransition(
  input: {
    readonly repository: PtyRepository['Service'];
    readonly eventBus: InternalEvents['Service'];
    readonly reason: DurablePtyTerminationReason;
  },
  session: PtyProcessRecord,
) {
  return transitionProcessAndPublish(input.repository, input.eventBus, session, {
    ptyProcessId: session.id,
    status: 'killed',
    statusReason: input.reason,
    exitCode: null,
    signal: null,
  });
}
