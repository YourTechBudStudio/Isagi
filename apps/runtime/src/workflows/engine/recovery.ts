import { Effect } from 'effect';

import type { WorkflowOperationServiceShape } from '../operations/operation.service.js';
import type { WorkflowRunsRepositoryService } from '../persistence/runs.repository.js';
import { rederiveEnvironments, type EnvironmentWatchDeps } from '../waits/environment.js';
import type { WaitResolver } from '../waits/resolver.js';

/**
 * Bringing a fresh process back to a state it can dispatch from — strictly before any dispatch.
 *
 * The order is load-bearing, and each step exists because the one after it would otherwise make a
 * claim it cannot support:
 *
 * 1. **Park.** Every unfinished run is paused, its ownership cleared, its interrupted attempt closed
 *    with an *unknown* end rather than a fabricated one. Nothing committed is ever re-executed; only
 *    an uncommitted segment can be re-entered, and only after step 2. The one exception is a run
 *    interrupted mid-*preparation*, which is failed instead of parked: Retry is its single re-entry
 *    path, so a pause band would only offer a Resume that nothing could act on.
 * 2. **Settle operations.** What crossed an external boundary is established from durable evidence
 *    while graph dispatch is still gated. A lost headless capture becomes one interruption; an
 *    ambiguous submission becomes uncertainty and blocks its run.
 * 3. **Re-evaluate waits.** A turn that ended while the process was down is *discovered* here, never
 *    re-sent — which is the whole reason the submission watermark is durable before the write it
 *    describes.
 * 4. **Re-derive placement**, for every non-terminal run, by destination identity. This is what
 *    finds a run whose attachment cascaded away while nobody was listening.
 *
 * Every parked run then waits for an explicit Resume. Cancellation cleanup needs no Resume and is
 * carried by step 2, because a pending stop is an obligation of its own that outlives settlement.
 */
export interface RecoveryDeps extends EnvironmentWatchDeps {
  readonly runs: WorkflowRunsRepositoryService;
  readonly operations: Pick<WorkflowOperationServiceShape, 'reconcileAtStartup'>;
  readonly waits: WaitResolver;
}

export interface RecoverySummary {
  readonly parked: number;
  readonly reconciledExecutions: number;
  readonly deliveredWaits: number;
  readonly environmentsLost: number;
  /**
   * Runs whose environment preparation was interrupted, and which this pass failed.
   *
   * Failed rather than parked, and deliberately so: Retry is the single re-entry path for a
   * half-prepared environment, and a pause band would offer a Resume that nothing could act on.
   * `parkUnfinishedRuns` decides this — one pass over one query handles both kinds of row — and
   * startup only reports it.
   */
  readonly preparationsFailed: number;
}

export function recoverAtStartup(deps: RecoveryDeps): Effect.Effect<RecoverySummary> {
  return Effect.gen(function* () {
    const { parked, preparationsFailed } = yield* deps.runs.parkUnfinishedRuns({});
    const reconciled = yield* deps.operations.reconcileAtStartup;
    const delivered = yield* deps.waits.reconcileWaits();
    const environmentsLost = yield* rederiveEnvironments(deps);
    return {
      parked: parked.length,
      reconciledExecutions: reconciled.length,
      deliveredWaits: delivered,
      environmentsLost,
      preparationsFailed: preparationsFailed.length,
    };
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        // Recovery is total on purpose: a runtime that refuses to finish booting because one run's
        // recovery failed would take every other run down with it. The failure is loud, and the
        // parked runs stay parked, which is the safe resting state.
        console.error('[runtime] Workflow startup recovery failed', cause);
        return {
          parked: 0,
          reconciledExecutions: 0,
          deliveredWaits: 0,
          environmentsLost: 0,
          preparationsFailed: 0,
        };
      }),
    ),
  );
}
