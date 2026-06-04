import type { Worktree, Surface } from './types.js';

/** All agent sessions across a worktree's agent surface. */
export function agentSessionCount(worktree: Worktree): number {
  return worktree.surfaces.reduce(
    (total, surface) => total + (surface.agentSessions?.length ?? 0),
    0,
  );
}

/**
 * The rail meta line under a worktree title: worktree address plus a short
 * agent summary (the single harness name, `N agents`, or an empty/no-agent hint).
 */
export function worktreeSubtitle(worktree: Worktree): string {
  const count = agentSessionCount(worktree);
  if (count === 0) {
    return `${worktree.branch} · ${worktree.surfaces.length === 0 ? 'empty' : 'no agents'}`;
  }

  if (count === 1) {
    const only = worktree.surfaces.flatMap((surface) => surface.agentSessions ?? [])[0];
    return `${worktree.branch} · ${only?.harness ?? '1 agent'}`;
  }

  return `${worktree.branch} · ${count} agents`;
}

export function findActiveSurface(worktree: Worktree): Surface | null {
  return worktree.surfaces.find((surface) => surface.id === worktree.activeSurfaceId) ?? null;
}
