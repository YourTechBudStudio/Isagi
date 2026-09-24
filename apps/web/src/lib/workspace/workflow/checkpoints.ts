import type { WorkflowRunState } from './model.js';

/**
 * Client-side rules for reading saved checkpoints.
 *
 * A checkpoint is one row per committed visit, and a visit's `checkpoint` summary is non-null
 * exactly when that row exists. Unlike evidence counts, it is not subtree-inclusive: each execution
 * names only the checkpoint it saved itself, so counting across the whole run counts each once.
 */

/**
 * The number the run's checkpoint list refetches on: how many visits say they saved one.
 *
 * Checkpoint rows are immutable and every one belongs to exactly one visit, so the list can only
 * change when this number does.
 */
export function checkpointRefreshSignal(state: WorkflowRunState | null): number {
  if (state === null) return 0;
  let total = 0;
  for (const execution of state.executions.values()) {
    if (execution.checkpoint !== null) total += 1;
  }
  return total;
}
