import { createHash, randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type {
  WorkflowCapability,
  WorkflowOperationStage,
  WorkflowOperationState,
  WorkflowStopState,
} from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../persistence/database.service.js';
import { DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import { workflowOperations, workflowRuns } from '../../persistence/schema.js';
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
import { isTerminalRunStatus, type RecordedValue } from './runs.repository.js';
import { slotColumns } from './slots.js';
import {
  silentWriteWake,
  wakingDatabase,
  WorkflowWriteWake,
  type WorkflowWriteWakeService,
} from './write-wake.js';

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

/**
 * States a *receipt* may still advance out of.
 *
 * `abandoned` is included and the other settled states are not, because `abandoned` is the one
 * settlement that means the effect provably never left. Re-entering that call position dispatches
 * again **under the same operation identity** — §10.3 reaches that transition from `intended` and
 * from `abandoned` deliberately — and a receipt guard that refused it would silently leave the row
 * at its pre-boundary stage while the new dispatch really happened, which is the one disagreement
 * between the record and the world this design cannot tolerate. A `completed`, `failed`,
 * `interrupted` or `uncertain` operation stays closed: those describe effects that did leave.
 */
const receiptAdvanceableStates = [
  'intended',
  'dispatched',
  'abandoned',
] as const satisfies readonly WorkflowOperationState[];

export interface RecordOperationIntentInput {
  readonly runId: number;
  readonly frameId: number;
  readonly executionId: number;
  readonly originAttemptId: number;
  readonly capability: WorkflowCapability;
  readonly callIndex: number;
  /**
   * Recorded in full and inspectable: the author's normalized request together with whatever
   * dispatch configuration was resolved for this operation.
   */
  readonly request: RecordedValue;
  /**
   * The subset the fingerprint is taken over — the author's intent, and nothing the runtime chose
   * on their behalf.
   *
   * These are two values because they answer different questions. A resumed operation must keep
   * dispatching with the *effective* configuration it was created under, so that value has to be
   * durable; but it must not participate in identity, or changing a runtime default would retire
   * every in-flight operation that omitted the field and report it as an incompatible recovery
   * request naming nothing the author did.
   */
  readonly fingerprintOf: RecordedValue;
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
  /**
   * The headless operation that owns a PTY process, if any.
   *
   * Durable, because the in-memory tracker only knows what *this* incarnation launched. A process
   * that outlived the runtime capturing it is precisely the case where the tracker is empty and the
   * question still has an answer. Scoped to `run_headless_agent`: an interactive session's process
   * id is also recorded on prompt operations, and a session dying is turn evidence for the wait
   * resolver rather than a late result for the prompt.
   */
  readonly findByPtyProcessId: (
    ptyProcessId: number,
  ) => Effect.Effect<WorkflowOperationRecord | null, DatabaseError>;
  readonly listByCaptureOwner: (
    captureOwner: string,
  ) => Effect.Effect<readonly WorkflowOperationRecord[], DatabaseError>;
  readonly listPendingStops: () => Effect.Effect<readonly WorkflowOperationRecord[], DatabaseError>;
  /**
   * The operation a run must name while it holds unresolved uncertainty, or null if it holds none.
   *
   * An uncertain operation is genuinely settled — it can never move again — so it has no place in
   * `listUnsettled`; what it still carries is an obligation on its *run*, and settling and blocking
   * are separate transactions, so a crash can leave the second undone.
   *
   * The obligation is defined at the level it lives at. `blocked_operation_id` is singular and
   * belongs to the run, so a run holding uncertainty in more than one execution has to resolve to
   * *one* answer, always the same one, or two repairs will displace each other on every restart.
   * Lowest id is that answer: ids are allocated in creation order, so it is the earliest recorded
   * uncertainty run-wide, and within a single execution it is the lowest call index — which keeps
   * an earlier call position that only later turns out uncertain able to take the block from a
   * later one.
   */
  readonly findBlockingObligation: (
    runId: number,
  ) => Effect.Effect<WorkflowOperationRecord | null, DatabaseError>;
  /**
   * Every run whose blocking obligation is not already discharged — one row per run.
   *
   * Filtering here rather than after the read is what keeps startup work proportional to outstanding
   * repairs instead of to retained history, which is kept indefinitely.
   */
  readonly listBlockingObligations: () => Effect.Effect<
    readonly WorkflowOperationRecord[],
    DatabaseError
  >;
}

export const WorkflowOperationsRepository = Context.GenericTag<WorkflowOperationsRepositoryService>(
  'isagi/WorkflowOperationsRepository',
);

export const WorkflowOperationsRepositoryLive = Layer.effect(
  WorkflowOperationsRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const payloads = yield* WorkflowPayloadStore;
    const wake = yield* WorkflowWriteWake;
    return makeWorkflowOperationsRepository(database, payloads, wake);
  }),
);

