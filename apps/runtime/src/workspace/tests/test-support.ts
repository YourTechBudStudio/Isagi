import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';

import type { CommandServiceShape } from '../../commands/index.js';
import type { GitService } from '../../git/index.js';
import { stateFromActiveContext, type StateFileService } from '../../persistence/index.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import type { InternalRuntimeEventBusService } from '../../runtime-events/index.js';
import type { SurfaceRepositoryService, SurfaceServiceShape } from '../../surfaces/index.js';
import type {
  WorktreeSetupRepositoryService,
  WorktreeSetupService as WorktreeSetupServiceShape,
} from '../../worktree-setup/index.js';
import type { ProjectRow, WorktreeRow } from '../types.js';
import type { WorkspaceRepositoryService } from '../workspace.repository.js';

export const project: ProjectRow = {
  id: 1,
  name: 'Isagi',
  rootPath: '/repo/isagi',
  status: 'present',
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  lastSeenAt: '2026-06-04T00:00:00.000Z',
  missingReason: null,
};

export const worktree: WorktreeRow = {
  id: 10,
  projectId: project.id,
  path: '/repo/isagi',
  branch: 'main',
  head: 'abc123456789',
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  firstSeenAt: '2026-06-04T00:00:00.000Z',
  lastSeenAt: '2026-06-04T00:00:00.000Z',
};

export const featureWorktree: WorktreeRow = {
  ...worktree,
  id: 11,
  path: '/repo/isagi-feature',
  branch: 'feature/delete-me',
};

export const git = {
  run: () => Effect.die(new Error('git should not be called by active context persistence')),
} satisfies GitService;

export const testDataDirectory = makeTestDataDirectory('/tmp/isagi-test');

export const testWorktreeSetup = {
  preflight: (candidate) =>
    Effect.succeed({ projectId: candidate.id, status: 'not_configured', summary: [] }),
  updateTrust: (input) =>
    Effect.succeed({
      projectId: input.project.id,
      status: input.request.action === 'disable_hooks' ? 'disabled' : 'trusted',
      ...(input.request.action === 'disable_hooks' ? {} : { hash: input.request.hash }),
    }),
  validateTrustForOpen: () => Effect.succeed({ status: 'not_configured' as const }),
} satisfies WorktreeSetupServiceShape;

export const testWorktreeSetupRepository = {
  findTrust: () => Effect.succeed(null),
  setTrustedHash: () => Effect.void,
  disableHooks: () => Effect.void,
  createRunWithSteps: () => Effect.succeed(1),
  listRunSteps: () => Effect.succeed([]),
} satisfies WorktreeSetupRepositoryService;

export const testSurfaceRepository = {
  worktreeExists: () => Effect.succeed(false),
  findSurface: () => Effect.succeed(null),
  findPane: () => Effect.succeed(null),
  findWorktreePath: () => Effect.succeed(null),
  findEnvironmentFocus: () => Effect.succeed(null),
  listWorkspaceSurfaceMetadata: Effect.succeed([]),
  listEnvironmentFocusStates: Effect.succeed([]),
  listPanesForSurface: () => Effect.succeed([]),
  listAgentSessionsForPanes: () => Effect.succeed([]),
  listTerminalSessionsForPanes: () => Effect.succeed([]),
  findPaneForSession: () => Effect.succeed(null),
  findSurfaceDeleteTarget: () => Effect.succeed(null),
  renameSurface: () => Effect.die('surface rename is not used by workspace tests'),
  deleteSurface: () => Effect.die('surface delete is not used by workspace tests'),
  deleteSurfacePane: () => Effect.die('surface pane delete is not used by workspace tests'),
  createSinglePaneSurface: () => Effect.die('surface creation is not used by workspace tests'),
  splitSurfacePane: () => Effect.die('surface split is not used by workspace tests'),
  setSurfaceLayout: () => Effect.die('surface layout update is not used by workspace tests'),
  setPaneSession: () => Effect.die('surface pane session placement is not used by workspace tests'),
  claimPaneSession: () => Effect.die('surface pane session claim is not used by workspace tests'),
  setEnvironmentFocus: (input) => Effect.succeed(input),
} satisfies SurfaceRepositoryService;

export const testSurfaceService = {
  getSurfaceDetail: () => Effect.die('surface detail is not used by workspace tests'),
  renameSurface: () => Effect.die('surface rename is not used by workspace tests'),
  deleteSurface: () => Effect.die('surface delete is not used by workspace tests'),
  deleteSurfacePane: () => Effect.die('surface pane delete is not used by workspace tests'),
  createSurface: () => Effect.die('surface creation is not used by workspace tests'),
  splitPane: () => Effect.die('surface split is not used by workspace tests'),
  setSplitWeights: () => Effect.die('surface layout update is not used by workspace tests'),
  createPaneSession: () => Effect.die('surface pane session create is not used by workspace tests'),
  claimPaneSession: () => Effect.die('surface pane session claim is not used by workspace tests'),
  createSinglePaneSurface: () => Effect.die('surface creation is not used by workspace tests'),
  setWorktreeEnvironmentFocus: () => Effect.die('surface focus is not used by workspace tests'),
} satisfies SurfaceServiceShape;

