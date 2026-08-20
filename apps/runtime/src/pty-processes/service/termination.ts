import { Effect, Either } from 'effect';

import type { InternalRuntimeEventBusService } from '../../runtime-events/index.js';
import type { PtyProcessRecord } from '../../surfaces/index.js';
import type { PtyBackendCatalogService } from '../backend.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import { PtyServiceError, PtyTerminationInProgressError } from '../types.js';
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
import type { PtyRetryScheduler } from './retry.js';

// What this attempt actually did, never what the row happens to say afterwards.
// `terminated_live` means this attempt killed a live process — the only outcome
// a caller may bind its own stop cause to. `already_absent` means nothing was
// there to stop, so the incarnation's terminal fact stays owned by whatever
// really caused it. A failure carries no terminal evidence at all.
export type PtyTerminateOutcome = 'terminated_live' | 'already_absent';

export function terminatePtyProcess(input: {
  readonly repository: PtyRepositoryService;
  readonly catalog: PtyBackendCatalogService;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly terminations: PtyTerminations;
  readonly retry: PtyRetryScheduler;
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
    readonly repository: PtyRepositoryService;
    readonly catalog: PtyBackendCatalogService;
    readonly eventBus: InternalRuntimeEventBusService;
    readonly activeAttachments: Map<number, ActiveAttachment>;
    readonly terminations: PtyTerminations;
    readonly retry: PtyRetryScheduler;
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
    const backend = input.catalog.forBackend(session.backend);
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
    ).pipe(Effect.either);

    // Affirmative kill. The captured exit, if any, describes the death this
    // attempt caused, so it is discarded rather than persisted as an
    // independent fact.
    if (Either.isRight(killResult) && killResult.right.terminated) {
      const transition = yield* persistKilledTransition(input, session).pipe(Effect.either);
      if (Either.isLeft(transition)) {
        // The kill is real even though its write is not durable yet; the retry
        // takes over both the write and the reservation.
        retryPersistKilledUntilSuccess(
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
      console.info(
        `[runtime] PTY process terminated ptyProcessId=${session.id} reason=${input.reason} outcome=terminated_live`,
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
      if (Either.isLeft(killResult)) {
        console.info(
          `[runtime] PTY termination found an independent exit ptyProcessId=${session.id} reason=${input.reason}`,
          killResult.left,
        );
      }
      return 'already_absent' as const;
    }

    releaseTerminationFromAttempt(input.terminations, session.id, termination);
    if (Either.isLeft(killResult)) {
      // Failed with no terminal evidence: the process may well still be alive,
      // so nothing is written and the caller decides what to do about it.
      return yield* Effect.fail(killResult.left);
    }
    return 'already_absent' as const;
  });
}

function concludeReservation(
  input: {
    readonly repository: PtyRepositoryService;
    readonly eventBus: InternalRuntimeEventBusService;
    readonly activeAttachments: Map<number, ActiveAttachment>;
    readonly terminations: PtyTerminations;
    readonly retry: PtyRetryScheduler;
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

function findPtyProcessOrFail(repository: PtyRepositoryService, ptyProcessId: number) {
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
    readonly repository: PtyRepositoryService;
    readonly eventBus: InternalRuntimeEventBusService;
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
