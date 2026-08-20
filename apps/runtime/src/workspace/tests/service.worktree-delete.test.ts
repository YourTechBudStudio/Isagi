import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { CommandError, CommandService, type CommandServiceShape } from '../../commands/index.js';
import { Git, GitCommandError, type GitService } from '../../git/index.js';
import { DataDirectory, StateFile } from '../../persistence/index.js';
import { PtyService, PtyServiceError, type PtyServiceShape } from '../../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { SurfaceService, SurfaceRepository } from '../../surfaces/index.js';
import { WorktreeSetupRepository, WorktreeSetupService } from '../../worktree-setup/index.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from '../workspace.repository.js';
import { WorkspaceError, WorkspaceService, WorkspaceServiceLive } from '../workspace.service.js';
import {
  deleteFixtures,
  recordingInternalEvents,
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
} from './test-support.js';

test('delete worktree rejects dirty checkout in normal mode before removal', async () => {
  const fixtures = deleteFixtures();
  let deleteCalls = 0;
  const commands: string[][] = [];
  const repository = {
    ...repositoryWithWorktrees({
      project: fixtures.project,
      worktrees: [fixtures.rootWorktree, fixtures.targetWorktree],
    }),
    deleteWorktree: () =>
      Effect.sync(() => {
        deleteCalls += 1;
        return true;
      }),
  } satisfies WorkspaceRepositoryService;
  const dirtyGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        commands.push([...args]);
        if (args.includes('status')) {
          return { stdout: ' M src/index.ts\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.deleteWorktree({
          projectId: fixtures.project.id,
          worktreeId: fixtures.targetWorktree.id,
          request: { checkoutRemovalMode: 'normal', branchRemovalMode: 'preserve' },
        });
      }).pipe(
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
        Effect.provideService(Git, dirtyGit),
        Effect.provideService(DataDirectory, testDataDirectory),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    ),
  );

  assert.ok(error instanceof WorkspaceError);
  assert.equal(error.code, 'dirty_checkout_requires_force');
  assert.equal(deleteCalls, 0);
  assert.equal(
    commands.some((args) => args.includes('remove')),
    false,
  );
  fixtures.cleanup();
});

test('delete worktree force removes checkout before deleting DB row and returns root selection', async () => {
  const fixtures = deleteFixtures();
  const events: string[] = [];
  const repository = {
    ...repositoryWithWorktrees({
      project: fixtures.project,
      worktrees: [fixtures.rootWorktree, fixtures.targetWorktree],
    }),
    deleteWorktree: (worktreeId: number) =>
      Effect.sync(() => {
        events.push(`db:${worktreeId}`);
        return true;
      }),
    readWorktreeDeleteDiagnostics: () =>
      Effect.succeed({
        agentSessionCount: 1,
        agentSessionActivePtyProcessIds: [21],
        commandRunCount: 0,
        commandRunPtyProcessIds: [],
        commandStateCount: 0,
        commandStateActivePtyProcessIds: [],
        paneCount: 2,
        surfaceCount: 1,
        terminalSessionCount: 1,
        terminalSessionActivePtyProcessIds: [22],
      }),
  } satisfies WorkspaceRepositoryService;
  const deleteGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        if (args.includes('status')) {
          return { stdout: '?? scratch.txt\n', stderr: '' };
        }
        events.push(`git:${args.join(' ')}`);
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;
  const commandService = {
    ...testCommandService,
    cleanupBeforeWorktreeDelete: (input: { readonly worktreeId: number }) =>
      Effect.sync(() => {
        events.push(`commands:${input.worktreeId}`);
      }),
  } satisfies CommandServiceShape;
  const ptyService = {
    ...testPtyService,
    terminate: (input: { readonly ptyProcessId: number; readonly gracefulTimeoutMs: number }) =>
      Effect.sync(() => {
        events.push(`pty:${input.ptyProcessId}:${input.gracefulTimeoutMs}`);
        return 'terminated_live' as const;
      }),
  } satisfies PtyServiceShape;

  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      return yield* workspace.deleteWorktree({
        projectId: fixtures.project.id,
        worktreeId: fixtures.targetWorktree.id,
        request: { checkoutRemovalMode: 'force', branchRemovalMode: 'preserve' },
      });
    }).pipe(
      Effect.provide(WorkspaceServiceLive),
      Effect.provideService(CommandService, commandService),
      Effect.provideService(PtyService, ptyService),
      Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
      Effect.provideService(WorkspaceRepository, repository),
      Effect.provideService(SurfaceRepository, testSurfaceRepository),
      Effect.provideService(SurfaceService, testSurfaceService),
      Effect.provideService(
        StateFile,
        stateFileWithWriteCounter(() => {}),
      ),
      Effect.provideService(Git, deleteGit),
      Effect.provideService(DataDirectory, testDataDirectory),
      Effect.provideService(WorktreeSetupService, testWorktreeSetup),
      Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
    ),
  );

  assert.deepEqual(output, {
    projectId: fixtures.project.id,
    deletedWorktreeId: fixtures.targetWorktree.id,
    selectedWorktreeId: fixtures.rootWorktree.id,
    branchRemoval: { status: 'not_requested' },
  });
  assert.deepEqual(events, [
    `commands:${fixtures.targetWorktree.id}`,
    'pty:21:1000',
    'pty:22:1000',
    `git:-C ${fixtures.project.rootPath} worktree remove --force ${fixtures.targetWorktree.path}`,
    `db:${fixtures.targetWorktree.id}`,
  ]);
  fixtures.cleanup();
});

