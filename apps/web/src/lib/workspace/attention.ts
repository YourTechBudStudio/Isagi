import { create } from 'zustand';

import type { AttentionSource, AttentionSourceIdentity, AttentionState } from '@isagi/contracts';

import type { Project, Surface, Worktree } from './types.js';

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
): readonly Project[] {
  const sources = Object.values(sourcesByKey);
  return projects.map((project) => ({
    ...project,
    worktrees: project.worktrees.map((worktree) => applyAttentionToWorktree(worktree, sources)),
  }));
}

function applyAttentionToWorktree(
  worktree: Worktree,
  sources: readonly AttentionSource[],
): Worktree {
  const surfaces = worktree.surfaces.map((surface) => applyAttentionToSurface(surface, sources));
  return {
    ...worktree,
    surfaces,
    attention: aggregateAttention([
      ...surfaces.map((surface) => surface.attention),
      ...worktree.commands.map((command) => command.attention),
    ]),
  };
}

function applyAttentionToSurface(surface: Surface, sources: readonly AttentionSource[]): Surface {
  return {
    ...surface,
    attention: aggregateAttention(
      sources.filter((source) => source.surfaceId === surface.id).map((source) => source.attention),
    ),
  };
}

export function aggregateAttention(attentions: readonly AttentionState[]): AttentionState {
  if (attentions.includes('error')) return 'error';
  if (attentions.includes('working')) return 'working';
  if (attentions.includes('waiting')) return 'waiting';
  return 'idle';
}
