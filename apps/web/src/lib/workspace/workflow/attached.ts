import type { WorkflowRunSummary } from '@isagi/contracts';

/**
 * The runs attached to a surface, as the workflow bar, the palette and attention read them.
 *
 * Summaries are applied in the order they arrive on the one runtime socket, and the latest write
 * wins. The runtime sends a surface's snapshot and its changes on the same ordered connection, so
 * arrival order is the order they happened in; no revision bookkeeping is needed.
 */
export type AttachedRuns = readonly WorkflowRunSummary[];

/** The snapshot is the runtime's complete answer to "which runs occupy a surface right now". */
export function replaceAttached(summaries: AttachedRuns): AttachedRuns {
  return summaries.filter(isAttached);
}

/** A run that has stopped occupying a surface (dismissed, or its surface deleted) leaves the list. */
export function upsertAttached(current: AttachedRuns, summary: WorkflowRunSummary): AttachedRuns {
  const index = current.findIndex((run) => run.runId === summary.runId);
  if (index === -1) return isAttached(summary) ? [...current, summary] : current;
  if (!isAttached(summary)) return current.filter((run) => run.runId !== summary.runId);
  const next = [...current];
  next[index] = summary;
  return next;
}

export function attachedRunForSurface(
  runs: AttachedRuns | undefined,
  surfaceId: number | null | undefined,
): WorkflowRunSummary | undefined {
  if (!runs || surfaceId === null || surfaceId === undefined) return undefined;
  return runs.find((run) => run.surfaceId === surfaceId);
}

function isAttached(summary: WorkflowRunSummary): boolean {
  return summary.surfaceId !== null;
}