test('delete worktree announces every durable session it cascaded away', async () => {
  const fixtures = deleteFixtures();
  const order: string[] = [];
  const bus = recordingInternalEvents();
  const doomed = [
    { kind: 'agent_session' as const, sessionId: 41, worktreeId: fixtures.targetWorktree.id },
    { kind: 'terminal_session' as const, sessionId: 42, worktreeId: fixtures.targetWorktree.id },
  ];
  const repository = {
    ...repositoryWithWorktrees({
      project: fixtures.project,
      worktrees: [fixtures.rootWorktree, fixtures.targetWorktree],
      durableSessions: [
        ...doomed,
        // A session in a worktree that survives must never be announced as deleted.
        { kind: 'agent_session' as const, sessionId: 43, worktreeId: fixtures.rootWorktree.id },
      ],
    }),
    deleteWorktree: () =>
      Effect.sync(() => {
        order.push('db_delete');
        return true;
      }),
  } satisfies WorkspaceRepositoryService;
  const deleteGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() =>
        args.includes('status') ? { stdout: '', stderr: '' } : { stdout: '', stderr: '' },
      ),
  } satisfies GitService;

  await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      return yield* workspace.deleteWorktree({
        projectId: fixtures.project.id,
        worktreeId: fixtures.targetWorktree.id,
        request: { checkoutRemovalMode: 'normal', branchRemovalMode: 'preserve' },
      });
    }).pipe(
      Effect.provide(WorkspaceServiceLive),
      Effect.provideService(CommandService, testCommandService),
      Effect.provideService(PtyService, testPtyService),
      Effect.provideService(InternalRuntimeEventBus, {
        ...bus.service,
        publish: (event) =>
          Effect.sync(() => {
            order.push(`publish:${event.type}`);
          }).pipe(Effect.zipRight(bus.service.publish(event))),
      }),
      Effect.provideService(WorkspaceRepository, repository),
      Effect.provideService(SurfaceRepository, testSurfaceRepository),
      Effect.provideService(SurfaceService, testSurfaceService),
      Effect.provideService(
        StateFile,
        stateFileWithWriteCounter(() => {}),
      ),
      Effect.provideService(Git, deleteGit),
      Effect.provideService(DataDirectory, testDataDirectory),
      Effect.provideService(WorktreeSetupService, testWorktreeSetup),
      Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
    ),
  );

  assert.deepEqual(
    bus.published,
    doomed.map((identity) => ({ type: 'durable_session_deleted', identity })),
  );
  // Announced only after the cascade committed, so no client can re-fetch the rows back.
  assert.deepEqual(order, [
    'db_delete',
    'publish:durable_session_deleted',
    'publish:durable_session_deleted',
  ]);
  fixtures.cleanup();
});

