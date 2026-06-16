import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Schema } from 'effect';

import { workspaceSnapshotSchema } from '@isagi/contracts';

import { Git, GitCommandError } from '../git/index.js';
import {
  DataDirectory,
  StateFile,
  stateFromActiveContext,
  type DataDirectoryService,
  type WorkspaceState,
} from '../persistence/index.js';
import {
  SurfaceService,
  SurfaceRepository,
  type SurfaceRepositoryService,
  type SurfaceServiceShape,
} from '../surfaces/index.js';
import {
  WorktreeSetupRepository,
  WorktreeSetupService,
  type WorktreeSetupRepositoryService,
  type WorktreeSetupService as WorktreeSetupServiceShape,
} from '../worktree-setup/index.js';
import type { ProjectRow, WorktreeRow } from './types.js';
import {
  prunedWorktreeIds,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
} from './workspace.repository.js';
import { WorkspaceService, WorkspaceServiceLive } from './workspace.service.js';
import { buildWorkspaceSnapshot } from './workspace.snapshot.js';

const testWorktreeSetup = {
  preflight: (candidate: ProjectRow) =>
    Effect.succeed({ projectId: candidate.id, status: 'not_configured' as const, summary: [] }),
  updateTrust: (input: {
    readonly project: ProjectRow;
    readonly request: { readonly action: string; readonly hash?: string };
  }) =>
    Effect.succeed({
      projectId: input.project.id,
      status:
        input.request.action === 'disable_hooks' ? ('disabled' as const) : ('trusted' as const),
      ...(input.request.action === 'disable_hooks' ? {} : { hash: input.request.hash ?? '' }),
    }),
  validateTrustForOpen: () => Effect.succeed({ status: 'not_configured' as const }),
} satisfies WorktreeSetupServiceShape;

const testWorktreeSetupRepository = {
  findTrust: () => Effect.succeed(null),
  setTrustedHash: () => Effect.void,
  disableHooks: () => Effect.void,
  createRunWithSteps: () => Effect.succeed(1),
  listRunSteps: () => Effect.succeed([]),
} satisfies WorktreeSetupRepositoryService;

const testSurfaceRepository = {
  worktreeExists: () => Effect.succeed(false),
  findSurface: () => Effect.succeed(null),
  findPane: () => Effect.succeed(null),
  findEnvironmentFocus: () => Effect.succeed(null),
  listWorkspaceSurfaceMetadata: Effect.succeed([]),
  listEnvironmentFocusStates: Effect.succeed([]),
  listPanesForSurface: () => Effect.succeed([]),
  listAgentSessionsForPanes: () => Effect.succeed([]),
  listTerminalSessionsForPanes: () => Effect.succeed([]),
  findSurfaceDeleteTarget: () => Effect.succeed(null),
  listWorktreeDeleteTargets: () => Effect.succeed([]),
  renameSurface: () => Effect.die('surface rename is not used by workspace snapshot tests'),
  deleteSurface: () => Effect.die('surface delete is not used by workspace snapshot tests'),
  deleteSurfacePane: () =>
    Effect.die('surface pane delete is not used by workspace snapshot tests'),
  createSinglePaneSurface: () => Effect.die('surface creation is not used by workspace tests'),
  setEnvironmentFocus: (input) => Effect.succeed(input),
} satisfies SurfaceRepositoryService;

const testSurfaceService = {
  getSurfaceDetail: () => Effect.die('surface detail is not used by workspace snapshot tests'),
  renameSurface: () => Effect.die('surface rename is not used by workspace snapshot tests'),
  deleteSurface: () => Effect.die('surface delete is not used by workspace snapshot tests'),
  deleteSurfacePane: () =>
    Effect.die('surface pane delete is not used by workspace snapshot tests'),
  cleanupWorktreeForDelete: () => Effect.succeed({ attemptedSessionIds: [], warnings: [] }),
  createSinglePaneSurface: () => Effect.die('surface creation is not used by workspace tests'),
  setWorktreeEnvironmentFocus: () => Effect.die('surface focus is not used by workspace tests'),
} satisfies SurfaceServiceShape;

const project: ProjectRow = {
  id: 1,
  name: 'Isagi',
  rootPath: '/repo/isagi',
  status: 'present',
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  lastSeenAt: '2026-06-04T00:00:00.000Z',
  missingReason: null,
};

const testDataDirectory = {
  paths: {
    root: '/tmp/isagi-test',
    databasePath: '/tmp/isagi-test/isagi.db',
    statePath: '/tmp/isagi-test/state.json',
    worktreesPath: '/tmp/isagi-test/worktrees',
    sessionsPath: '/tmp/isagi-test/sessions',
  },
} satisfies DataDirectoryService;

const worktreeBase = {
  id: 10,
  projectId: project.id,
  path: '/repo/isagi',
  branch: 'main',
  head: 'abc123456789',
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  firstSeenAt: '2026-06-04T00:00:00.000Z',
  lastSeenAt: '2026-06-04T00:00:00.000Z',
} satisfies WorktreeRow;

test('workspace snapshots serialize worktrees for present projects', () => {
  const snapshot = buildWorkspaceSnapshot([project], [worktreeBase]);

  assert.equal(snapshot.projects[0]?.worktrees[0]?.id, worktreeBase.id);
  assert.doesNotThrow(() => Schema.decodeUnknownSync(workspaceSnapshotSchema)(snapshot));
});

