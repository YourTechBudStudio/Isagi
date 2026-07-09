import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Schema } from 'effect';

import { workspaceSnapshotSchema } from '@isagi/contracts';

import { CommandService, type CommandServiceShape } from '../../commands/index.js';
import { Git, GitCommandError } from '../../git/index.js';
import {
  DataDirectory,
  StateFile,
  stateFromActiveContext,
  type WorkspaceState,
} from '../../persistence/index.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import { PtyService, type PtyServiceShape } from '../../pty-processes/index.js';
import {
  InternalRuntimeEventBus,
  type InternalRuntimeEventBusService,
} from '../../runtime-events/index.js';
import {
  SurfaceService,
  SurfaceRepository,
  type SurfaceRepositoryService,
  type SurfaceServiceShape,
} from '../../surfaces/index.js';
import {
  WorktreeSetupRepository,
  WorktreeSetupService,
  type WorktreeSetupRepositoryService,
  type WorktreeSetupService as WorktreeSetupServiceShape,
} from '../../worktree-setup/index.js';
import type { ProjectRow, WorktreeRow } from '../types.js';
import {
  prunedWorktreeIds,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
} from '../workspace.repository.js';
import { WorkspaceService, WorkspaceServiceLive } from '../workspace.service.js';
import { buildWorkspaceSnapshot } from '../workspace.snapshot.js';

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
  findWorktreePath: () => Effect.succeed(null),
  findEnvironmentFocus: () => Effect.succeed(null),
  listWorkspaceSurfaceMetadata: Effect.succeed([]),
  listEnvironmentFocusStates: Effect.succeed([]),
  listPanesForSurface: () => Effect.succeed([]),
  listAgentSessionsForPanes: () => Effect.succeed([]),
  listTerminalSessionsForPanes: () => Effect.succeed([]),
  listPaneSessionBindings: Effect.succeed([]),
  findPaneForSession: () => Effect.succeed(null),
  findSurfaceDeleteTarget: () => Effect.succeed(null),
  renameSurface: () => Effect.die('surface rename is not used by workspace snapshot tests'),
  deleteSurface: () => Effect.die('surface delete is not used by workspace snapshot tests'),
  deleteSurfacePane: () =>
    Effect.die('surface pane delete is not used by workspace snapshot tests'),
  createSinglePaneSurface: () => Effect.die('surface creation is not used by workspace tests'),
  splitSurfacePane: () => Effect.die('surface split is not used by workspace tests'),
  setSurfaceLayout: () => Effect.die('surface layout update is not used by workspace tests'),
  setPaneSession: () => Effect.die('surface pane session placement is not used by workspace tests'),
  claimPaneSession: () => Effect.die('surface pane session claim is not used by workspace tests'),
  setEnvironmentFocus: (input) => Effect.succeed(input),
} satisfies SurfaceRepositoryService;

const testSurfaceService = {
  getSurfaceDetail: () => Effect.die('surface detail is not used by workspace snapshot tests'),
  renameSurface: () => Effect.die('surface rename is not used by workspace snapshot tests'),
  deleteSurface: () => Effect.die('surface delete is not used by workspace snapshot tests'),
  deleteSurfacePane: () =>
    Effect.die('surface pane delete is not used by workspace snapshot tests'),
  createSurface: () => Effect.die('surface creation is not used by workspace tests'),
  splitPane: () => Effect.die('surface split is not used by workspace tests'),
  setSplitWeights: () => Effect.die('surface layout update is not used by workspace tests'),
  createPaneSession: () => Effect.die('surface pane session create is not used by workspace tests'),
  claimPaneSession: () => Effect.die('surface pane session claim is not used by workspace tests'),
  createSinglePaneSurface: () => Effect.die('surface creation is not used by workspace tests'),
  setWorktreeEnvironmentFocus: () => Effect.die('surface focus is not used by workspace tests'),
} satisfies SurfaceServiceShape;

const testCommandService = {
  listForWorktree: () => Effect.die('command list is not used by workspace snapshot tests'),
  readLogMetadata: () => Effect.die('command log metadata is not used by workspace snapshot tests'),
  run: () => Effect.die('command run is not used by workspace snapshot tests'),
  stop: () => Effect.die('command stop is not used by workspace snapshot tests'),
  restart: () => Effect.die('command restart is not used by workspace snapshot tests'),
  runPostCreateLifecycle: () => Effect.void,
  cleanupBeforeWorktreeDelete: () => Effect.void,
  cleanupBeforeWorktreePrune: () => Effect.void,
  reconcileStaleRunningCommands: Effect.void,
} satisfies CommandServiceShape;

const testPtyService = {
  launch: () => Effect.die('pty launch is not used by workspace snapshot tests'),
  getAttachmentPlan: () =>
    Effect.die('pty attachment planning is not used by workspace snapshot tests'),
  attach: () => Effect.die('pty attach is not used by workspace snapshot tests'),
  replay: () => Effect.die('pty replay is not used by workspace snapshot tests'),
  write: () => Effect.die('pty write is not used by workspace snapshot tests'),
  writeInput: () => Effect.die('pty write input is not used by workspace snapshot tests'),
  resize: () => Effect.die('pty resize is not used by workspace snapshot tests'),
  kill: () => Effect.void,
  terminate: () => Effect.void,
  pin: () => Effect.void,
  unpin: () => Effect.void,
  isPinned: () => Effect.succeed(false),
} satisfies PtyServiceShape;

const testInternalEvents = {
  publish: () => Effect.void,
  subscribe: () =>
    Effect.succeed({
      take: Effect.never,
      unsubscribe: Effect.void,
    }),
} satisfies InternalRuntimeEventBusService;

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

const testDataDirectory = makeTestDataDirectory('/tmp/isagi-test');

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
  assert.equal('commands' in snapshot.projects[0]!.worktrees[0]!, false);
  assert.doesNotThrow(() => Schema.decodeUnknownSync(workspaceSnapshotSchema)(snapshot));
});

test('workspace snapshots include surface rail metadata and active surface id', () => {
  const snapshot = buildWorkspaceSnapshot(
    [project],
    [worktreeBase],
    [
      {
        id: 101,
        worktreeId: worktreeBase.id,
        title: 'Pi',
        paneKinds: ['agent_session'],
        sortOrder: 0,
      },
    ],
    [{ worktreeId: worktreeBase.id, activeSurfaceId: 101, activePaneId: 1001 }],
  );

  assert.deepEqual(snapshot.projects[0]?.worktrees[0]?.surfaces, [
    { id: 101, title: 'Pi', paneKinds: ['agent_session'] },
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
    readWorktreeDeleteDiagnostics: () =>
      Effect.succeed({
        agentSessionCount: 0,
        agentSessionActivePtyProcessIds: [],
        commandRunCount: 0,
        commandRunPtyProcessIds: [],
        commandStateCount: 0,
        commandStateActivePtyProcessIds: [],
        paneCount: 0,
        surfaceCount: 0,
        terminalSessionCount: 0,
        terminalSessionActivePtyProcessIds: [],
      }),
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
        Effect.provideService(CommandService, testCommandService),
        Effect.provideService(PtyService, testPtyService),
        Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
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
