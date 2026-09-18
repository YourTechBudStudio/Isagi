import { create } from 'zustand';

import type {
  AttentionSource,
  AttentionSourceIdentity,
  AttentionState,
  WorkflowRunSummary,
} from '@isagi/contracts';

import type { Project, Surface, Worktree } from './types.js';
import type { AttachedRuns } from './workflow/attached.js';
import { workflowRunAttention } from './workflow/derive.js';

interface AttentionStore {
  readonly sourcesByKey: Readonly<Record<string, AttentionSource>>;
  readonly replaceSources: (sources: readonly AttentionSource[]) => void;
  readonly upsertSource: (source: AttentionSource) => void;
  readonly removeSource: (source: AttentionSourceIdentity) => void;
}

export const useAttentionStore = create<AttentionStore>((set) => ({
  sourcesByKey: {},
  replaceSources: (sources) =>
    set({
      sourcesByKey: Object.fromEntries(
        sources.map((source) => [attentionSourceKey(source.source), source]),
      ),
    }),
  upsertSource: (source) =>
    set((state) => ({
      sourcesByKey: {
        ...state.sourcesByKey,
        [attentionSourceKey(source.source)]: source,
      },
    })),
  removeSource: (source) =>
    set((state) => {
      const key = attentionSourceKey(source);
      if (!(key in state.sourcesByKey)) return {};
      const next = { ...state.sourcesByKey };
      delete next[key];
      return { sourcesByKey: next };
    }),
}));

export function attentionSourceKey(source: AttentionSourceIdentity) {
  return `${source.kind}:${source.id}`;
}

export function attentionForPane(
  sourcesByKey: Readonly<Record<string, AttentionSource>>,
  paneId: number,
): AttentionState {
  return aggregateAttention(
    Object.values(sourcesByKey)
      .filter((source) => source.paneId === paneId)
      .map((source) => source.attention),
  );
}

export function applyAttentionToProjects(
  projects: readonly Project[],
  sourcesByKey: Readonly<Record<string, AttentionSource>>,
  attachedRuns: AttachedRuns = [],
): readonly Project[] {
  const sources = Object.values(sourcesByKey);
  // Indexed once per pass rather than scanned per surface: the same attached-run cache the bar and
  // the palette read, folded into the shape this traversal needs.
  const runBySurfaceId = new Map<number, WorkflowRunSummary>();
  for (const run of attachedRuns) {
    if (run.attachment?.surfaceId != null) runBySurfaceId.set(run.attachment.surfaceId, run);
  }
  return projects.map((project) => ({
    ...project,
    worktrees: project.worktrees.map((worktree) =>
      applyAttentionToWorktree(worktree, sources, runBySurfaceId),
    ),
  }));
}

function applyAttentionToWorktree(
  worktree: Worktree,
  sources: readonly AttentionSource[],
  runBySurfaceId: ReadonlyMap<number, WorkflowRunSummary>,
): Worktree {
  const resolved = worktree.surfaces.map((surface) =>
    applyAttentionToSurface(surface, sources, runBySurfaceId),
  );
  return {
    ...worktree,
    surfaces: resolved.map((entry) => entry.surface),
    attention: aggregateAttention(resolved.map((entry) => entry.worktreeContribution)),
  };
}

function isTerminalOnlySurface(surface: Surface): boolean {
  return (
    surface.paneKinds.length > 0 &&
    surface.paneKinds.every((paneKind) => paneKind === 'terminal_session')
  );
}

/**
 * A surface always shows its own full attention. What it contributes upward to the worktree can
 * be narrower: a terminal-only surface suppresses its terminal pane noise so a long-running or
 * failed command never implies an agent needs the user, but a workflow attached to that surface
 * still bubbles up because it can genuinely be waiting or failed.
 */
interface ResolvedSurfaceAttention {
  readonly surface: Surface;
  readonly worktreeContribution: AttentionState;
}

function applyAttentionToSurface(
  surface: Surface,
  sources: readonly AttentionSource[],
  runBySurfaceId: ReadonlyMap<number, WorkflowRunSummary>,
): ResolvedSurfaceAttention {
  const workflowAttention = workflowRunAttention(runBySurfaceId.get(surface.id));
  const paneAttention = aggregateAttention(
    sources.filter((source) => source.surfaceId === surface.id).map((source) => source.attention),
  );
  const attention =
    workflowAttention === null
      ? paneAttention
      : aggregateAttention([paneAttention, workflowAttention]);
  return {
    surface: { ...surface, attention },
    worktreeContribution: isTerminalOnlySurface(surface)
      ? (workflowAttention ?? 'idle')
      : attention,
  };
}

export function aggregateAttention(attentions: readonly AttentionState[]): AttentionState {
  if (attentions.includes('error')) return 'error';
  if (attentions.includes('working')) return 'working';
  if (attentions.includes('waiting')) return 'waiting';
  return 'idle';
}
