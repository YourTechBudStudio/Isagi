import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { CommandService } from '../../commands/index.js';
import { Git } from '../../git/index.js';
import { DataDirectory, StateFile } from '../../persistence/index.js';
import { PtyService } from '../../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { SurfaceRepository, SurfaceService } from '../../surfaces/index.js';
import { WorktreeSetupRepository, WorktreeSetupService } from '../../worktree-setup/index.js';
import {
  WorkspaceRepository,
  type ProjectOrderMoveResult,
  type WorkspaceRepositoryService,
  type WorktreeOrderMoveResult,
} from '../workspace.repository.js';
import {
  ProjectOrderError,
  WorkspaceService,
  WorkspaceServiceLive,
  WorktreeOrderError,
} from '../workspace.service.js';
import {
  git,
  project,
  repositoryWith,
  stateFileWithWriteCounter,
  testCommandService,
  testDataDirectory,
  testInternalEvents,
  testPtyService,
  testSurfaceRepository,
  testSurfaceService,
  testWorktreeSetup,
  testWorktreeSetupRepository,
  worktree,
} from './test-support.js';

/**
 * The repository owns validation; the service only turns its typed rejection
 * into a tagged domain error and its acceptance into the minimal output. These
 * tests pin that translation — including that the service does not re-read
 * anything on its own, which is asserted by counting repository calls.
 *
 * The accepted moves and every rejection reason are proved against a real
 * database in `repository.reorder.test.ts`.
 */

function runWithRepository<A, E>(
  repository: WorkspaceRepositoryService,
  build: Effect.Effect<A, E, WorkspaceService>,
) {
  return Effect.runPromise(
    build.pipe(
      Effect.provide(WorkspaceServiceLive),
      Effect.provideService(CommandService, testCommandService),
      Effect.provideService(PtyService, testPtyService),
      Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
      Effect.provideService(WorkspaceRepository, repository),
      Effect.provideService(SurfaceRepository, testSurfaceRepository),
      Effect.provideService(SurfaceService, testSurfaceService),
      Effect.provideService(
        StateFile,
        stateFileWithWriteCounter(() => {}),
      ),
      Effect.provideService(Git, git),
      Effect.provideService(DataDirectory, testDataDirectory),
      Effect.provideService(WorktreeSetupService, testWorktreeSetup),
      Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
    ),
  );
}

function orderRepository(overrides: {
  readonly project?: ProjectOrderMoveResult;
  readonly worktree?: WorktreeOrderMoveResult;
  readonly onCall?: (name: string) => void;
}): WorkspaceRepositoryService {
  const base = repositoryWith({ project, worktree });
  return {
    ...base,
    findProject: (projectId) => {
      overrides.onCall?.('findProject');
      return base.findProject(projectId);
    },
    findWorktree: (worktreeId) => {
      overrides.onCall?.('findWorktree');
      return base.findWorktree(worktreeId);
    },
    findProjectWorktree: (input) => {
      overrides.onCall?.('findProjectWorktree');
      return base.findProjectWorktree(input);
    },
    moveProjectOrder: () => {
      overrides.onCall?.('moveProjectOrder');
      return Effect.succeed(overrides.project ?? { status: 'moved' });
    },
    moveProjectWorktreeOrder: () => {
      overrides.onCall?.('moveProjectWorktreeOrder');
      return Effect.succeed(overrides.worktree ?? { status: 'moved' });
    },
  };
}

test('an accepted project move returns only the moved identifier', async () => {
  const output = await runWithRepository(
    orderRepository({ project: { status: 'moved' } }),
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      return yield* workspace.moveProjectOrder({ projectId: 7, beforeProjectId: 9 });
    }),
  );

  assert.deepEqual(output, { projectId: 7 });
});

test('the project move reaches the repository without any preceding read', async () => {
  const calls: string[] = [];
  await runWithRepository(
    orderRepository({ onCall: (name) => calls.push(name) }),
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      return yield* workspace.moveProjectOrder({ projectId: 7, beforeProjectId: null });
    }),
  );

  // One validation site. A service-level pre-read would be a second, and could
  // disagree with the rows the transaction actually sees.
  assert.deepEqual(calls, ['moveProjectOrder']);
});

test('a rejected project move becomes a tagged error carrying the contract reason', async () => {
  const error = await runWithRepository(
    orderRepository({ project: { status: 'rejected', reason: 'before_project_not_present' } }),
    Effect.flip(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.moveProjectOrder({ projectId: 7, beforeProjectId: 9 });
      }),
    ),
  );

  assert.ok(error instanceof ProjectOrderError);
  assert.equal(error.reason, 'before_project_not_present');
  assert.equal(error.projectId, 7);
  assert.equal(error.beforeProjectId, 9);
  assert.ok(error.message.length > 0);
});

test('a rejected project move with a null anchor omits the anchor identifier', async () => {
  const error = await runWithRepository(
    orderRepository({ project: { status: 'rejected', reason: 'project_not_found' } }),
    Effect.flip(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.moveProjectOrder({ projectId: 7, beforeProjectId: null });
      }),
    ),
  );

  assert.ok(error instanceof ProjectOrderError);
  assert.equal(error.beforeProjectId, undefined);
});

test('an accepted worktree move returns the project and worktree identifiers', async () => {
  const output = await runWithRepository(
    orderRepository({ worktree: { status: 'moved' } }),
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      return yield* workspace.moveWorktreeOrder({
        projectId: 1,
        worktreeId: 11,
        beforeWorktreeId: null,
      });
    }),
  );

  assert.deepEqual(output, { projectId: 1, worktreeId: 11 });
});

test('a rejected worktree move becomes a tagged error carrying the contract reason', async () => {
  const error = await runWithRepository(
    orderRepository({ worktree: { status: 'rejected', reason: 'root_worktree_fixed' } }),
    Effect.flip(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.moveWorktreeOrder({
          projectId: 1,
          worktreeId: 10,
          beforeWorktreeId: 11,
        });
      }),
    ),
  );

  assert.ok(error instanceof WorktreeOrderError);
  assert.equal(error.reason, 'root_worktree_fixed');
  assert.equal(error.projectId, 1);
  assert.equal(error.worktreeId, 10);
  assert.equal(error.beforeWorktreeId, 11);
});

test('the worktree move reaches the repository without any preceding read', async () => {
  const calls: string[] = [];
  await runWithRepository(
    orderRepository({ onCall: (name) => calls.push(name) }),
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      return yield* workspace.moveWorktreeOrder({
        projectId: 1,
        worktreeId: 11,
        beforeWorktreeId: null,
      });
    }),
  );

  assert.deepEqual(calls, ['moveProjectWorktreeOrder']);
});
