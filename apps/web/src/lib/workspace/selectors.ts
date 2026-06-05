import type { Surface, Worktree } from './types.js';

export function worktreeSubtitle(worktree: Worktree): string {
  const branch = worktree.branch ?? shortHead(worktree.head) ?? 'detached';
  return `${compactHomePath(worktree.path)} · ${branch}`;
}

export function branchLabel(worktree: Worktree): string {
  return worktree.branch ?? shortHead(worktree.head) ?? 'detached';
}

export function findActiveSurface(worktree: Worktree): Surface | null {
  return worktree.surfaces.find((surface) => surface.id === worktree.activeSurfaceId) ?? null;
}

export function compactHomePath(path: string): string {
  return path;
}

function shortHead(head: string | null | undefined) {
  return head ? head.slice(0, 7) : null;
}
