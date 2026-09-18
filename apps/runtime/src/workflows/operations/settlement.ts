import type { HeadlessOperationResult } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import type { InternalRuntimeEventBusService } from '../../runtime-events/internal-event-bus.js';
import type {
  OperationSettlementProvenance,
  WorkflowOperationsRepositoryService,
} from '../persistence/operations.repository.js';
import type { PayloadSlot, WorkflowPayloadStoreService } from '../persistence/payload-store.js';
import type { WorkflowOperationRecord } from '../persistence/records.js';
import { readRequestEnvelope, type OperationRequestEnvelope } from './correlation.js';
import { OperationRejection } from './errors.js';
import { readHeadlessReceipt } from './receipts.js';

/**
 * Writing an operation's outcome down, and reading back what it recorded.
 *
 * Settling is separated from the capture registry deliberately: reconciliation, a live launch
 * failure and a process terminal all settle, and only one of them has a tracker entry to release.
 * Folding the release in here would have made every caller carry a concern that belongs to one.
 */
export interface OperationSettlement {
  readonly resolveSlot: (slot: PayloadSlot | null) => Effect.Effect<unknown, never>;
  readonly receipt: (record: WorkflowOperationRecord) => Effect.Effect<unknown, never>;
  readonly headlessReceiptOf: (
    record: WorkflowOperationRecord,
  ) => Effect.Effect<ReturnType<typeof readHeadlessReceipt>, never>;
  readonly envelopeOf: (
    record: WorkflowOperationRecord,
  ) => Effect.Effect<OperationRequestEnvelope | null, never>;
  readonly advanceStage: (
    input: Parameters<WorkflowOperationsRepositoryService['recordReceipt']>[0],
  ) => Effect.Effect<WorkflowOperationRecord, OperationRejection>;
  readonly settle: (input: {
    readonly record: WorkflowOperationRecord;
    readonly state: 'completed' | 'failed' | 'interrupted' | 'uncertain' | 'abandoned';
    readonly result?: unknown;
    readonly uncertaintyDetail?: string | undefined;
    readonly stage?: WorkflowOperationRecord['stage'] | undefined;
    /** What the provider reported about work that has now finished. Unknown until settlement. */
    readonly provenance?: OperationSettlementProvenance | undefined;
  }) => Effect.Effect<WorkflowOperationRecord | null, never>;
  readonly retainLateEvidence: (input: {
    readonly record: WorkflowOperationRecord;
    readonly result: HeadlessOperationResult;
  }) => Effect.Effect<void, never>;
}

