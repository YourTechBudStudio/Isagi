import { create } from 'zustand';

import type { WorkflowSurfaceSummary } from '@isagi/contracts';

import { surfaceLockState } from './workflow-derive.js';

interface WorkflowSurfaceStore {
  readonly summariesBySurfaceId: Readonly<Record<number, WorkflowSurfaceSummary>>;
  readonly replace: (summaries: readonly WorkflowSurfaceSummary[]) => void;
  readonly upsert: (summary: WorkflowSurfaceSummary) => void;
  readonly clear: (surfaceId: number) => void;
}

export const useWorkflowSurfaceStore = create<WorkflowSurfaceStore>((set) => ({
  summariesBySurfaceId: {},
  replace: (summaries) =>
    set({
      summariesBySurfaceId: Object.fromEntries(
        summaries.map((summary) => [summary.surfaceId, summary]),
      ),
    }),
  upsert: (summary) =>
    set((state) => ({
      summariesBySurfaceId: {
        ...state.summariesBySurfaceId,
        [summary.surfaceId]: summary,
      },
    })),
  clear: (surfaceId) =>
    set((state) => {
      if (!(surfaceId in state.summariesBySurfaceId)) return {};
      const next = { ...state.summariesBySurfaceId };
      delete next[surfaceId];
      return { summariesBySurfaceId: next };
    }),
}));

export function useSurfaceLocked(surfaceId: number) {
  return useWorkflowSurfaceStore((state) =>
    surfaceLockState(state.summariesBySurfaceId[surfaceId]),
  );
}
