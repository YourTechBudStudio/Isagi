import { createHash, randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type {
  WorkflowCapability,
  WorkflowOperationStage,
  WorkflowOperationState,
  WorkflowStopState,
} from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../persistence/database.service.js';
import { DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import { workflowOperations } from '../../persistence/schema.js';
import { canonicalJson } from '../state/serializable.js';
import { appendTransitions } from './history.repository.js';
import { committed, rejected, type WorkflowWriteResult } from './outcomes.js';
import {
  WorkflowPayloadStore,
  type PayloadPublishError,
  type WorkflowPayloadStoreService,
} from './payload-store.js';
import type {
  WorkflowOperationAttribution,
  WorkflowOperationRecord,
  WorkflowOperationTargetKind,
} from './records.js';
import { operationRecord } from './row-mappers.js';
import type { RecordedValue } from './runs.repository.js';
import { slotColumns } from './slots.js';

/**
 * States from which an operation can still move.
 *
 * Everything else is settled, and the guards below are monotonic against this set: a late or
 * duplicate write is a no-op rather than a conflict, which is what lets the dispatcher, the wait
 * resolver and startup recovery all call the same transaction without coordinating.
 */
const movableStates = [
  'intended',
  'dispatched',
] as const satisfies readonly WorkflowOperationState[];

export interface RecordOperationIntentInput {
  readonly runId: number;
  readonly frameId: number;
  readonly executionId: number;
  readonly originAttemptId: number;
  readonly capability: WorkflowCapability;
  readonly callIndex: number;
  readonly request: RecordedValue;
  readonly artifactHash: string;
  readonly operationKey?: string;
}

export interface RecordOperationReceiptInput {
  readonly operationId: number;
  readonly stage: WorkflowOperationStage;
  readonly state?: WorkflowOperationState | undefined;
  readonly receipt?: RecordedValue | undefined;
  readonly targetKind?: WorkflowOperationTargetKind | undefined;
  readonly targetId?: number | null | undefined;
  readonly ptyProcessId?: number | null | undefined;
  readonly captureOwner?: string | null | undefined;
  readonly submissionWatermark?: string | null | undefined;
  readonly attribution?: WorkflowOperationAttribution | undefined;
  readonly correlatedStartSeq?: number | null | undefined;
  readonly correlatedHarnessSessionId?: string | null | undefined;
}

export interface SettleOperationInput {
  readonly operationId: number;
  readonly state: Exclude<WorkflowOperationState, 'intended' | 'dispatched'>;
  readonly result?: RecordedValue | undefined;
  readonly uncertaintyDetail?: string | null | undefined;
  readonly stage?: WorkflowOperationStage | undefined;
}

export interface RecordStopOutcomeInput {
  readonly operationId: number;
  readonly stopState: WorkflowStopState;
  readonly detail?: string | null | undefined;
}

export interface WorkflowOperationsRepositoryService {
  /**
   * Records a call position before any effect crosses a boundary.
   *
   * `intended` is what makes redispatch under the same identity safe: it says a call position was
   * recorded while nothing provably left, which is a different claim from `dispatched`.
   */
  readonly recordIntent: (
    input: RecordOperationIntentInput,
  ) => Effect.Effect<
    WorkflowWriteResult<WorkflowOperationRecord>,
    DatabaseError | PayloadPublishError
  >;
  /** Advances the stage — always *before* the boundary that stage names is crossed. */
  readonly recordReceipt: (
    input: RecordOperationReceiptInput,
  ) => Effect.Effect<
    WorkflowWriteResult<WorkflowOperationRecord>,
    DatabaseError | PayloadPublishError
  >;
  readonly settle: (
    input: SettleOperationInput,
  ) => Effect.Effect<
    WorkflowWriteResult<WorkflowOperationRecord>,
    DatabaseError | PayloadPublishError
  >;
  readonly recordStopOutcome: (
    input: RecordStopOutcomeInput,
  ) => Effect.Effect<WorkflowWriteResult<WorkflowOperationRecord>, DatabaseError>;
  /** Evidence that arrived after settlement. Retained, never a revival of the operation. */
  readonly recordLateEvidence: (input: {
    readonly operationId: number;
    readonly evidence: RecordedValue;
  }) => Effect.Effect<
    WorkflowWriteResult<WorkflowOperationRecord>,
    DatabaseError | PayloadPublishError
  >;

  readonly findByKey: (
    operationKey: string,
  ) => Effect.Effect<WorkflowOperationRecord | null, DatabaseError>;
  readonly findById: (
    operationId: number,
  ) => Effect.Effect<WorkflowOperationRecord | null, DatabaseError>;
  /** The recorded call positions of one execution, in call order — the prefix-matching input. */
  readonly listForExecution: (
    executionId: number,
  ) => Effect.Effect<readonly WorkflowOperationRecord[], DatabaseError>;
  readonly listForRun: (
    runId: number,
  ) => Effect.Effect<readonly WorkflowOperationRecord[], DatabaseError>;
  readonly listUnsettled: (input?: {
    readonly runId?: number;
  }) => Effect.Effect<readonly WorkflowOperationRecord[], DatabaseError>;
  readonly listByCaptureOwner: (
    captureOwner: string,
  ) => Effect.Effect<readonly WorkflowOperationRecord[], DatabaseError>;
  readonly listPendingStops: () => Effect.Effect<readonly WorkflowOperationRecord[], DatabaseError>;
}

export const WorkflowOperationsRepository = Context.GenericTag<WorkflowOperationsRepositoryService>(
  'isagi/WorkflowOperationsRepository',
);

export const WorkflowOperationsRepositoryLive = Layer.effect(
  WorkflowOperationsRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const payloads = yield* WorkflowPayloadStore;
    return makeWorkflowOperationsRepository(database, payloads);
  }),
);

