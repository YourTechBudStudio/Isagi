import { Effect } from 'effect';

import type { DatabaseError } from '../../persistence/index.js';
import type { InternalRuntimeEventBusService } from '../../runtime-events/index.js';
import type { PtyBackendCatalogService } from '../backend.js';
import type { PtyRepositoryService } from '../pty.repository.js';
import {
  isTerminalPtyProcessStatus,
  missingStatusReasonForBackend,
  PtyServiceError,
  type PtyKillError,
  type PtyTerminationInProgressError,
} from '../types.js';
import type { ActiveAttachment } from './attachments.js';
import { decodeBackendRef } from './backend-ref.js';
import { transitionProcessAndPublish } from './events.js';
import type { DurablePtyTerminationReason, PtyTerminations } from './lifecycle.js';
import type { PtyRetryScheduler } from './retry.js';
import { terminatePtyProcess } from './termination.js';

// What this cleanup attempt established about the incarnation, and nothing
// more. `terminated` means it killed something live; `already_terminal` means
// the incarnation is durably finished — either it already was, or this attempt
// verified there is nothing behind it to kill.
//
// Deliberately *not* an outcome: "probably gone". Every case where the process
// truth could not be established travels on the error channel, because both
// callers — boot convergence and the worktree-deletion audit — make
// irreversible decisions from it.
export type PtyProcessCleanupOutcome = 'already_terminal' | 'terminated';

export type PtyProcessCleanupError =
  | DatabaseError
  | PtyServiceError
  | PtyKillError
  | PtyTerminationInProgressError;

export interface PtyCleanupDependencies {
  readonly repository: PtyRepositoryService;
  readonly catalog: PtyBackendCatalogService;
  readonly eventBus: InternalRuntimeEventBusService;
  readonly activeAttachments: Map<number, ActiveAttachment>;
  readonly terminations: PtyTerminations;
  readonly retry: PtyRetryScheduler;
}

/**
 * Verify-or-terminate one incarnation, through the adapter its own row records.
 *
 * This is a PTY-layer operation in the strict sense: it may read, kill, and
 * persist process facts, and it knows nothing about who owns the row. Command
 * boot convergence and the worktree-deletion audit both drive it and then draw
 * their own conclusions.
 */
export function cleanupPtyProcess(
  deps: PtyCleanupDependencies,
  input: {
    readonly ptyProcessId: number;
    readonly reason: DurablePtyTerminationReason;
    readonly gracefulTimeoutMs?: number | undefined;
    // A terminal row is not trusted: its ref receives one dispatched kill
    // before the caller is allowed to treat the incarnation as finished. Used
    // by worktree deletion, where a session that materialized after its row
    // went terminal would otherwise survive the cascade unobserved.
    readonly ensureBackendAbsence?: boolean | undefined;
  },
): Effect.Effect<PtyProcessCleanupOutcome, PtyProcessCleanupError> {
  return Effect.gen(function* () {
    const session = yield* deps.repository.findProcess(input.ptyProcessId);
    // No row is no incarnation. There is nothing to address, verify, or kill,
    // and a caller holding a dangling link learns the same thing either way.
    if (!session) return 'already_terminal' as const;

    if (isTerminalPtyProcessStatus(session.status)) {
      if (!input.ensureBackendAbsence) return 'already_terminal' as const;

      // The gating check. `kill` has no `unavailable` outcome of its own, so
      // the adapter is probed first to keep a genuinely missing backend a
      // structured `backend_unavailable` rather than a raw kill failure — the
      // same rule termination follows.
      const backend = deps.catalog.forBackend(session.backend);
      if (!(yield* backend.available)) {
        return yield* Effect.fail(backendUnavailable(session.backend, session.id));
      }
      const ref = yield* decodeBackendRef(session);
      const result = yield* backend.kill(ref);
      // `{terminated:false}` is verified absence, not a failure: the backend
      // looked and found nothing. `{terminated:true}` killed a live liar. No
      // durable write either way — the row's terminal fact is already final and
      // immutable, and this attempt learned nothing that contradicts it.
      return result.terminated ? ('terminated' as const) : ('already_terminal' as const);
    }

    // Nonterminal. No `available` pre-check here: `inspect` already answers
    // alive | missing | unavailable, so probing first would only buy a second
    // round-trip to the same backend for an outcome it is about to report.
    const ref = yield* decodeBackendRef(session);
    const inspection = yield* deps.catalog
      .forBackend(session.backend)
      .inspect(ref)
      .pipe(Effect.catchAll((cause) => Effect.succeed({ status: 'unavailable' as const, cause })));

    if (inspection.status === 'unavailable') {
      return yield* Effect.fail(backendUnavailable(session.backend, session.id));
    }

    if (inspection.status === 'missing') {
      // Guarded: if some other observer already recorded this incarnation's
      // death, that first fact stands and this write is rejected. Either way
      // the process is accounted for.
      yield* transitionProcessAndPublish(deps.repository, deps.eventBus, session, {
        ptyProcessId: session.id,
        status: 'failed',
        statusReason: missingStatusReasonForBackend(session.backend),
        exitCode: session.exitCode,
        signal: session.signal,
      });
      return 'already_terminal' as const;
    }

    // Alive. Termination is the sole owner of causal process control — the
    // reservation, the outcome honesty, and the deferred persistence retry all
    // live there, so this delegates rather than reimplementing any of it.
    const outcome = yield* terminatePtyProcess({
      repository: deps.repository,
      catalog: deps.catalog,
      eventBus: deps.eventBus,
      activeAttachments: deps.activeAttachments,
      terminations: deps.terminations,
      retry: deps.retry,
      ptyProcessId: session.id,
      reason: input.reason,
      ...(input.gracefulTimeoutMs === undefined
        ? {}
        : { gracefulTimeoutMs: input.gracefulTimeoutMs }),
    });
    // `already_absent` means the process ended between the inspection and the
    // kill. Nothing false is persisted for it; the row stays nonterminal until
    // its own independent terminal fact lands, and the caller is still entitled
    // to conclude that this incarnation is not something it has to stop.
    return outcome === 'terminated_live' ? ('terminated' as const) : ('already_terminal' as const);
  });
}

function backendUnavailable(backend: string, ptyProcessId: number) {
  return new PtyServiceError({
    code: 'backend_unavailable',
    message: `PTY backend ${backend} is unavailable.`,
    ptyProcessId,
  });
}
