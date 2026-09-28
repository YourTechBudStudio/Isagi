import { listOperations, settleOperation } from '../store/operations.js';
import { now, toJson } from '../store/rows.js';
import { activeRunStatuses, listRunsWithStatus, updateRun } from '../store/runs.js';
import { findLeafExecution } from '../store/tree.js';
import type { HeadlessOperationRecord } from '../waits/check.js';
import { applyFailure } from './chain.js';
import type { EngineRuntime } from './runtime.js';

/**
 * What an app restart does to runs that were active, applied before anything is driven.
 *
 * - An operation that was running is `interrupted`: its process, and the in-memory tracking of it,
 *   are gone. A headless one is delivered to its edge as `interrupted` with `runtime_restarted`.
 * - A run still preparing fails: preparation is repeated by Retry.
 * - A run whose node function was mid-run fails with that execution `interrupted`: the person
 *   presses Retry, which runs the function again.
 * - Every other active run is paused, including one whose result was saved but not yet routed. Its
 *   waits are re-checked on Resume.
 */
export function recoverAtStartup(rt: EngineRuntime) {
  return rt.commit('workflow_recover_at_startup', (db, emit) => {
    for (const operation of listOperations(db, { status: 'running' })) {
      const interruption = {
        reason: 'runtime_restarted' as const,
        launchedAt: operation.startedAt,
      };
      settleOperation(db, emit, operation.id, 'interrupted', {
        resultJson: toJson(
          operation.kind === 'run_headless'
            ? ({
                exitCode: null,
                error: 'runtime_restarted',
                interruption,
              } satisfies HeadlessOperationRecord)
            : { error: 'runtime_restarted' },
        ),
      });
    }

    for (const run of listRunsWithStatus(db, activeRunStatuses)) {
      if (run.status === 'paused') continue;
      if (run.status === 'preparing') {
        const message = 'Preparation was interrupted by an app restart.';
        updateRun(db, run.id, {
          status: 'failed',
          errorJson: toJson({ stage: 'environment', message }),
          endedAt: now(),
        });
        emit({ runId: run.id, category: 'environment', kind: 'preparation_failed', message });
        emit({
          runId: run.id,
          category: 'run',
          kind: 'run_failed',
          message,
          data: { stage: 'environment' },
        });
        continue;
      }
      const leaf = findLeafExecution(db, run.id);
      if (
        leaf &&
        leaf.nodeKind === 'operation' &&
        leaf.status === 'running' &&
        leaf.resultJson === null
      ) {
        applyFailure(
          db,
          emit,
          run,
          leaf,
          {
            stage: 'node_function',
            message: 'Interrupted by an app restart.',
            nodeId: leaf.nodeId,
          },
          { status: 'interrupted' },
        );
        continue;
      }
      updateRun(db, run.id, { status: 'paused' });
      emit({
        runId: run.id,
        category: 'run',
        kind: 'run_paused',
        message: 'Paused by an app restart',
        data: { reason: 'app_restart' },
      });
    }
  });
}