test('delete worktree stops before Git removal when active PTY teardown fails', async () => {
  const fixtures = deleteFixtures();
  const events: string[] = [];
  let dbDeleteCalls = 0;
  const repository = {
    ...repositoryWithWorktrees({
      project: fixtures.project,
      worktrees: [fixtures.rootWorktree, fixtures.targetWorktree],
    }),
    deleteWorktree: () =>
      Effect.sync(() => {
        dbDeleteCalls += 1;
        events.push('db');
        return true;
      }),
    readWorktreeDeleteDiagnostics: () =>
      Effect.succeed({
        agentSessionCount: 1,
        agentSessionActivePtyProcessIds: [21],
        commandRunCount: 0,
        commandRunPtyProcessIds: [],
        commandStateCount: 0,
        commandStateActivePtyProcessIds: [],
        paneCount: 1,
        surfaceCount: 1,
        terminalSessionCount: 1,
        terminalSessionActivePtyProcessIds: [22],
      }),
  } satisfies WorkspaceRepositoryService;
  const deleteGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        if (args.includes('status')) {
          return { stdout: '', stderr: '' };
        }
        events.push(`git:${args.join(' ')}`);
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;
  const commandService = {
    ...testCommandService,
    cleanupBeforeWorktreeDelete: () =>
      Effect.sync(() => {
        events.push('commands');
      }),
  } satisfies CommandServiceShape;
  const ptyService = {
    ...testPtyService,
    terminate: (input: { readonly ptyProcessId: number; readonly gracefulTimeoutMs: number }) =>
      Effect.gen(function* () {
        events.push(`pty:${input.ptyProcessId}`);
        if (input.ptyProcessId === 21) {
          return yield* Effect.fail(
            new PtyServiceError({
              code: 'backend_unavailable',
              message: 'PTY backend is unavailable.',
              ptyProcessId: input.ptyProcessId,
            }),
          );
        }
        return 'terminated_live' as const;
      }),
  } satisfies PtyServiceShape;

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.deleteWorktree({
          projectId: fixtures.project.id,
          worktreeId: fixtures.targetWorktree.id,
          request: { checkoutRemovalMode: 'normal', branchRemovalMode: 'preserve' },
        });
      }).pipe(
        Effect.provide(WorkspaceServiceLive),
        Effect.provideService(CommandService, commandService),
        Effect.provideService(PtyService, ptyService),
        Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(SurfaceService, testSurfaceService),
        Effect.provideService(
          StateFile,
          stateFileWithWriteCounter(() => {}),
        ),
        Effect.provideService(Git, deleteGit),
        Effect.provideService(DataDirectory, testDataDirectory),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    ),
  );

  assert.ok(error instanceof WorkspaceError);
  assert.equal(error.code, 'pty_teardown_failed');
  assert.equal(dbDeleteCalls, 0);
  assert.deepEqual(
    events.filter((event) => event.startsWith('git:') || event === 'db'),
    [],
  );
  assert.deepEqual(new Set(events), new Set(['commands', 'pty:21', 'pty:22']));
  fixtures.cleanup();
});

