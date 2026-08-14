import { basename } from 'node:path';

import type { Project, Worktree, WorkspaceSnapshot } from '@isagi/contracts';

import type { EnvironmentFocusRow, ProjectRow, SurfaceMetadataRow, WorktreeRow } from './types.js';

export function buildWorkspaceSnapshot(
  projects: readonly ProjectRow[],
  worktrees: readonly WorktreeRow[],
  surfaces: readonly SurfaceMetadataRow[] = [],
  environmentFocus: readonly EnvironmentFocusRow[] = [],
): WorkspaceSnapshot {
  return {
    projects: projects.map((project) =>
      buildProjectSnapshot(project, worktrees, surfaces, environmentFocus),
    ),
  };
}

export function buildProjectSnapshot(
  project: ProjectRow,
  worktrees: readonly WorktreeRow[],
  surfaces: readonly SurfaceMetadataRow[] = [],
  environmentFocus: readonly EnvironmentFocusRow[] = [],
): Project {
  const base = {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    worktrees:
      project.status === 'present'
        ? rootWorktreeFirst(
            project,
            worktrees.filter((worktree) => worktree.projectId === project.id),
          ).map((worktree) => buildWorktreeSnapshot(project, worktree, surfaces, environmentFocus))
        : [],
  };

  if (project.status === 'missing') {
    return {
      ...base,
      status: 'missing',
      missingReason: project.missingReason ?? `Project unavailable: ${project.rootPath}`,
    };
  }

  return {
    ...base,
    status: 'present',
  };
}

/**
 * Root-ness is a product invariant, not a rank: the root worktree always renders
 * first. Persisted order governs the rest, so the root is lifted to the front
 * and every other worktree keeps its relative position. This is a stable move,
 * not a re-sort — the repository already returned the intended order.
 */
function rootWorktreeFirst(
  project: ProjectRow,
  worktrees: readonly WorktreeRow[],
): readonly WorktreeRow[] {
  const rootIndex = worktrees.findIndex((worktree) => isRootWorktree(project, worktree));
  if (rootIndex <= 0) {
    return worktrees;
  }
  const root = worktrees[rootIndex] as WorktreeRow;
  return [root, ...worktrees.slice(0, rootIndex), ...worktrees.slice(rootIndex + 1)];
}

// Root-ness is derived, not persisted. Git reports worktrees by checkout path;
// the root checkout is the discovered worktree whose path equals the current
// project root path. Persisting this separately creates drift.
function isRootWorktree(project: ProjectRow, worktree: WorktreeRow) {
  return worktree.path === project.rootPath;
}

function buildWorktreeSnapshot(
  project: ProjectRow,
  worktree: WorktreeRow,
  surfaces: readonly SurfaceMetadataRow[],
  environmentFocus: readonly EnvironmentFocusRow[],
): Worktree {
  const worktreeSurfaces = surfaces.filter((surface) => surface.worktreeId === worktree.id);
  const focus = environmentFocus.find((candidate) => candidate.worktreeId === worktree.id);
  return {
    id: worktree.id,
    projectId: worktree.projectId,
    title: worktreeTitle(worktree),
    path: worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    isRoot: isRootWorktree(project, worktree),
    parked: false,
    surfaces: worktreeSurfaces.map((surface) => ({
      id: surface.id,
      title: surface.title,
      paneKinds: [...surface.paneKinds],
    })),
    activeSurfaceId: worktreeSurfaces.some((surface) => surface.id === focus?.activeSurfaceId)
      ? (focus?.activeSurfaceId ?? null)
      : null,
  };
}

function worktreeTitle(worktree: WorktreeRow) {
  if (worktree.branch) {
    return worktree.branch;
  }
  return basename(worktree.path) || worktree.path;
}
