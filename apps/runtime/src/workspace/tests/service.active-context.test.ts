import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { CommandService } from '../../commands/index.js';
import { Git } from '../../git/index.js';
import { DataDirectory, StateFile, stateFromActiveContext } from '../../persistence/index.js';
import { PtyService } from '../../pty-processes/index.js';
import {
  InternalRuntimeEventBus,
  type InternalRuntimeEventBusService,
} from '../../runtime-events/index.js';
import { SurfaceService, SurfaceRepository } from '../../surfaces/index.js';
import { WorktreeSetupRepository, WorktreeSetupService } from '../../worktree-setup/index.js';
import { WorkspaceRepository } from '../workspace.repository.js';
import { WorkspaceService, WorkspaceServiceLive } from '../workspace.service.js';
import {
  featureWorktree,
  git,
  project,
  repositoryWith,
  repositoryWithWorktrees,
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

test('active context persistence validates before writing state', async () => {
  let writeCalls = 0;
  const stateFile = stateFileWithWriteCounter(() => {
    writeCalls += 1;
  });
  const repository = repositoryWith({ project: null, worktree });

  await assert.rejects(
    Effect.runPromise(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.setActiveContext({
          activeContext: { projectId: project.id, worktreeId: worktree.id },
          revision: 1,
        });
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
    ),
  );

  assert.equal(writeCalls, 0);
});

test('valid active context persistence writes after validation', async () => {
  let writeCalls = 0;
  const stateFile = stateFileWithWriteCounter(() => {
    writeCalls += 1;
  });
  const repository = repositoryWith({ project, worktree });

  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      return yield* workspace.setActiveContext({
        activeContext: { projectId: project.id, worktreeId: worktree.id },
        revision: 1,
      });
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

  assert.equal(writeCalls, 1);
  assert.deepEqual(output.activeContext, { projectId: project.id, worktreeId: worktree.id });
});

test('active context persistence publishes internal activation changes for accepted transitions', async () => {
  const previous = { ...featureWorktree, id: 11 };
  const stateFile = stateFileWithWriteCounter(
    () => {},
    stateFromActiveContext(project.id, previous.id, 1),
  );
  const repository = repositoryWithWorktrees({
    project,
    worktrees: [worktree, previous],
  });
  const events: unknown[] = [];
  const internalEvents = {
    ...testInternalEvents,
    publish: (event: unknown) =>
      Effect.sync(() => {
        events.push(event);
      }),
  } satisfies InternalRuntimeEventBusService;

  await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      return yield* workspace.setActiveContext({
        activeContext: { projectId: project.id, worktreeId: worktree.id },
        revision: 2,
      });
    }).pipe(
      Effect.provide(WorkspaceServiceLive),
      Effect.provideService(CommandService, testCommandService),
      Effect.provideService(PtyService, testPtyService),
      Effect.provideService(InternalRuntimeEventBus, internalEvents),
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

  assert.deepEqual(events, [
    {
      type: 'worktree_activation_change',
      previousWorktreeId: previous.id,
      nextWorktreeId: worktree.id,
      cause: 'active_context_changed',
    },
  ]);
});
