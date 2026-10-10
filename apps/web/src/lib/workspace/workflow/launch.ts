import type { WorkflowLaunchDeps } from '../../palette/workflow-failure.js';
import type { AppRun } from '../../state/registry.js';
import { retryWorkflow, startWorkflow } from '../runtime-data.js';
import { awaitPreparation } from './preparation.js';

/**
 * The three runtime calls the palette's workflow adapter needs, and nothing else: the palette hands
 * over the transport and the adapter owns every sentence formed from it. They stay separate because
 * which one failed changes what is true about the run.
 *
 * - start blocks until preparing the environment has committed or failed, and answers only which
 *   run this is;
 * - retry is for a run the caller only knows by id (after a launch whose preparation failed);
 * - awaitPrepared reads the run's own account of itself, so a rejected launch is never confused
 *   with a run that merely could not be read back.
 */
export function makeWorkflowLaunchDeps(app: AppRun): WorkflowLaunchDeps {
  return {
    start: (input) => app(startWorkflow(input)),
    retry: (runId) => app(retryWorkflow(runId)),
    awaitPrepared: (runId) => app(awaitPreparation(runId)),
  };
}