export const testCommandService = {
  listForWorktree: () => Effect.die('command list is not used by workspace tests'),
  readLogMetadata: () => Effect.die('command log metadata is not used by workspace tests'),
  run: () => Effect.die('command run is not used by workspace tests'),
  stop: () => Effect.die('command stop is not used by workspace tests'),
  restart: () => Effect.die('command restart is not used by workspace tests'),
  runPostCreateLifecycle: () => Effect.void,
  cleanupBeforeWorktreeDelete: () => Effect.void,
  cleanupBeforeWorktreePrune: () => Effect.void,
  reconcileStaleRunningCommands: Effect.void,
} satisfies CommandServiceShape;

export const testInternalEvents = {
  publish: () => Effect.void,
  subscribe: () =>
    Effect.succeed({
      take: Effect.never,
      unsubscribe: Effect.void,
    }),
} satisfies InternalRuntimeEventBusService;

export function repositoryWith(input: {
  readonly project: ProjectRow | null;
  readonly worktree: WorktreeRow | null;
}): WorkspaceRepositoryService {
  return {
    findProject: (projectId) =>
      Effect.succeed(input.project && input.project.id === projectId ? input.project : null),
    findProjectByRootPath: () => Effect.succeed(input.project),
    findWorktree: (worktreeId) =>
      Effect.succeed(input.worktree && input.worktree.id === worktreeId ? input.worktree : null),
    findProjectWorktree: (lookup) =>
      Effect.succeed(
        input.worktree &&
          input.worktree.projectId === lookup.projectId &&
          input.worktree.id === lookup.worktreeId
          ? input.worktree
          : null,
      ),
    findProjectRootWorktree: (lookup) =>
      Effect.succeed(
        input.worktree &&
          input.worktree.projectId === lookup.projectId &&
          input.worktree.path === lookup.rootPath
          ? input.worktree
          : null,
      ),
    findProjectWorktreeByBranch: (lookup) =>
      Effect.succeed(
        input.worktree &&
          input.worktree.projectId === lookup.projectId &&
          input.worktree.branch === lookup.branch
          ? input.worktree
          : null,
      ),
    deleteProject: () => Effect.succeed(false),
    deleteWorktree: () => Effect.succeed(false),
    insertProject: () => Effect.succeed(project.id),
    listProjects: Effect.succeed(input.project ? [input.project] : []),
    listWorktrees: Effect.succeed(input.worktree ? [input.worktree] : []),
    reconcileProjectWorktrees: () => Effect.succeed({ added: [], missing: [] }),
    restoreProjectAtRootPath: () => Effect.succeed({ added: [], missing: [] }),
    setProjectStatus: () => Effect.void,
  };
}

export function repositoryWithWorktrees(input: {
  readonly project: ProjectRow;
  readonly worktrees: readonly WorktreeRow[];
}): WorkspaceRepositoryService {
  return {
    findProject: (projectId) =>
      Effect.succeed(input.project.id === projectId ? input.project : null),
    findProjectByRootPath: (rootPath) =>
      Effect.succeed(input.project.rootPath === rootPath ? input.project : null),
    findWorktree: (worktreeId) =>
      Effect.succeed(input.worktrees.find((candidate) => candidate.id === worktreeId) ?? null),
    findProjectWorktree: (lookup) =>
      Effect.succeed(
        input.worktrees.find(
          (candidate) =>
            candidate.projectId === lookup.projectId && candidate.id === lookup.worktreeId,
        ) ?? null,
      ),
    findProjectRootWorktree: (lookup) =>
      Effect.succeed(
        input.worktrees.find(
          (candidate) =>
            candidate.projectId === lookup.projectId && candidate.path === lookup.rootPath,
        ) ?? null,
      ),
    findProjectWorktreeByBranch: (lookup) =>
      Effect.succeed(
        input.worktrees.find(
          (candidate) =>
            candidate.projectId === lookup.projectId && candidate.branch === lookup.branch,
        ) ?? null,
      ),
    deleteProject: () => Effect.succeed(false),
    deleteWorktree: () => Effect.succeed(true),
    insertProject: () => Effect.succeed(input.project.id),
    listProjects: Effect.succeed([input.project]),
    listWorktrees: Effect.succeed([...input.worktrees]),
    reconcileProjectWorktrees: () => Effect.succeed({ added: [], missing: [] }),
    restoreProjectAtRootPath: () => Effect.succeed({ added: [], missing: [] }),
    setProjectStatus: () => Effect.void,
  };
}

export function deleteFixtures() {
  const rootPath = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-delete-worktree-')));
  const fixtureProject = { ...project, rootPath };
  const rootWorktree = { ...worktree, path: rootPath };
  const targetWorktree = {
    ...featureWorktree,
    path: join(rootPath, '../isagi-feature'),
  };
  return {
    project: fixtureProject,
    rootWorktree,
    targetWorktree,
    cleanup: () => rmSync(rootPath, { recursive: true, force: true }),
  };
}

export function stateFileWithWriteCounter(
  onWrite: () => void,
  initialState = stateFromActiveContext(null, null, 0),
): StateFileService {
  let state = initialState;

  return {
    read: Effect.sync(() => state),
    write: (nextState) =>
      Effect.sync(() => {
        state = nextState;
        onWrite();
      }),
    writeActiveContextIfFresh: (input) =>
      Effect.sync(() => {
        if (input.revision > state.workspace.activeContextRevision) {
          state = stateFromActiveContext(
            input.activeProjectId,
            input.activeWorktreeId,
            input.revision,
          );
          onWrite();
        }
        return state;
      }),
  };
}
