import type { ActiveContext } from '@isagi/contracts';

import type { ProjectRow, WorktreeRow } from './types.js';

interface RequestedActiveContext {
  readonly projectId: number | null;
  readonly worktreeId: number | null;
}

export function chooseActiveContext(
  requested: RequestedActiveContext,
  projects: readonly ProjectRow[],
  worktrees: readonly WorktreeRow[],
): ActiveContext {
  const presentProjectIds = new Set(
    projects.filter((project) => project.status === 'present').map((project) => project.id),
  );

  const requestedWorktree = worktrees.find(
    (worktree) =>
      worktree.id === requested.worktreeId &&
      presentProjectIds.has(worktree.projectId) &&
      (!requested.projectId || requested.projectId === worktree.projectId),
  );
  if (requestedWorktree) {
    return { projectId: requestedWorktree.projectId, worktreeId: requestedWorktree.id };
  }

  if (requested.projectId && presentProjectIds.has(requested.projectId)) {
    const rootWorktree = worktrees.find(
      (worktree) => worktree.projectId === requested.projectId && worktree.isRoot === 1,
    );
    if (rootWorktree) {
      return { projectId: rootWorktree.projectId, worktreeId: rootWorktree.id };
    }
  }

  const firstProjectRoot = projects
    .filter((project) => presentProjectIds.has(project.id))
    .flatMap((project) =>
      worktrees.filter((worktree) => worktree.projectId === project.id && worktree.isRoot === 1),
    )[0];
  if (firstProjectRoot) {
    return { projectId: firstProjectRoot.projectId, worktreeId: firstProjectRoot.id };
  }

  const firstPresent = worktrees.find((worktree) => presentProjectIds.has(worktree.projectId));
  if (firstPresent) {
    return { projectId: firstPresent.projectId, worktreeId: firstPresent.id };
  }

  return { projectId: null, worktreeId: null };
}

export function activeContextsEqual(left: RequestedActiveContext, right: ActiveContext) {
  return left.projectId === right.projectId && left.worktreeId === right.worktreeId;
}
