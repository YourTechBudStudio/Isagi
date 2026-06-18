import { basename } from 'node:path';

import type { Project, Worktree, WorkspaceSnapshot } from '@isagi/contracts';
import type { AttentionState } from '@isagi/contracts';

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
        ? worktrees
            .filter((worktree) => worktree.projectId === project.id)
            .map((worktree) => buildWorktreeSnapshot(project, worktree, surfaces, environmentFocus))
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
    // Root-ness is derived, not persisted. Git reports worktrees by checkout
    // path; the root checkout is the discovered worktree whose path equals the
    // current project root path. Persisting this separately creates drift.
    isRoot: worktree.path === project.rootPath,
    parked: false,
    surfaces: worktreeSurfaces.map((surface) => ({
      id: surface.id,
      kind: surface.kind,
      title: surface.title,
      attention: surface.attention,
    })),
    activeSurfaceId: worktreeSurfaces.some((surface) => surface.id === focus?.activeSurfaceId)
      ? (focus?.activeSurfaceId ?? null)
      : null,
    commands: [],
    attention: aggregateAttention(worktreeSurfaces.map((surface) => surface.attention)),
  };
}

function aggregateAttention(attentions: readonly AttentionState[]): AttentionState {
  if (attentions.includes('error')) return 'error';
  if (attentions.includes('waiting')) return 'waiting';
  if (attentions.includes('working')) return 'working';
  return 'idle';
}

function worktreeTitle(worktree: WorktreeRow) {
  if (worktree.branch) {
    return worktree.branch;
  }
  return basename(worktree.path) || worktree.path;
}