test('delete worktree refuses the cascade when command cleanup cannot account for a process', async () => {
  // The command domain's audit is what proves no observable command process
  // survives a delete. When it cannot, the workspace must refuse before any
  // destructive work — the worktree's rows, including every link to the
  // unresolved incarnation, have to still be there for the user's retry.
  const fixtures = deleteFixtures();
  const events: string[] = [];
  let dbDeleteCalls = 0;
  const repository = {
    ...repositoryWithWorktrees({
      project: fixtures.project,
      worktrees: [fixtures.rootWorktree, fixtures.targetWorktree],
    }),
    deleteWorktree: () =>
      Effect.sync(() => {
        dbDeleteCalls += 1;
        events.push('db');
        return true;
      }),
  } satisfies WorkspaceRepositoryService;
  const deleteGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        if (args.includes('status')) return { stdout: '', stderr: '' };
        events.push(`git:${args.join(' ')}`);
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;
  const commandService = {
    ...testCommandService,
    cleanupBeforeWorktreeDelete: () =>
      Effect.gen(function* () {
        events.push('commands');
        return yield* Effect.fail(
          new CommandError({
            code: 'command_action_failed',
            message: 'Could not account for 1 command process(es) while cleaning up worktree 2.',
            worktreeId: fixtures.targetWorktree.id,
          }),
        );
      }),
  } satisfies CommandServiceShape;

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.deleteWorktree({
          projectId: fixtures.project.id,
          worktreeId: fixtures.targetWorktree.id,
          request: { checkoutRemovalMode: 'normal', branchRemovalMode: 'preserve' },
        });
      }).pipe(
        Effect.provide(WorkspaceServiceLive),
        Effect.provideService(CommandService, commandService),
        Effect.provideService(PtyService, testPtyService),
        Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(SurfaceService, testSurfaceService),
        Effect.provideService(
          StateFile,
          stateFileWithWriteCounter(() => {}),
        ),
        Effect.provideService(Git, deleteGit),
        Effect.provideService(DataDirectory, testDataDirectory),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    ),
  );

  assert.ok(error instanceof WorkspaceError);
  assert.equal(error.code, 'command_cleanup_failed');
  assert.equal(error.worktreeId, fixtures.targetWorktree.id);
  assert.equal(dbDeleteCalls, 0);
  assert.deepEqual(events, ['commands'], 'nothing destructive may run after the refusal');
  fixtures.cleanup();
});

test('delete worktree reports safe branch deletion failure as partial success', async () => {
  const fixtures = deleteFixtures();
  const repository = repositoryWithWorktrees({
    project: fixtures.project,
    worktrees: [fixtures.rootWorktree, fixtures.targetWorktree],
  });
  const branchGit = {
    run: (args: readonly string[]) => {
      if (args.includes('status')) {
        return Effect.succeed({ stdout: '', stderr: '' });
      }
      if (args.includes('branch')) {
        return Effect.fail(
          new GitCommandError({
            args,
            cause: new Error('branch not merged'),
            cwd: undefined,
            stderr: 'error: The branch is not fully merged.',
          }),
        );
      }
      return Effect.succeed({ stdout: '', stderr: '' });
    },
  } satisfies GitService;

  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      return yield* workspace.deleteWorktree({
        projectId: fixtures.project.id,
        worktreeId: fixtures.targetWorktree.id,
        request: { checkoutRemovalMode: 'normal', branchRemovalMode: 'delete_if_safe' },
      });
    }).pipe(
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
      Effect.provideService(Git, branchGit),
      Effect.provideService(DataDirectory, testDataDirectory),
      Effect.provideService(WorktreeSetupService, testWorktreeSetup),
      Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
    ),
  );

  assert.deepEqual(output.branchRemoval, {
    status: 'failed',
    branch: 'feature/delete-me',
    diagnostic: 'error: The branch is not fully merged.',
  });
  fixtures.cleanup();
});

test('delete worktree rejects before destructive work when root fallback is missing', async () => {
  const fixtures = deleteFixtures();
  const repository = repositoryWithWorktrees({
    project: fixtures.project,
    worktrees: [fixtures.targetWorktree],
  });
  const quietGit = {
    run: () => Effect.succeed({ stdout: '', stderr: '' }),
  } satisfies GitService;

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.deleteWorktree({
          projectId: fixtures.project.id,
          worktreeId: fixtures.targetWorktree.id,
          request: { checkoutRemovalMode: 'normal', branchRemovalMode: 'preserve' },
        });
      }).pipe(
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
        Effect.provideService(Git, quietGit),
        Effect.provideService(DataDirectory, testDataDirectory),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    ),
  );

  assert.ok(error instanceof WorkspaceError);
  assert.equal(error.code, 'root_worktree_not_found');
  fixtures.cleanup();
});