test('workspace snapshots include persisted surface rail metadata and active surface id', () => {
  const snapshot = buildWorkspaceSnapshot(
    [project],
    [worktreeBase],
    [
      {
        id: 101,
        worktreeId: worktreeBase.id,
        kind: 'agent',
        title: 'Pi',
        attention: 'waiting',
        sortOrder: 0,
      },
    ],
    [{ worktreeId: worktreeBase.id, activeSurfaceId: 101, activePaneId: 1001 }],
  );

  assert.deepEqual(snapshot.projects[0]?.worktrees[0]?.surfaces, [
    { id: 101, kind: 'agent', title: 'Pi', attention: 'waiting' },
  ]);
  assert.equal(snapshot.projects[0]?.worktrees[0]?.activeSurfaceId, 101);
  assert.doesNotThrow(() => Schema.decodeUnknownSync(workspaceSnapshotSchema)(snapshot));
});

test('workspace reconciliation prunes every undiscovered worktree row', () => {
  assert.deepEqual(
    prunedWorktreeIds({
      discovered: [{ path: '/repo/isagi' }],
      existing: [
        { id: 10, path: '/repo/isagi' },
        { id: 11, path: '/repo/isagi-feature' },
        { id: 12, path: '/repo/isagi-stale-root' },
      ],
    }),
    [11, 12],
  );
});

test('workspace reads known rows without reconciling Git state', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-project-'));
  let currentProject: ProjectRow = { ...project, rootPath: projectRoot };
  let reconcileCalls = 0;
  let state: WorkspaceState = stateFromActiveContext(project.id, worktreeBase.id);
  const worktrees: readonly WorktreeRow[] = [
    { ...worktreeBase, path: projectRoot },
    {
      ...worktreeBase,
      id: 11,
      path: join(projectRoot, '../isagi-feature'),
      branch: 'feature/kept',
    },
  ];

  const repository = {
    findProject: (projectId) =>
      Effect.succeed(projectId === currentProject.id ? currentProject : null),
    findProjectByRootPath: () => Effect.succeed(currentProject),
    findWorktree: (worktreeId) =>
      Effect.succeed(worktrees.find((worktree) => worktree.id === worktreeId) ?? null),
    findProjectWorktree: (lookup) =>
      Effect.succeed(
        worktrees.find(
          (worktree) =>
            worktree.projectId === lookup.projectId && worktree.id === lookup.worktreeId,
        ) ?? null,
      ),
    findProjectRootWorktree: (lookup) =>
      Effect.succeed(
        worktrees.find(
          (worktree) =>
            worktree.projectId === lookup.projectId && worktree.path === lookup.rootPath,
        ) ?? null,
      ),
    findProjectWorktreeByBranch: (lookup) =>
      Effect.succeed(
        worktrees.find(
          (worktree) =>
            worktree.projectId === lookup.projectId && worktree.branch === lookup.branch,
        ) ?? null,
      ),
    deleteProject: () => Effect.succeed(false),
    deleteWorktree: () => Effect.succeed(false),
    insertProject: () => Effect.succeed(project.id),
    listProjects: Effect.sync(() => [currentProject]),
    listWorktrees: Effect.succeed([...worktrees]),
    reconcileProjectWorktrees: () =>
      Effect.sync(() => {
        reconcileCalls += 1;
        return { added: [], missing: [] };
      }),
    restoreProjectAtRootPath: (input) =>
      Effect.sync(() => {
        currentProject = { ...currentProject, rootPath: input.rootPath, status: 'present' };
        return { added: [], missing: [] };
      }),
    setProjectStatus: (input) =>
      Effect.sync(() => {
        currentProject = {
          ...currentProject,
          status: input.status,
          missingReason: input.missingReason ?? null,
        };
      }),
  } satisfies WorkspaceRepositoryService;

  const git = {
    run: (args: readonly string[], options: { readonly cwd?: string | undefined } = {}) =>
      Effect.fail(
        new GitCommandError({
          args,
          cause: new Error('Git failed'),
          cwd: options.cwd,
          stderr: 'fatal: not a git repository',
        }),
      ),
  };

  const stateFile = {
    read: Effect.sync(() => state),
    write: (nextState: WorkspaceState) =>
      Effect.sync(() => {
        state = nextState;
      }),
    writeActiveContextIfFresh: (input: {
      readonly activeProjectId: number | null;
      readonly activeWorktreeId: number | null;
      readonly revision: number;
    }) =>
      Effect.sync(() => {
        if (input.revision > state.workspace.activeContextRevision) {
          state = stateFromActiveContext(
            input.activeProjectId,
            input.activeWorktreeId,
            input.revision,
          );
        }
        return state;
      }),
  };

  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        return yield* service.get;
      }).pipe(
        Effect.provide(WorkspaceServiceLive),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(SurfaceService, testSurfaceService),
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, git),
        Effect.provideService(DataDirectory, testDataDirectory),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    );

    assert.equal(reconcileCalls, 0);
    assert.equal(snapshot.projects[0]?.status, 'present');
    assert.equal(worktrees.length, 2);
  } finally {
    console.error = originalConsoleError;
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