export function makeWorkflowOperationsRepository(
  runtimeDatabase: Pick<
    import('../../persistence/index.js').RuntimeDatabaseService,
    'use' | 'transaction'
  >,
  payloads: WorkflowPayloadStoreService,
  /** Told that a write finished, never what it wrote. Defaults to nobody listening. */
  wake: WorkflowWriteWakeService = silentWriteWake,
): WorkflowOperationsRepositoryService {
  const database = wakingDatabase(runtimeDatabase, wake);
  const find = (db: RuntimeDrizzleDatabase, operationId: number) =>
    db.select().from(workflowOperations).where(eq(workflowOperations.id, operationId)).get();

  return {
    recordIntent: (input) =>
      Effect.gen(function* () {
        // Canonicalized before hashing, so a callback that builds an equivalent object in a
        // different key order still matches its recorded call.
        const requestJson = yield* Effect.try({
          try: () => canonicalJson(input.fingerprintOf.value),
          catch: (cause) => cause,
        }).pipe(
          Effect.catchAll((cause) =>
            Effect.die(
              new Error(`Operation request identity is not serializable: ${String(cause)}`, {
                cause,
              }),
            ),
          ),
        );
        const request = yield* payloads.publish(input.request.value);
        return yield* database.transaction('workflow_record_operation_intent', (db) => {
          const now = new Date().toISOString();
          // Cancel revokes permission to cross a *new* external boundary, and this is the last
          // durable moment before one is crossed. Checking here rather than in the caller makes the
          // fence atomic with the write it guards: Cancel and intent creation serialize through the
          // same transaction, so a callback cannot read "not cancelled", lose the race, and still
          // record an intent. What remains — intent recorded, then Cancel, then the boundary crossed
          // — is the irreducible window the design names, and `stopOwnedOperations` is what answers
          // for it. Reuse of an already-settled receipt never reaches this transaction, so accounting
          // for recorded work still succeeds after Cancel.
          const run = db
            .select({ status: workflowRuns.status, cancelRequested: workflowRuns.cancelRequested })
            .from(workflowRuns)
            .where(eq(workflowRuns.id, input.runId))
            .get();
          if (!run) return rejected<WorkflowOperationRecord>({ kind: 'run_not_found' });
          if (run.cancelRequested || isTerminalRunStatus(run.status)) {
            return rejected<WorkflowOperationRecord>({
              kind: 'run_terminal',
              status: run.status,
            });
          }

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
          if (!(receiptAdvanceableStates as readonly string[]).includes(row.state)) {
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
              // Redispatching an abandoned position reopens it: leaving `settled_at` set would make
              // the row read as settled and dispatched at once, and the settlement it names is no
              // longer the operation's outcome.
              ...(row.state === 'abandoned'
                ? { settledAt: null, resultInline: null, resultRef: null }
                : {}),
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
          // Immutable once written, and idempotent for an identical repeat. Payload refs are
          // content-addressed and the inline side is canonical JSON, so comparing the slot *is*
          // comparing the value — no second read and no resolution inside the transaction.
          if (row.lateEvidenceInline !== null || row.lateEvidenceRef !== null) {
            const identical =
              row.lateEvidenceInline === columns.inline && row.lateEvidenceRef === columns.ref;
            return identical
              ? // A duplicate report of the same observation is not news. It allocates no revision,
                // because a client walking history must not be handed the same fact twice.
                committed(operationRecord(row), [])
              : rejected<WorkflowOperationRecord>({ kind: 'late_evidence_conflict' });
          }
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

    findByPtyProcessId: (ptyProcessId) =>
      database.use('workflow_find_operation_by_pty_process', (db) => {
        const row = db
          .select()
          .from(workflowOperations)
          .where(
            and(
              eq(workflowOperations.ptyProcessId, ptyProcessId),
              eq(workflowOperations.capability, 'run_headless_agent'),
            ),
          )
          .get();
        return row ? operationRecord(row) : null;
      }),

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

    findBlockingObligation: (runId) =>
      database.use('workflow_find_run_blocking_obligation', (db) => {
        const row = db
          .select()
          .from(workflowOperations)
          .where(
            and(eq(workflowOperations.runId, runId), eq(workflowOperations.state, 'uncertain')),
          )
          .orderBy(asc(workflowOperations.id))
          .get();
        return row ? operationRecord(row) : null;
      }),

    listBlockingObligations: () =>
      database.use('workflow_list_run_blocking_obligations', (db) =>
        db
          .select({ operation: workflowOperations })
          .from(workflowOperations)
          .innerJoin(workflowRuns, eq(workflowRuns.id, workflowOperations.runId))
          .where(
            and(
              eq(workflowOperations.state, 'uncertain'),
              // One row per run: the earliest recorded uncertainty, which is exactly what
              // `findBlockingObligation` resolves to. Comparing every uncertain row against the
              // run's single blocking id would return the others forever, and reconciling them
              // would let each overwrite the block the previous one just wrote.
              sql`${workflowOperations.id} = (
                SELECT MIN(peer.id) FROM ${workflowOperations} AS peer
                 WHERE peer.run_id = ${workflowOperations.runId}
                   AND peer.state = 'uncertain'
              )`,
              or(
                isNull(workflowRuns.blockedOperationId),
                ne(workflowRuns.blockedOperationId, workflowOperations.id),
              ),
            ),
          )
          .orderBy(asc(workflowOperations.id))
          .all()
          .map((row) => operationRecord(row.operation)),
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
