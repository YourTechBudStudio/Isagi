import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { CommandError, CommandService, type CommandServiceShape } from '../../commands/index.js';
import { Git, type GitService } from '../../git/index.js';
import { DataDirectory, StateFile } from '../../persistence/index.js';
import { PtyService } from '../../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { SurfaceService, SurfaceRepository } from '../../surfaces/index.js';
import { WorktreeSetupRepository, WorktreeSetupService } from '../../worktree-setup/index.js';
import type { ProjectRow } from '../types.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from '../workspace.repository.js';
import { WorkspaceError, WorkspaceService, WorkspaceServiceLive } from '../workspace.service.js';
import {
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
 * Command cleanup gates more than an explicit worktree delete.
 *
 * `cleanupBeforeWorktreePrune` runs inside `reconcileProjectWithGit`, which is
 * reached by `openWorktree`, project registration, and workspace reconciliation
 * as well. The propagation route is not new — prune already stopped running
 * commands and already mapped a failure to `command_cleanup_failed` — but the
 * audit widened *when* it fires: a historical, terminal link whose backend
 * absence cannot be verified now blocks these flows too.
 *
 * That is a deliberate safety-over-availability tradeoff. Prune owns removal of
 * the durable worktree projection; letting reconciliation continue past a failed
 * cleanup would leave a stale row that `openWorktree` later treats as a real
 * worktree. So every one of these entry points must fail closed, and — critically
 * — must preserve the rows a retry needs to find the survivor again.
 */

const cleanupFailure = (worktreeId: number) =>
  new CommandError({
    code: 'command_action_failed',
    message: `Could not account for 1 command process(es) while cleaning up worktree ${worktreeId}.`,
    worktreeId,
  });

function failingPruneCommandService(record: string[]): CommandServiceShape {
  return {
    ...testCommandService,
    cleanupBeforeWorktreePrune: (input: { readonly worktreeId: number }) =>
      Effect.gen(function* () {
        record.push(`prune:${input.worktreeId}`);
        return yield* Effect.fail(cleanupFailure(input.worktreeId));
      }),
  } satisfies CommandServiceShape;
}

// Git discovery that reports the project root and nothing else, so the persisted
// worktree becomes "missing" and reaches the prune path.
function discoveryGit(projectRoot: string, record: string[]): GitService {
  return {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        const command = args.join(' ');
        if (command.endsWith('rev-parse --show-toplevel')) {
          return { stdout: `${projectRoot}\n`, stderr: '' };
        }
        if (command.endsWith('rev-parse --git-common-dir')) {
          return { stdout: '.git\n', stderr: '' };
        }
        if (command.endsWith('worktree list --porcelain')) {
          return {
            stdout: `worktree ${projectRoot}\nHEAD abc123456789\nbranch refs/heads/main\n`,
            stderr: '',
          };
        }
        // Anything else is destructive or state-changing for these flows.
        record.push(`git:${command}`);
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;
}

function withProjectRoot(label: string, run: (projectRoot: string) => Promise<void>) {
  return async () => {
    const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), `isagi-${label}-`)));
    mkdirSync(join(projectRoot, '.git'));
    try {
      await run(projectRoot);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  };
}

interface Harness {
  readonly record: string[];
  readonly repository: WorkspaceRepositoryService;
  readonly deletedWorktreeIds: number[];
}

function harness(projectRow: ProjectRow): Harness {
  const record: string[] = [];
  const deletedWorktreeIds: number[] = [];
  const repository = {
    ...repositoryWith({ project: projectRow, worktree }),
    // One persisted worktree that Git no longer reports: the prune candidate.
    reconcileProjectWorktrees: () =>
      Effect.succeed({ added: [], missing: [{ id: worktree.id }], restored: [] }),
    deleteWorktree: (worktreeId: number) =>
      Effect.sync(() => {
        deletedWorktreeIds.push(worktreeId);
        return true;
      }),
  } as unknown as WorkspaceRepositoryService;
  return { record, repository, deletedWorktreeIds };
}

