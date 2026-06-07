import { basename } from 'node:path';

import type { Project, Worktree, WorkspaceSnapshot } from '@isagi/contracts';

import type { ProjectRow, WorktreeRow } from './types.js';

export function buildWorkspaceSnapshot(
  projects: readonly ProjectRow[],
  worktrees: readonly WorktreeRow[],
): WorkspaceSnapshot {
  return {
    projects: projects.map((project) => buildProjectSnapshot(project, worktrees)),
  };
}

export function buildProjectSnapshot(
  project: ProjectRow,
  worktrees: readonly WorktreeRow[],
): Project {
  const base = {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    worktrees:
      project.status === 'present'
        ? worktrees
            .filter((worktree) => worktree.projectId === project.id)
            .map(buildWorktreeSnapshot)
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

function buildWorktreeSnapshot(worktree: WorktreeRow): Worktree {
  return {
    id: worktree.id,
    projectId: worktree.projectId,
    title: worktreeTitle(worktree),
    path: worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    isRoot: worktree.isRoot === 1,
    parked: false,
    surfaces: [],
    activeSurfaceId: null,
    commands: [],
    attention: 'idle',
  };
}

function worktreeTitle(worktree: WorktreeRow) {
  if (worktree.branch) {
    return worktree.branch;
  }
  return basename(worktree.path) || worktree.path;
}
