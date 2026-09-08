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
  listEditorContextsForPanes: () => Effect.succeed([]),
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
  moveSurfaceOrder: () => Effect.die('surface reorder is not used by workspace snapshot tests'),
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
  moveSurfaceOrder: () => Effect.die('surface reorder is not used by workspace tests'),
  openEditor: () => Effect.die('openEditor is not used by workspace tests'),
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
} satisfies CommandServiceShape;

const testPtyService = {
  allocateLaunch: () => Effect.die('pty allocateLaunch is not used'),
  readLogTail: () => Effect.die('readLogTail is not used'),
  launch: () => Effect.die('pty launch is not used by workspace snapshot tests'),
  getAttachmentPlan: () =>
    Effect.die('pty attachment planning is not used by workspace snapshot tests'),
  attach: () => Effect.die('pty attach is not used by workspace snapshot tests'),
  replay: () => Effect.die('pty replay is not used by workspace snapshot tests'),
  write: () => Effect.die('pty write is not used by workspace snapshot tests'),
  writeInput: () => Effect.die('pty write input is not used by workspace snapshot tests'),
  resize: () => Effect.die('pty resize is not used by workspace snapshot tests'),
  kill: () => Effect.succeed('terminated_live' as const),
  terminate: () => Effect.succeed('terminated_live' as const),
  pin: () => Effect.void,
  unpin: () => Effect.void,
  cleanupProcess: () => Effect.die('pty cleanupProcess is not used'),
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
  kind: 'git',
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

test('workspace snapshots pin the derived root first without resorting the other worktrees', () => {
  const feature = { ...worktreeBase, id: 11, path: '/repo/isagi-feature', branch: 'feature/one' };
  const chore = { ...worktreeBase, id: 12, path: '/repo/isagi-chore', branch: 'chore/two' };

  // Rows arrive with the root in the middle and the non-roots deliberately not
  // in identifier order, so a re-sort would be visible.
  const snapshot = buildWorkspaceSnapshot([project], [chore, worktreeBase, feature]);

  assert.deepEqual(
    snapshot.projects[0]?.worktrees.map((worktree) => worktree.id),
    [worktreeBase.id, chore.id, feature.id],
  );
  assert.equal(snapshot.projects[0]?.worktrees[0]?.isRoot, true);
  assert.doesNotThrow(() => Schema.decodeUnknownSync(workspaceSnapshotSchema)(snapshot));
});

/**
 * Project kind is a required wire fact on every project, of either kind and in
 * either status. These assert the production builder actually projects it and
 * that the shared schema rejects a snapshot that omits it or spells it wrong —
 * the runtime and the web ship together, so an absent kind is a broken build,
 * never something a client should tolerate.
 */
test('workspace snapshots carry project kind for both kinds in both statuses', () => {
  const folder = {
    ...project,
    id: 2,
    name: 'notes',
    rootPath: '/work/notes',
    kind: 'folder',
  } satisfies ProjectRow;
  const folderEnvironment = {
    ...worktreeBase,
    id: 20,
    projectId: folder.id,
    path: folder.rootPath,
    branch: null,
    head: null,
  } satisfies WorktreeRow;
  const missingFolder = {
    ...folder,
    id: 3,
    status: 'missing',
    missingReason: 'The folder is not on disk.',
  } satisfies ProjectRow;
  const missingGit = {
    ...project,
    id: 4,
    status: 'missing',
    missingReason: 'The repository is not on disk.',
  } satisfies ProjectRow;

  const snapshot = buildWorkspaceSnapshot(
    [project, folder, missingFolder, missingGit],
    [worktreeBase, folderEnvironment],
  );

  assert.deepEqual(
    snapshot.projects.map((candidate) => [candidate.status, candidate.kind]),
    [
      ['present', 'git'],
      ['present', 'folder'],
      ['missing', 'folder'],
      ['missing', 'git'],
    ],
  );
  // A folder environment is an ordinary branchless row whose path is the project
  // root, so the existing derived root-ness applies to it unchanged.
  assert.equal(snapshot.projects[1]?.worktrees[0]?.isRoot, true);
  assert.equal(snapshot.projects[1]?.worktrees[0]?.branch, null);
  assert.doesNotThrow(() => Schema.decodeUnknownSync(workspaceSnapshotSchema)(snapshot));
});

test('the workspace snapshot schema rejects a project whose kind is absent or unknown', () => {
  const valid = buildWorkspaceSnapshot([project], [worktreeBase]);
  // Guards the two negative cases below from passing for some unrelated reason.
  assert.doesNotThrow(() => Schema.decodeUnknownSync(workspaceSnapshotSchema)(valid));

  const [encoded] = valid.projects;
  assert.ok(encoded);
  const { kind: _omitted, ...withoutKind } = encoded;

  assert.throws(() =>
    Schema.decodeUnknownSync(workspaceSnapshotSchema)({ projects: [withoutKind] }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(workspaceSnapshotSchema)({
      projects: [{ ...withoutKind, kind: 'repository' }],
    }),
  );
});

test('workspace snapshots preserve worktree order when no worktree is the project root', () => {
  const feature = { ...worktreeBase, id: 11, path: '/repo/isagi-feature', branch: 'feature/one' };
  const chore = { ...worktreeBase, id: 12, path: '/repo/isagi-chore', branch: 'chore/two' };

  const snapshot = buildWorkspaceSnapshot(
    [{ ...project, rootPath: '/repo/isagi-relocated' }],
    [chore, feature],
  );

  assert.deepEqual(
    snapshot.projects[0]?.worktrees.map((worktree) => worktree.id),
    [chore.id, feature.id],
  );
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
    listDurableSessions: Effect.succeed({ sessions: [] }),
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
    createProject: () => Effect.succeed(project),
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
    moveProjectOrder: () => Effect.die('project reorder is not used by workspace snapshot tests'),
    moveProjectWorktreeOrder: () =>
      Effect.die('worktree reorder is not used by workspace snapshot tests'),
  } satisfies WorkspaceRepositoryService;

  const git = {
    run: (args: readonly string[], options: { readonly cwd?: string | undefined } = {}) =>
      Effect.fail(
        new GitCommandError({
          args,
          cause: new Error('Git failed'),
          cwd: options.cwd,
          failure: { kind: 'exited', exitCode: 128 },
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