export function makeOperationSettlement(dependencies: {
  readonly operations: WorkflowOperationsRepositoryService;
  readonly payloads: WorkflowPayloadStoreService;
  readonly eventBus: InternalRuntimeEventBusService;
}): OperationSettlement {
  const { operations, payloads, eventBus } = dependencies;

  const die = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, never> =>
    effect.pipe(Effect.orDie);

  const publishSettled = (record: WorkflowOperationRecord) =>
    eventBus
      .publish({
        type: 'workflow_operation_settled',
        runId: record.runId,
        operationId: record.id,
        operationKey: record.operationKey,
      })
      .pipe(Effect.ignore);

  const resolveSlot = (slot: PayloadSlot | null): Effect.Effect<unknown, never> =>
    slot === null
      ? Effect.succeed(null)
      : payloads.resolve(slot).pipe(Effect.orElseSucceed(() => null));

  /**
   * Advance a stage, and fail loudly if the write did not apply.
   *
   * Every stage marker is a precondition for the step after it. Discarding a rejection here would
   * let the code proceed believing a boundary is recorded when the row still says otherwise — and
   * that disagreement is exactly what a later recovery reads to decide whether to dispatch again.
   * A rejection is surfaced as an ordinary capability failure, so the segment is retryable.
   */

  const receipt = (record: WorkflowOperationRecord) => resolveSlot(record.receipt);

  const headlessReceiptOf = (record: WorkflowOperationRecord) =>
    Effect.map(receipt(record), (value) => readHeadlessReceipt(value));

  const envelopeOf = (
    record: WorkflowOperationRecord,
  ): Effect.Effect<OperationRequestEnvelope | null, never> =>
    Effect.map(resolveSlot(record.request), (value) => readRequestEnvelope(value));

  // ---- stop protocol ----------------------------------------------------

  /**
   * Ask for a process to stop, and record how completely that was established.
   *
   * A request is never proof. An operation settling `failed` says the managed invocation reached an
   * outcome; it never says the process behind it is gone, and the two facts are recorded in
   * different columns precisely so a summary cannot collapse them.
   */

  const advanceStage = (
    input: Parameters<WorkflowOperationsRepositoryService['recordReceipt']>[0],
  ) =>
    Effect.gen(function* () {
      const written = yield* die(operations.recordReceipt(input));
      if (!written.ok) {
        return yield* Effect.fail(
          new OperationRejection({
            code: 'workflow_operation_failed',
            message: `Operation ${input.operationId} could not record stage "${input.stage}": ${written.rejection.kind}.`,
            operationId: input.operationId,
            detail: { rejection: written.rejection },
          }),
        );
      }
      return written.value;
    });

  const settle = (input: {
    readonly record: WorkflowOperationRecord;
    readonly state: 'completed' | 'failed' | 'interrupted' | 'uncertain' | 'abandoned';
    readonly result?: unknown;
    readonly uncertaintyDetail?: string | undefined;
    readonly stage?: WorkflowOperationRecord['stage'] | undefined;
    readonly provenance?: OperationSettlementProvenance | undefined;
  }) =>
    Effect.gen(function* () {
      const written = yield* die(
        operations.settle({
          operationId: input.record.id,
          state: input.state,
          ...(input.result === undefined ? {} : { result: { value: input.result } }),
          ...(input.uncertaintyDetail === undefined
            ? {}
            : { uncertaintyDetail: input.uncertaintyDetail }),
          ...(input.stage === undefined || input.stage === null ? {} : { stage: input.stage }),
          ...(input.provenance ? { provenance: input.provenance } : {}),
        }),
      );
      if (!written.ok) {
        // Already settled by another path. The evidence that reached us second is retained rather
        // than discarded, but it never rewrites an outcome.
        yield* die(
          operations.recordLateEvidence({
            operationId: input.record.id,
            evidence: {
              value: {
                reason: 'settlement_conflict',
                attemptedState: input.state,
                ...(input.result === undefined ? {} : { result: input.result }),
              },
            },
          }),
        ).pipe(Effect.ignore);
        return yield* die(operations.findById(input.record.id));
      }
      yield* publishSettled(written.value);
      return written.value;
    });

  /**
   * Resolve a stored slot, whichever side it landed on.
   *
   * An unreadable payload yields `null` rather than failing: recovery must stay able to classify an
   * operation from its own columns, and a corrupt receipt is a reason to be careful, not a reason
   * to lose the ability to say anything about an effect that may be running.
   */

  const retainLateEvidence = (input: {
    readonly record: WorkflowOperationRecord;
    readonly result: HeadlessOperationResult;
  }) =>
    Effect.gen(function* () {
      // A settlement that already describes a terminal we observed learns nothing from seeing it
      // again; only an outcome nobody watched — interrupted, uncertain, abandoned — gains anything.
      if (input.record.state === 'completed' || input.record.state === 'failed') return;
      const written = yield* die(
        operations.recordLateEvidence({
          operationId: input.record.id,
          evidence: { value: { reason: 'late_process_terminal', result: input.result } },
        }),
      );
      if (!written.ok && written.rejection.kind === 'late_evidence_conflict') {
        // The first observation stands. Two incompatible reports about one process is itself worth
        // knowing, so it is said out loud rather than silently dropped.
        console.warn('[runtime] Conflicting late evidence for a settled workflow operation', {
          operationKey: input.record.operationKey,
          state: input.record.state,
        });
      }
    });

  return {
    resolveSlot,
    receipt,
    headlessReceiptOf,
    envelopeOf,
    advanceStage,
    settle,
    retainLateEvidence,
  };
}
