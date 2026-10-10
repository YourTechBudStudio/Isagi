import type { ControlPlaneSnapshot, WorkspaceSnapshot } from '@isagi/contracts';

import { FIXTURE_CONTROL_PLANE } from '../seed.js';

/**
 * The workspaces the state-transitions page serves.
 *
 * No worktree carries a surface. Every spec on this page is about how runtime facts are read and
 * refreshed, and a surface would mount a terminal, a surface-detail read and a PTY socket whose
 * traffic has nothing to do with that question. The canvas therefore shows the production
 * "no surface" state for whichever worktree is selected.
 *
 * - `initial`   — one Git project with three worktrees, one folder project.
 * - `refreshed` — the same, plus a worktree `feat/refreshed`: proof that a later read landed.
 * - `pruned`    — `fix/reconnect` (103) is gone, as when Git stops reporting a checkout.
 */
export type WorkspaceVariant = 'initial' | 'refreshed' | 'pruned';

type SnapshotProject = WorkspaceSnapshot['projects'][number];
type SnapshotWorktree = SnapshotProject['worktrees'][number];

function gitWorktree(id: number, branch: string, isRoot = false): SnapshotWorktree {
  return {
    id,
    projectId: 10,
    title: branch,
    path: isRoot ? '~/work/isagi' : `~/work/.isagi/wt/${branch.replace('/', '-')}`,
    branch,
    head: 'abc1234def',
    isRoot,
    parked: false,
    surfaces: [],
    activeSurfaceId: null,
  };
}

function isagi(worktrees: readonly SnapshotWorktree[]): SnapshotProject {
  return {
    id: 10,
    name: 'isagi',
    rootPath: '~/work/isagi',
    kind: 'git',
    status: 'present',
    worktrees,
  };
}

const scratch: SnapshotProject = {
  id: 50,
  name: 'scratch',
  rootPath: '~/scratch',
  kind: 'folder',
  status: 'present',
  worktrees: [
    {
      id: 501,
      projectId: 50,
      title: 'folder',
      path: '~/scratch',
      branch: null,
      head: null,
      isRoot: true,
      parked: false,
      surfaces: [],
      activeSurfaceId: null,
    },
  ],
};

const main = gitWorktree(101, 'main', true);
const state = gitWorktree(102, 'feat/state');
const reconnect = gitWorktree(103, 'fix/reconnect');
const refreshed = gitWorktree(104, 'feat/refreshed');

export const WORKSPACE_VARIANTS: Readonly<Record<WorkspaceVariant, WorkspaceSnapshot>> = {
  initial: { projects: [isagi([main, state, reconnect]), scratch] },
  refreshed: { projects: [isagi([main, state, reconnect, refreshed]), scratch] },
  pruned: { projects: [isagi([main, state]), scratch] },
};

export const INITIAL_WORKSPACE = WORKSPACE_VARIANTS.initial;

/** The host inventory is still probing, so the startup gate holds and polls. */
export const INVENTORY_PENDING_CONTROL_PLANE: ControlPlaneSnapshot = {
  ...FIXTURE_CONTROL_PLANE,
  inventory: { status: 'pending' },
};
