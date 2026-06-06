import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { workspaceSnapshotSchema } from '@isagi/contracts';

import { Git, GitCommandError } from '../git/index.js';
import { StateFile, stateFromActiveContext, type WorkspaceState } from '../persistence/index.js';
import { chooseActiveContext } from './active-context.js';
import type { ProjectRow, WorktreeRow } from './types.js';
import {
  prunedWorktreeIds,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
} from './workspace-repository.js';
import { WorkspaceService, WorkspaceServiceLive } from './workspace-service.js';
import { buildWorkspaceSnapshot } from './workspace-snapshot.js';

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

const worktreeBase = {
  id: 10,
  projectId: project.id,
  path: '/repo/isagi',
  branch: 'main',
  head: 'abc123456789',
  isRoot: 1,
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  firstSeenAt: '2026-06-04T00:00:00.000Z',
  lastSeenAt: '2026-06-04T00:00:00.000Z',
} satisfies WorktreeRow;

test('workspace snapshots serialize worktrees for present projects', () => {
  const snapshot = buildWorkspaceSnapshot([project], [worktreeBase], {
    projectId: project.id,
    worktreeId: worktreeBase.id,
  });

  assert.equal(snapshot.projects[0]?.worktrees[0]?.id, worktreeBase.id);
  assert.doesNotThrow(() => workspaceSnapshotSchema.parse(snapshot));
});

test('active context falls back to the project root when the requested worktree was pruned', () => {
  const activeContext = chooseActiveContext(
    { projectId: project.id, worktreeId: 999 },
    [project],
    [worktreeBase],
  );

  assert.deepEqual(activeContext, { projectId: project.id, worktreeId: worktreeBase.id });
});

test('workspace reconciliation prunes undiscovered linked worktree rows, not roots', () => {
  assert.deepEqual(
    prunedWorktreeIds({
      discovered: [{ path: '/repo/isagi' }],
      existing: [
        { id: 10, path: '/repo/isagi', isRoot: 1 },
        { id: 11, path: '/repo/isagi-feature', isRoot: 0 },
        { id: 12, path: '/repo/isagi-stale-root', isRoot: 1 },
      ],
    }),
    [11],
  );
});

test('workspace reconciliation keeps rows when Git discovery fails', async () => {
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
      isRoot: 0,
    },
  ];

  const repository = {
    findProjectByRootPath: () => Effect.succeed(currentProject),
    findWorktree: (worktreeId) =>
      Effect.succeed(worktrees.find((worktree) => worktree.id === worktreeId) ?? null),
    insertProject: () => Effect.succeed(project.id),
    listProjects: Effect.sync(() => [currentProject]),
    listWorktrees: Effect.succeed([...worktrees]),
    reconcileProjectWorktrees: () =>
      Effect.sync(() => {
        reconcileCalls += 1;
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
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, git),
      ),
    );

    assert.equal(reconcileCalls, 0);
    assert.equal(snapshot.projects[0]?.status, 'missing');
    assert.equal(worktrees.length, 2);
  } finally {
    console.error = originalConsoleError;
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
