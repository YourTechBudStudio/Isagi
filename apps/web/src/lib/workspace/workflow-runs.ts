import { create } from 'zustand';

import type { WorkflowRunSummary } from '@isagi/contracts';

interface WorkflowRunStore {
  readonly runsById: Readonly<Record<number, WorkflowRunSummary>>;
  readonly rootRunIdBySurfaceId: Readonly<Record<number, number>>;
  readonly replace: (summaries: readonly WorkflowRunSummary[]) => void;
  readonly upsert: (summary: WorkflowRunSummary) => void;
  readonly clear: (input: {
    readonly runId: number;
    readonly rootRunId: number;
    readonly surfaceId: number | null;
  }) => void;
}

export const useWorkflowRunStore = create<WorkflowRunStore>((set) => ({
  runsById: {},
  rootRunIdBySurfaceId: {},
  replace: (summaries) =>
    set({
      runsById: Object.fromEntries(summaries.map((summary) => [summary.runId, summary])),
      rootRunIdBySurfaceId: Object.fromEntries(
        summaries.flatMap((summary) =>
          summary.parentRunId === null && summary.surfaceId !== null
            ? [[summary.surfaceId, summary.rootRunId] as const]
            : [],
        ),
      ),
    }),
  upsert: (summary) =>
    set((state) => ({
      runsById: {
        ...state.runsById,
        [summary.runId]: summary,
      },
      rootRunIdBySurfaceId:
        summary.parentRunId === null && summary.surfaceId !== null
          ? {
              ...state.rootRunIdBySurfaceId,
              [summary.surfaceId]: summary.rootRunId,
            }
          : state.rootRunIdBySurfaceId,
    })),
  clear: (input) =>
    set((state) => {
      const nextRuns = { ...state.runsById };
      delete nextRuns[input.runId];
      if (input.runId !== input.rootRunId) delete nextRuns[input.rootRunId];

      const nextRootRunIdBySurfaceId = { ...state.rootRunIdBySurfaceId };
      // Only evict the surface index if it still points at the run being cleared. A
      // stale `cleared` for an earlier run must not blank a newer run's index if the
      // single-root-per-surface guarantee is ever relaxed.
      if (
        input.surfaceId !== null &&
        nextRootRunIdBySurfaceId[input.surfaceId] === input.rootRunId
      ) {
        delete nextRootRunIdBySurfaceId[input.surfaceId];
      }
      return { runsById: nextRuns, rootRunIdBySurfaceId: nextRootRunIdBySurfaceId };
    }),
}));

// Shared selector for the active-surface → root run summary lookup that the workflow
// bar, the surface glow, and the command palette all need. Kept here so the surface
// index and its readers cannot drift apart.
export const selectRootRunForSurface =
  (surfaceId: number | null | undefined) =>
  (state: WorkflowRunStore): WorkflowRunSummary | undefined => {
    if (surfaceId === null || surfaceId === undefined) return undefined;
    const rootRunId = state.rootRunIdBySurfaceId[surfaceId];
    return rootRunId === undefined ? undefined : state.runsById[rootRunId];
  };
