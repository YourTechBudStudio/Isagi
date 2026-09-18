import { Effect } from 'effect';

import type { WorkflowOperationsRepositoryService } from '../persistence/operations.repository.js';
import type { WorkflowWriteResult } from '../persistence/outcomes.js';
import type { WorkflowOperationRecord } from '../persistence/records.js';
import type { OperationAdapters } from './adapters/types.js';
import { isSettled } from './correlation.js';

const stopGraceMs = 1_000;

/** Per-capability stop completeness, reported rather than assumed. */
export interface StopSummary {
  readonly requested: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly unsupported: number;
  readonly pending: number;
}

/**
 * Asking external work to stop, and saying honestly how far that got.
 *
 * The recurring rule across every branch: a stop request is not proof of stopping, and an operation
 * reaching an outcome is not proof that its process is gone. Those are different columns because
 * they are different facts, and a summary that collapsed them would let the product claim something
 * nobody observed.
 */
export interface OperationStopPolicy {
  readonly requestStop: (
    record: WorkflowOperationRecord,
    detail: string,
  ) => Effect.Effect<WorkflowWriteResult<WorkflowOperationRecord>, never>;
  readonly stopOwnedOperations: (input: {
    readonly runId: number;
    readonly reason: string;
  }) => Effect.Effect<StopSummary, never>;
}

export function makeOperationStopPolicy(dependencies: {
  readonly operations: WorkflowOperationsRepositoryService;
  readonly adapters: OperationAdapters;
}): OperationStopPolicy {
  const { operations, adapters } = dependencies;

  const die = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, never> =>
    effect.pipe(Effect.orDie);

  const requestStop = (record: WorkflowOperationRecord, detail: string) =>
    Effect.gen(function* () {
      if (record.capability === 'send_agent_prompt') {
        // A turn already handed to an interactive agent cannot be recalled, and pretending
        // otherwise would report a stop nobody performed.
        return yield* die(
          operations.recordStopOutcome({
            operationId: record.id,
            stopState: 'unsupported',
            detail: 'interactive_turn_not_stoppable',
          }),
        );
      }
      if (record.capability === 'spawn_agent_session') {
        // The session and its pane are durable entities the person owns. A workflow that sent one
        // prompt does not get to delete them.
        return yield* die(
          operations.recordStopOutcome({
            operationId: record.id,
            stopState: 'unsupported',
            detail: 'shared_session_not_owned',
          }),
        );
      }
      if (record.capability === 'close_pane') {
        return yield* die(
          operations.recordStopOutcome({
            operationId: record.id,
            stopState: 'confirmed',
            detail: 'close_pane_is_idempotent',
          }),
        );
      }
      if (record.ptyProcessId === null) {
        return yield* die(
          operations.recordStopOutcome({
            operationId: record.id,
            stopState: 'confirmed',
            detail: 'no_process_was_started',
          }),
        );
      }
      const outcome = yield* adapters.headless
        .terminate({ ptyProcessId: record.ptyProcessId, gracefulTimeoutMs: stopGraceMs })
        .pipe(Effect.either);
      if (outcome._tag === 'Left') {
        // An unavailable backend, or another attempt already holding the row, leaves liveness
        // genuinely unobserved. Recording that as `failed` would claim we learned something; it
        // stays `pending` and a later sweep retries it.
        const unobservable = isUnobservableStop(outcome.left);
        return yield* die(
          operations.recordStopOutcome({
            operationId: record.id,
            stopState: unobservable ? 'pending' : 'failed',
            detail: `${detail}:${outcome.left.message}`,
          }),
        );
      }
      // `terminated_live` killed a live process; `already_absent` observed that none was there.
      // Both are observations. Neither is inferred from a row status, and a stop being confirmed
      // here still says nothing about whether the *operation* succeeded.
      return yield* die(
        operations.recordStopOutcome({ operationId: record.id, stopState: 'confirmed', detail }),
      );
    });

  // ---- headless capture -------------------------------------------------

  const stopOwnedOperations = (input: { readonly runId: number; readonly reason: string }) =>
    Effect.gen(function* () {
      const all = yield* die(operations.listForRun(input.runId));
      const targets = all.filter(
        (record) =>
          !isSettled(record.state) ||
          record.stopState === 'pending' ||
          // A post-spawn failure may have left a live process. The operation is settled and the
          // cleanup is not; those are different obligations.
          (record.state === 'failed' &&
            record.ptyProcessId !== null &&
            record.stopState === 'not_requested'),
      );
      let summary: StopSummary = {
        requested: 0,
        confirmed: 0,
        failed: 0,
        unsupported: 0,
        pending: 0,
      };
      for (const record of targets) {
        const written = yield* requestStop(record, input.reason);
        summary = { ...summary, requested: summary.requested + 1 };
        const state = written.ok ? written.value.stopState : record.stopState;
        summary =
          state === 'confirmed'
            ? { ...summary, confirmed: summary.confirmed + 1 }
            : state === 'failed'
              ? { ...summary, failed: summary.failed + 1 }
              : state === 'unsupported'
                ? { ...summary, unsupported: summary.unsupported + 1 }
                : { ...summary, pending: summary.pending + 1 };
      }
      return summary;
    });

  // ---- the live context -------------------------------------------------

  return { requestStop, stopOwnedOperations };
}

/**
 * Whether a failed stop attempt left liveness unknown rather than established.
 *
 * Matched on the owner's own structured codes rather than on message text, so an unrelated fault is
 * never quietly downgraded to "we will try again later".
 */
function isUnobservableStop(error: Error): boolean {
  const tag = (error as { readonly _tag?: unknown })._tag;
  if (tag === 'PtyTerminationInProgressError') return true;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'backend_unavailable';
}