export function makeWorkflowOperationsRepository(
  database: Pick<
    import('../../persistence/index.js').RuntimeDatabaseService,
    'use' | 'transaction'
  >,
  payloads: WorkflowPayloadStoreService,
): WorkflowOperationsRepositoryService {
  const find = (db: RuntimeDrizzleDatabase, operationId: number) =>
    db.select().from(workflowOperations).where(eq(workflowOperations.id, operationId)).get();

  return {
    recordIntent: (input) =>
      Effect.gen(function* () {
        // Fingerprinted from the same canonical bytes the request is stored as, so a callback that
        // builds an equivalent object in a different key order still matches its recorded call.
        const requestJson = yield* Effect.try({
          try: () => canonicalJson(input.request.value),
          catch: (cause) => cause,
        }).pipe(
          Effect.catchAll((cause) =>
            Effect.die(
              new Error(`Operation request is not serializable: ${String(cause)}`, { cause }),
            ),
          ),
        );
        const request = yield* payloads.publish(input.request.value);
        return yield* database.transaction('workflow_record_operation_intent', (db) => {
          const now = new Date().toISOString();
          const existing = db
            .select()
            .from(workflowOperations)
            .where(
              and(
                eq(workflowOperations.executionId, input.executionId),
                eq(workflowOperations.callIndex, input.callIndex),
              ),
            )
            .get();
          const requestFingerprint = sha256Hex(requestJson);

          // The call position is the identity, and re-entering a callback adopts the recorded intent
          // rather than creating a second one — but only when it is genuinely the *same* call. The
          // recorded request is compared before adopting: a position re-entered with a different
          // request is a different intended effect, and returning the earlier operation would hand
          // back a receipt for something this caller never asked for. For a keyed creation that is
          // worse still, because the caller would also adopt a resource built to the earlier
          // request. Capability is compared for the same reason; the artifact hash is not, because
          // a Retry under an edited pin legitimately re-enters the same call unchanged.
          if (existing) {
            if (
              existing.requestFingerprint !== requestFingerprint ||
              existing.capability !== input.capability
            ) {
              return rejected<WorkflowOperationRecord>({
                kind: 'operation_request_changed',
                recordedFingerprint: existing.requestFingerprint,
                requestedFingerprint: requestFingerprint,
              });
            }
            return committed(operationRecord(existing), []);
          }

          const columns = slotColumns(request);
          const row = db
            .insert(workflowOperations)
            .values({
              operationKey: input.operationKey ?? `wop_${randomUUID()}`,
              runId: input.runId,
              frameId: input.frameId,
              executionId: input.executionId,
              originAttemptId: input.originAttemptId,
              capability: input.capability,
              callIndex: input.callIndex,
              requestFingerprint,
              requestInline: columns.inline,
              requestRef: columns.ref,
              artifactHash: input.artifactHash,
              state: 'intended',
              targetKind: 'none',
              attribution: 'not_applicable',
              stopState: 'not_requested',
              createdAt: now,
            })
            .returning()
            .get();
          const transitions = appendTransitions(
            db,
            input.runId,
            [
              {
                kind: 'operation_recorded',
                frameId: input.frameId,
                executionId: input.executionId,
                attemptId: input.originAttemptId,
                operationId: row.id,
                artifactHash: input.artifactHash,
                detail: {
                  inline: JSON.stringify({ capability: input.capability, state: 'intended' }),
                  ref: null,
                },
              },
            ],
            now,
          );
          return committed(operationRecord(row), transitions);
        });
      }),

    recordReceipt: (input) =>
      Effect.gen(function* () {
        const receipt = input.receipt ? yield* payloads.publish(input.receipt.value) : null;
        return yield* database.transaction('workflow_record_operation_receipt', (db) => {
          const now = new Date().toISOString();
          const row = find(db, input.operationId);
          if (!row) return rejected<WorkflowOperationRecord>({ kind: 'run_not_found' });
          if (!(movableStates as readonly string[]).includes(row.state)) {
            return rejected<WorkflowOperationRecord>({
              kind: 'operation_state_conflict',
              state: row.state,
            });
          }
          const columns = slotColumns(receipt);
          const updated = db
            .update(workflowOperations)
            .set({
              stage: input.stage,
              state: input.state ?? 'dispatched',
              ...(receipt ? { receiptInline: columns.inline, receiptRef: columns.ref } : {}),
              ...(input.targetKind === undefined ? {} : { targetKind: input.targetKind }),
              ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
              ...(input.ptyProcessId === undefined ? {} : { ptyProcessId: input.ptyProcessId }),
              ...(input.captureOwner === undefined ? {} : { captureOwner: input.captureOwner }),
              ...(input.submissionWatermark === undefined
                ? {}
                : { submissionWatermark: input.submissionWatermark }),
              ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
              ...(input.correlatedStartSeq === undefined
                ? {}
                : { correlatedStartSeq: input.correlatedStartSeq }),
              ...(input.correlatedHarnessSessionId === undefined
                ? {}
                : { correlatedHarnessSessionId: input.correlatedHarnessSessionId }),
              dispatchedAt: row.dispatchedAt ?? now,
            })
            .where(eq(workflowOperations.id, row.id))
            .returning()
            .get();
          // A stage advance is a durable change, and recovery has to be able to see it: a client
          // that reconnects must learn an operation reached `seed_submitting` even though it has
          // not settled, because that stage is precisely what decides never to resend.
          const transitions = appendTransitions(
            db,
            row.runId,
            [
              {
                kind: 'operation_recorded',
                frameId: row.frameId,
                executionId: row.executionId,
                attemptId: row.originAttemptId,
                operationId: row.id,
                detail: {
                  inline: JSON.stringify({ stage: input.stage, state: updated.state }),
                  ref: null,
                },
              },
            ],
            now,
          );
          return committed(operationRecord(updated), transitions);
        });
      }),

    settle: (input) =>
      Effect.gen(function* () {
        const result = input.result ? yield* payloads.publish(input.result.value) : null;
        return yield* database.transaction('workflow_settle_operation', (db) => {
          const now = new Date().toISOString();
          const row = find(db, input.operationId);
          if (!row) return rejected<WorkflowOperationRecord>({ kind: 'run_not_found' });
          if (!(movableStates as readonly string[]).includes(row.state)) {
            // Already settled. Duplicate settlement is harmless and deliberately a no-op rather
            // than an error: the same evidence can reach this from several directions.
            return rejected<WorkflowOperationRecord>({
              kind: 'operation_state_conflict',
              state: row.state,
            });
          }
          const columns = slotColumns(result);
          const updated = db
            .update(workflowOperations)
            .set({
              state: input.state,
              ...(input.stage === undefined ? {} : { stage: input.stage }),
              ...(result ? { resultInline: columns.inline, resultRef: columns.ref } : {}),
              ...(input.uncertaintyDetail === undefined
                ? {}
                : { uncertaintyDetail: input.uncertaintyDetail }),
              settledAt: now,
            })
            .where(eq(workflowOperations.id, row.id))
            .returning()
            .get();
          const transitions = appendTransitions(
            db,
            row.runId,
            [
              {
                kind: 'operation_settled',
                frameId: row.frameId,
                executionId: row.executionId,
                attemptId: row.originAttemptId,
                operationId: row.id,
                detail: result,
              },
            ],
            now,
          );
          return committed(operationRecord(updated), transitions);
        });
      }),

    recordStopOutcome: (input) =>
      database.transaction('workflow_record_stop_outcome', (db) => {
        const now = new Date().toISOString();
        const row = find(db, input.operationId);
        if (!row) return rejected<WorkflowOperationRecord>({ kind: 'run_not_found' });
        // Monotonic on the stop's own state: an outcome is recorded once, and a later report cannot
        // downgrade a confirmed stop back to pending. A stop request is never proof of stopping, so
        // neither is a settled operation proof that its process is gone.
        if (row.stopState !== 'not_requested' && row.stopState !== 'pending') {
          return rejected<WorkflowOperationRecord>({
            kind: 'operation_state_conflict',
            state: row.state,
          });
        }
        const updated = db
          .update(workflowOperations)
          .set({
            stopState: input.stopState,
            stopDetail: input.detail ?? null,
            stopRequestedAt: row.stopRequestedAt ?? now,
            stopSettledAt: input.stopState === 'pending' ? null : now,
          })
          .where(eq(workflowOperations.id, row.id))
          .returning()
          .get();
        const transitions = appendTransitions(
          db,
          row.runId,
          [
            {
              kind: 'stop_recorded',
              frameId: row.frameId,
              executionId: row.executionId,
              operationId: row.id,
              detail: {
                inline: JSON.stringify({
                  stopState: input.stopState,
                  detail: input.detail ?? null,
                }),
                ref: null,
              },
            },
          ],
          now,
        );
        return committed(operationRecord(updated), transitions);
      }),

    recordLateEvidence: (input) =>
      Effect.gen(function* () {
        const evidence = yield* payloads.publish(input.evidence.value);
        return yield* database.transaction('workflow_record_late_evidence', (db) => {
          const now = new Date().toISOString();
          const row = find(db, input.operationId);
          if (!row) return rejected<WorkflowOperationRecord>({ kind: 'run_not_found' });
          const columns = slotColumns(evidence);
          const updated = db
            .update(workflowOperations)
            .set({ lateEvidenceInline: columns.inline, lateEvidenceRef: columns.ref })
            .where(eq(workflowOperations.id, row.id))
            .returning()
            .get();
          const transitions = appendTransitions(
            db,
            row.runId,
            [
              {
                kind: 'operation_recorded',
                frameId: row.frameId,
                executionId: row.executionId,
                operationId: row.id,
                detail: evidence,
              },
            ],
            now,
          );
          return committed(operationRecord(updated), transitions);
        });
      }),

    findByKey: (operationKey) =>
      database.use('workflow_find_operation_by_key', (db) => {
        const row = db
          .select()
          .from(workflowOperations)
          .where(eq(workflowOperations.operationKey, operationKey))
          .get();
        return row ? operationRecord(row) : null;
      }),

    findById: (operationId) =>
      database.use('workflow_find_operation', (db) => {
        const row = find(db, operationId);
        return row ? operationRecord(row) : null;
      }),

    listForExecution: (executionId) =>
      database.use('workflow_list_execution_operations', (db) =>
        db
          .select()
          .from(workflowOperations)
          .where(eq(workflowOperations.executionId, executionId))
          .orderBy(asc(workflowOperations.callIndex))
          .all()
          .map(operationRecord),
      ),

    listForRun: (runId) =>
      database.use('workflow_list_run_operations', (db) =>
        db
          .select()
          .from(workflowOperations)
          .where(eq(workflowOperations.runId, runId))
          .orderBy(asc(workflowOperations.id))
          .all()
          .map(operationRecord),
      ),

    listUnsettled: (input) =>
      database.use('workflow_list_unsettled_operations', (db) =>
        db
          .select()
          .from(workflowOperations)
          .where(
            input?.runId === undefined
              ? inArray(workflowOperations.state, [...movableStates])
              : and(
                  inArray(workflowOperations.state, [...movableStates]),
                  eq(workflowOperations.runId, input.runId),
                ),
          )
          .orderBy(asc(workflowOperations.id))
          .all()
          .map(operationRecord),
      ),

    listByCaptureOwner: (captureOwner) =>
      database.use('workflow_list_operations_by_capture_owner', (db) =>
        db
          .select()
          .from(workflowOperations)
          .where(
            and(
              eq(workflowOperations.captureOwner, captureOwner),
              inArray(workflowOperations.state, [...movableStates]),
            ),
          )
          .orderBy(asc(workflowOperations.id))
          .all()
          .map(operationRecord),
      ),

    listPendingStops: () =>
      database.use('workflow_list_pending_stops', (db) =>
        db
          .select()
          .from(workflowOperations)
          .where(
            and(
              eq(workflowOperations.stopState, 'pending'),
              isNotNull(workflowOperations.stopRequestedAt),
            ),
          )
          .orderBy(asc(workflowOperations.id))
          .all()
          .map(operationRecord),
      ),
  } satisfies WorkflowOperationsRepositoryService;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