function provide<A, E>(
  effect: Effect.Effect<A, E, WorkspaceService>,
  input: {
    readonly repository: WorkspaceRepositoryService;
    readonly git: GitService;
    readonly commands: CommandServiceShape;
  },
) {
  return effect.pipe(
    Effect.provide(WorkspaceServiceLive),
    Effect.provideService(CommandService, input.commands),
    Effect.provideService(PtyService, testPtyService),
    Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
    Effect.provideService(WorkspaceRepository, input.repository),
    Effect.provideService(SurfaceRepository, testSurfaceRepository),
    Effect.provideService(SurfaceService, testSurfaceService),
    Effect.provideService(
      StateFile,
      stateFileWithWriteCounter(() => {}),
    ),
    Effect.provideService(Git, input.git),
    Effect.provideService(DataDirectory, testDataDirectory),
    Effect.provideService(WorktreeSetupService, testWorktreeSetup),
    Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
  );
}

test(
  'opening a worktree fails closed when prune cleanup cannot account for a process',
  withProjectRoot('open-gate', async (projectRoot) => {
    const { record, repository, deletedWorktreeIds } = harness({
      ...project,
      rootPath: projectRoot,
    });
    const commands = failingPruneCommandService(record);

    const error = await Effect.runPromise(
      Effect.flip(
        provide(
          Effect.gen(function* () {
            const workspace = yield* WorkspaceService;
            return yield* workspace.openWorktree({
              projectId: project.id,
              request: { branch: 'feature/new' },
            });
          }),
          { repository, git: discoveryGit(projectRoot, record), commands },
        ),
      ),
    );

    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, 'command_cleanup_failed');
    assert.equal(error.worktreeId, worktree.id);
    // The stale row survives: nothing removed it, so the retry's fresh link read
    // can still find the incarnation that blocked this attempt.
    assert.deepEqual(deletedWorktreeIds, []);
    // Branch-name validation (`check-ref-format`) legitimately runs before
    // reconciliation and is read-only. What must not have happened is any
    // attempt to recreate the checkout the failed prune left recorded.
    const gitCommands = record.filter((entry) => entry.startsWith('git:'));
    assert.ok(
      gitCommands.every((entry) => entry.includes('check-ref-format')),
      `unexpected Git work before the refusal: ${gitCommands.join(' | ')}`,
    );
    assert.ok(!gitCommands.some((entry) => entry.includes('worktree add')));
    assert.ok(record.includes(`prune:${worktree.id}`));
  }),
);

test(
  'registering a project fails closed and preserves the records a retry needs',
  withProjectRoot('add-gate', async (projectRoot) => {
    const missingProject: ProjectRow = { ...project, rootPath: projectRoot, status: 'missing' };
    const { record, repository, deletedWorktreeIds } = harness(missingProject);
    const commands = failingPruneCommandService(record);

    const error = await Effect.runPromise(
      Effect.flip(
        provide(
          Effect.gen(function* () {
            const workspace = yield* WorkspaceService;
            return yield* workspace.registerProject({ path: projectRoot });
          }),
          { repository, git: discoveryGit(projectRoot, record), commands },
        ),
      ),
    );

    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, 'command_cleanup_failed');
    assert.deepEqual(deletedWorktreeIds, []);
    assert.ok(record.includes(`prune:${worktree.id}`));
  }),
);

test(
  'workspace reconciliation fails closed rather than cascading past an unverified process',
  withProjectRoot('reconcile-gate', async (projectRoot) => {
    const { record, repository, deletedWorktreeIds } = harness({
      ...project,
      rootPath: projectRoot,
    });
    const commands = failingPruneCommandService(record);

    const error = await Effect.runPromise(
      Effect.flip(
        provide(
          Effect.gen(function* () {
            const workspace = yield* WorkspaceService;
            return yield* workspace.reconcileWorkspace({ projectId: project.id });
          }),
          { repository, git: discoveryGit(projectRoot, record), commands },
        ),
      ),
    );

    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, 'command_cleanup_failed');
    assert.equal(error.projectId, project.id);
    assert.deepEqual(deletedWorktreeIds, []);
  }),
);

test(
  'a retry completes once the process is accounted for',
  withProjectRoot('retry', async (projectRoot) => {
    // Nothing removed the stale row on the failed attempt, so the retry finds it
    // and prunes it normally.
    const { record, repository, deletedWorktreeIds } = harness({
      ...project,
      rootPath: projectRoot,
    });

    await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const workspace = yield* WorkspaceService;
          return yield* workspace.reconcileWorkspace({ projectId: project.id });
        }),
        { repository, git: discoveryGit(projectRoot, record), commands: testCommandService },
      ),
    );

    assert.deepEqual(deletedWorktreeIds, [worktree.id]);
  }),
);
