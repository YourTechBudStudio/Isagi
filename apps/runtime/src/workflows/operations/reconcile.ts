import type {
  HeadlessInterruption,
  HeadlessOperationResult,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import type { WorkflowOperationsRepositoryService } from '../persistence/operations.repository.js';
import type { WorkflowOperationRecord } from '../persistence/records.js';
import type { WorkflowRunsRepositoryService } from '../persistence/runs.repository.js';
import { selectTurnAssociation, type WorkflowObservedTurnEdge } from '../waits/conditions.js';
import type { OperationAdapters } from './adapters/types.js';
import { classifyHeadlessEvidence, classifySubmissionEvidence } from './classify.js';
import { isSettled } from './correlation.js';
import { readSpawnSessionReceipt } from './receipts.js';
import type { OperationSettlement } from './settlement.js';
import type { OperationStopPolicy } from './stop.js';

export interface ExecutionReconciliation {
  /** The lowest-indexed operation that could not be settled, if any. */
  readonly uncertainOperationId: number | null;
  readonly settled: readonly number[];
}

/**
 * Settling what can be settled when nobody is holding the call.
 *
 * Every decision here reads durable evidence and nothing else, and every path is total: reconciliation
 * runs before a callback is re-entered and at startup, where there is no caller to hand an error to.
 */
export interface OperationReconciler {
  readonly reconcileExecution: (
    executionId: number,
  ) => Effect.Effect<ExecutionReconciliation, never>;
  /**
   * Settle a submission from the turn its wait observed.
   *
   * The wait resolver watches turns; the operation layer owns every operation write. This is the
   * seam between those two facts, and it exists so a submitted prompt does not rest in `dispatched`
   * for the life of the record — which would leave it permanently in the unsettled set that startup
   * walks, making boot work grow with retained history rather than with outstanding work.
   *
   * Total and idempotent: duplicate settlement is a no-op by the repository's monotonic guard, so a
   * terminal observed twice files nothing twice.
   */
  /**
   * Fix the association between a submission and the native turn it caused, durably and once.
   *
   * Selection is a watermark inference over evidence that keeps arriving, so it has to be frozen the
   * first time it succeeds. Left unfrozen, a second start arriving before the first turn's terminal
   * would re-read as ambiguity and settle a perfectly explainable operation `uncertain` — and a
   * completed one would carry no correlation for inspection to show.
   *
   * Idempotent and total: an operation that already names a correlated start is left alone.
   */
  readonly fixTurnAssociation: (input: {
    readonly operationId: number;
    readonly attribution: 'inferred_by_watermark';
    readonly startSeq: number | null;
    readonly harnessSessionId: string;
  }) => Effect.Effect<void, never>;
  readonly recordTurnObservation: (input: {
    readonly operationId: number;
    readonly observation:
      | {
          readonly kind: 'settled';
          readonly state: 'completed' | 'failed' | 'interrupted';
          readonly result: unknown;
        }
      | { readonly kind: 'uncertain'; readonly detail: string };
  }) => Effect.Effect<void, never>;
  readonly reconcileAtStartup: Effect.Effect<readonly ExecutionReconciliation[], never>;
  /** Exposed because a re-entered PTY-crossing call has to settle its own marker before reusing it. */
  readonly reconcileSubmission: (
    record: WorkflowOperationRecord,
  ) => Effect.Effect<number | null, never>;
}

export function makeOperationReconciler(dependencies: {
  readonly operations: WorkflowOperationsRepositoryService;
  readonly runs: WorkflowRunsRepositoryService;
  readonly adapters: OperationAdapters;
  readonly settlement: OperationSettlement;
  readonly stop: OperationStopPolicy;
  readonly incarnationId: string;
}): OperationReconciler {
  const { operations, runs, adapters, incarnationId } = dependencies;
  const { settle, advanceStage, receipt, headlessReceiptOf } = dependencies.settlement;
  const { requestStop } = dependencies.stop;

  const die = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, never> =>
    effect.pipe(Effect.orDie);

  const reconcileHeadless = (record: WorkflowOperationRecord) =>
    Effect.gen(function* () {
      const parsed = yield* headlessReceiptOf(record);
      const evidence = classifyHeadlessEvidence({ record, receipt: parsed, incarnationId });
      switch (evidence.kind) {
        case 'settled':
        case 'never_dispatched':
          return null;
        case 'owned':
          // Our own incarnation is still capturing. Nothing to settle, and re-arming a tracker we
          // already hold would double the timeout.
          return null;
        case 'abandon':
          yield* settle({
            record,
            state: 'abandoned',
            result: { reason: 'launch_never_crossed_boundary', cause: evidence.cause },
          });
          return null;
        case 'confirmed_failure': {
          const result: HeadlessOperationResult = {
            operationId: record.operationKey,
            status: 'failed',
            error: evidence.cause ?? 'spawn_failed',
            exitCode: null,
          };
          const settled = yield* settle({ record, state: 'failed', result });
          if (settled) yield* requestStop(settled, 'spawn_failed_process_may_be_live');
          return null;
        }
        case 'interrupted': {
          // Any output the lost process left behind is diagnostic material, never an accepted
          // judgment: nobody watched it finish, so it cannot be presented as a completed answer.
          const captured =
            parsed === null
              ? null
              : yield* adapters.headless
                  .capture({
                    ptyProcessId: evidence.ptyProcessId,
                    harness: parsed.harness,
                  })
                  .pipe(Effect.orElseSucceed(() => ({ raw: '', output: '' })));
          // Cleanup is requested *before* the settlement so the outcome delivered to the author's
          // edge reports what the stop actually established. Settling first and patching the
          // column afterwards would hand the edge a permanent `pending` that the operation row
          // then contradicts. The interruption itself is not at risk from this ordering: it is
          // re-derivable from the stage and the ended capture owner, neither of which a stop
          // attempt changes.
          const stopped = yield* requestStop(record, `capture_owner_lost:${evidence.lostOwner}`);
          const stopState = stopped.ok ? stopped.value.stopState : 'pending';
          const stopDetail = stopped.ok ? stopped.value.stopDetail : null;
          const interruption: HeadlessInterruption = {
            reason: 'capture_owner_lost',
            launchedAt: parsed?.launchedAt ?? record.dispatchedAt ?? record.createdAt,
            ...(captured && captured.output.length > 0 ? { partialOutput: captured.output } : {}),
            stop: {
              state: stopState === 'not_requested' ? 'pending' : stopState,
              ...(stopDetail === null ? {} : { detail: stopDetail }),
            },
          };
          const result: HeadlessOperationResult = {
            operationId: record.operationKey,
            status: 'interrupted',
            interruption,
          };
          yield* settle({ record, state: 'interrupted', result });
          return null;
        }
        case 'uncertain': {
          yield* settle({ record, state: 'uncertain', uncertaintyDetail: evidence.detail });
          return record.id;
        }
      }
    });

  /**
   * Settle a prompt that may or may not have crossed the PTY boundary.
   *
   * Reads the durable ledger against the persisted watermark and **never writes**. A bare submit
   * key would often be the right repair — the prompt may be sitting unsubmitted — but after a crash
   * nothing distinguishes that from a prompt that landed and produced no observable start, and
   * guessing costs a duplicate turn in the person's worktree.
   */

  const reconcileSubmission = (record: WorkflowOperationRecord) =>
    Effect.gen(function* () {
      const evidence = classifySubmissionEvidence(record);
      if (evidence.kind !== 'reconcile_from_ledger') return null;
      const agentSessionId = record.targetId;
      const watermark = record.submissionWatermark;
      if (agentSessionId === null || watermark === null) {
        yield* settle({
          record,
          state: 'uncertain',
          uncertaintyDetail: 'submission_marker_incomplete',
        });
        return record.id;
      }
      const edges = yield* adapters.agentSessions
        .turnEdges(agentSessionId)
        .pipe(Effect.orElseSucceed(() => [] as readonly WorkflowObservedTurnEdge[]));
      const association = selectTurnAssociation({ agentSessionId, sentAt: watermark }, edges);
      if (association.kind === 'ambiguous') {
        yield* settle({
          record,
          state: 'uncertain',
          uncertaintyDetail: `ambiguous_turn_attribution:${association.startCount}`,
        });
        return record.id;
      }
      if (association.kind === 'pending') {
        // No start at or after the watermark. The prompt may simply never have landed, and the
        // honest answer is that nobody can tell — not that it failed.
        yield* settle({
          record,
          state: 'uncertain',
          uncertaintyDetail: 'no_turn_observed_after_submission',
        });
        return record.id;
      }
      // A start was found and the association is now fixed for good. The receipt the callback
      // would have returned is reconstructed from the persisted fields alone.
      const confirmedStage =
        record.capability === 'spawn_agent_session' ? 'seed_submitted' : 'submitted';
      const spawnReceipt =
        record.capability === 'spawn_agent_session'
          ? readSpawnSessionReceipt(yield* receipt(record))
          : null;
      // Reconciliation itself must not fail: it runs before a callback is re-entered and at
      // startup, where there is nobody to hand an error to. A rejected confirmation means the row
      // moved under us — another path settled it — so the current record is re-read and believed
      // rather than overwritten with a conclusion drawn from stale evidence.
      const confirmed = yield* advanceStage({
        operationId: record.id,
        stage: confirmedStage,
        state: 'dispatched',
        attribution: association.attribution,
        correlatedStartSeq: association.startSeq,
        correlatedHarnessSessionId: association.harnessSessionId,
        receipt: {
          value:
            spawnReceipt === null
              ? { agentSessionId, sentAt: watermark }
              : { ...spawnReceipt, agentSessionId, sentAt: watermark },
        },
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (confirmed === null) {
        const current = yield* die(operations.findById(record.id));
        return current !== null && current.state === 'uncertain' ? current.id : null;
      }
      return null;
    });

  const reconcileRecord = (record: WorkflowOperationRecord) =>
    record.capability === 'run_headless_agent'
      ? reconcileHeadless(record)
      : record.capability === 'close_pane'
        ? Effect.succeed<number | null>(null)
        : reconcileSubmission(record);

  /**
   * Make sure an uncertain operation is reflected on its run.
   *
   * Settling and blocking are two transactions, so a crash can land between them. Repairing it here
   * — rather than assuming the pair is atomic — is what keeps a run from looking dispatchable while
   * carrying an operation nobody can account for. Dispatch is refused either way, because the
   * prefix rule reads the operation and not the run.
   */

  /**
   * Make sure a run holding unresolved uncertainty says so, and names the same operation every time.
   *
   * It takes a run rather than an operation on purpose. `blocked_operation_id` is singular, so if
   * each caller blocked on whatever *it* found, two executions holding uncertainty would overwrite
   * each other's block on every pass — history growing forever and neither ever settling. The
   * priority therefore lives in one place, below the callers, where none of them can displace it.
   */
  const ensureBlocked = (runId: number) =>
    Effect.gen(function* () {
      const obligation = yield* die(operations.findBlockingObligation(runId));
      if (!obligation) return;
      const run = yield* die(runs.findRun(runId));
      if (!run) return;
      // The run naming this operation *is* the record that the block was applied, whatever the run's
      // status now says. A terminal run keeps the name without becoming blocked — that is the whole
      // point of recording uncertainty without reviving anything — so testing the status instead
      // would call every cancelled run unrepaired and append a fresh `run_blocked` on every restart,
      // forever.
      if (run.blockedOperationId === obligation.id) return;
      yield* die(runs.blockRun({ runId, operationId: obligation.id }));
    });

  const fixTurnAssociation: OperationReconciler['fixTurnAssociation'] = (input) =>
    Effect.gen(function* () {
      const record = yield* die(operations.findById(input.operationId));
      // Already fixed, or past the point where fixing it would mean anything.
      if (!record || record.correlatedHarnessSessionId !== null || isSettled(record.state)) return;
      if (record.stage === null) return;
      yield* advanceStage({
        operationId: record.id,
        stage: record.stage,
        state: record.state,
        attribution: input.attribution,
        correlatedStartSeq: input.startSeq,
        correlatedHarnessSessionId: input.harnessSessionId,
      }).pipe(
        // Total on purpose: the association is an optimisation over evidence that is still on disk.
        // Losing the race to another writer costs a re-selection, not a fact.
        Effect.catchAll(() => Effect.void),
      );
    });

  const recordTurnObservation: OperationReconciler['recordTurnObservation'] = (input) =>
    Effect.gen(function* () {
      const record = yield* die(operations.findById(input.operationId));
      if (!record || isSettled(record.state)) return;
      if (input.observation.kind === 'uncertain') {
        yield* settle({ record, state: 'uncertain', uncertaintyDetail: input.observation.detail });
        yield* ensureBlocked(record.runId);
        return;
      }
      yield* settle({
        record,
        state: input.observation.state,
        result: input.observation.result,
      });
    });

  const reconcileExecution = (executionId: number): Effect.Effect<ExecutionReconciliation, never> =>
    Effect.gen(function* () {
      const records = yield* die(operations.listForExecution(executionId));
      const settledIds: number[] = [];
      let uncertainOperationId: number | null = null;
      for (const record of records) {
        if (isSettled(record.state)) {
          // Includes an operation left `uncertain` by an earlier pass whose block never committed.
          if (record.state === 'uncertain' && uncertainOperationId === null) {
            uncertainOperationId = record.id;
          }
          continue;
        }
        const uncertain = yield* reconcileRecord(record);
        if (uncertain !== null && uncertainOperationId === null) uncertainOperationId = uncertain;
        const after = yield* die(operations.findById(record.id));
        if (after && isSettled(after.state)) settledIds.push(after.id);
      }
      if (uncertainOperationId !== null) {
        const first = records.find((record) => record.id === uncertainOperationId);
        // Reported as this execution's unresolved operation, which is a different question from
        // which one the *run* names while blocked.
        if (first) yield* ensureBlocked(first.runId);
      }
      return { uncertainOperationId, settled: settledIds };
    });

  const reconcileAtStartup: Effect.Effect<readonly ExecutionReconciliation[], never> = Effect.gen(
    function* () {
      const unsettled = yield* die(operations.listUnsettled());
      const executionIds = [...new Set(unsettled.map((record) => record.executionId))];
      const outcomes: ExecutionReconciliation[] = [];
      for (const executionId of executionIds) {
        outcomes.push(yield* reconcileExecution(executionId));
      }

      // Runs whose block never committed. These need no reconciliation — their operations are
      // already settled and can never move again — only the run-level record that they are blocked,
      // so repairing it directly avoids re-walking executions that have nothing left to decide.
      const obligations = yield* die(operations.listBlockingObligations());
      for (const obligation of obligations) {
        yield* ensureBlocked(obligation.runId);
      }

      // A stop is an obligation of its own, and it outlives settlement: an operation can be settled
      // and its process still running. Resuming these needs no graph Resume.
      const pending = yield* die(operations.listPendingStops());
      for (const record of pending) {
        yield* requestStop(record, 'pending_stop_resumed_after_restart');
      }
      return outcomes;
    },
  );

  // ---- stop -------------------------------------------------------------

  return {
    fixTurnAssociation,
    recordTurnObservation,
    reconcileExecution,
    reconcileAtStartup,
    reconcileSubmission,
  };
}
