import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { CommandService } from '../../commands/index.js';
import { SurfaceService } from '../../environment/index.js';
import { InternalEvents } from '../../platform/events/index.js';
import { Git } from '../../platform/git/index.js';
import { DataDirectory } from '../../platform/persistence/index.js';
import { ProjectRepository } from '../../projects/index.js';
import { PtyService, PtyServiceError } from '../../pty-processes/index.js';
import { fakeTerminateMany } from '../../pty-processes/testing.js';
import { WorktreeDeleteDiagnosticsReader } from '../delete-diagnostics.js';
import { WorkspaceError } from '../errors.js';
import { WorkspaceService } from '../service.js';
import { WorktreeSetupRepository } from '../setup/repository.js';
import { WorktreeSetupService } from '../setup/service.js';
import { StateFile } from '../state-file.js';
import { NoProjectDeletionParticipant } from '../testing.js';
import {
  featureWorktree,
  git,
  noWorktreeDeleteDiagnostics,
  project,
  repositoryWithWorktrees,
  stateFileWithWriteCounter,
  testCommandService,
  testDataDirectory,
  testInternalEvents,
  testPtyService,
  testSurfaceService,
  testWorktreeSetup,
  testWorktreeSetupRepository,
  worktree,
} from './test-support.js';

/**
 * Deleting a project cascades away every agent and terminal session of its worktrees, so it must
 * stop their live PTY processes first, exactly as deleting one worktree does. Otherwise the shells
 * and agents keep running, owned by no row, until the PTY GC's retention or runtime shutdown.
 */

// The root worktree runs an agent (21); the feature worktree runs an agent (31) and a shell (32).
const sessionPtys = new Map([
  [worktree.id, { agents: [21], terminals: [] as number[] }],
  [featureWorktree.id, { agents: [31], terminals: [32] }],
]);

const diagnostics = WorktreeDeleteDiagnosticsReader.of({
  read: (worktreeId) => {
    const ptys = sessionPtys.get(worktreeId);
    return Effect.succeed({
      ...noWorktreeDeleteDiagnostics,
      agentSessionCount: ptys?.agents.length ?? 0,
      agentSessionActivePtyProcessIds: ptys?.agents ?? [],
      terminalSessionCount: ptys?.terminals.length ?? 0,
      terminalSessionActivePtyProcessIds: ptys?.terminals ?? [],
    });
  },
});

function deleteProjectWith(input: {
  readonly events: string[];
  readonly failPtyProcessId?: number;
}) {
  const repository = {
    ...repositoryWithWorktrees({ project, worktrees: [worktree, featureWorktree] }),
    deleteProject: (projectId: number) =>
      Effect.sync(() => {
        input.events.push(`db:${projectId}`);
        return true;
      }),
  } satisfies ProjectRepository['Service'];
  const commandService = {
    ...testCommandService,
    cleanupBeforeWorktreeDelete: (cleanup: { readonly worktreeId: number }) =>
      Effect.sync(() => {
        input.events.push(`commands:${cleanup.worktreeId}`);
      }),
  } satisfies CommandService['Service'];
  const terminate = (request: {
    readonly ptyProcessId: number;
    readonly gracefulTimeoutMs: number;
  }) =>
    Effect.gen(function* () {
      input.events.push(`pty:${request.ptyProcessId}`);
      if (request.ptyProcessId === input.failPtyProcessId) {
        return yield* new PtyServiceError({
          code: 'backend_unavailable',
          message: 'PTY backend is unavailable.',
          ptyProcessId: request.ptyProcessId,
        });
      }
      return 'terminated_live' as const;
    });
  const ptyService = {
    ...testPtyService,
    terminate,
    terminateMany: fakeTerminateMany(terminate),
  } satisfies PtyService['Service'];

  return Effect.gen(function* () {
    const workspace = yield* WorkspaceService;
    return yield* workspace.deleteProject(project.id);
  }).pipe(
    Effect.provide(WorkspaceService.layerNoDeps),
    Effect.provide(NoProjectDeletionParticipant),
    Effect.provideService(CommandService, commandService),
    Effect.provideService(PtyService, ptyService),
    Effect.provideService(InternalEvents, testInternalEvents),
    Effect.provideService(ProjectRepository, repository),
    Effect.provideService(WorktreeDeleteDiagnosticsReader, diagnostics),
    Effect.provideService(SurfaceService, testSurfaceService),
    Effect.provideService(
      StateFile,
      stateFileWithWriteCounter(() => {}),
    ),
    Effect.provideService(Git, git),
    Effect.provideService(DataDirectory, testDataDirectory),
    Effect.provideService(WorktreeSetupService, testWorktreeSetup),
    Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
  );
}

test('project delete stops every worktree session process before its rows cascade away', async () => {
  const events: string[] = [];

  const output = await Effect.runPromise(deleteProjectWith({ events }));

  assert.deepEqual(output, { projectId: project.id, deleted: true });
  // Commands first (as worktree delete does), then every session process of every worktree,
  // and only then the row delete whose cascade erases the sessions that pointed at them.
  assert.deepEqual(events.slice(0, 2), [
    `commands:${worktree.id}`,
    `commands:${featureWorktree.id}`,
  ]);
  assert.deepEqual(new Set(events.slice(2, 5)), new Set(['pty:21', 'pty:31', 'pty:32']));
  assert.deepEqual(events.slice(5), [`db:${project.id}`]);
});

test('project delete keeps the project when a session process cannot be stopped', async () => {
  const events: string[] = [];

  const error = await Effect.runPromise(
    Effect.flip(deleteProjectWith({ events, failPtyProcessId: 31 })),
  );

  assert.ok(error instanceof WorkspaceError);
  assert.equal(error.code, 'pty_teardown_failed');
  assert.equal(error.projectId, project.id);
  assert.ok(!events.includes(`db:${project.id}`), 'the project row survives a refused teardown');
});
