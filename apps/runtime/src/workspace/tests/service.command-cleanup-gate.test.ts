import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { CommandError, CommandService } from '../../commands/index.js';
import { SurfaceService } from '../../environment/index.js';
import { InternalEvents } from '../../platform/events/index.js';
import { Git } from '../../platform/git/index.js';
import { DataDirectory } from '../../platform/persistence/index.js';
import { ProjectRepository } from '../../projects/index.js';
import type { ProjectRow } from '../../projects/index.js';
import { PtyService } from '../../pty-processes/index.js';
import { WorktreeDeleteDiagnosticsReader } from '../delete-diagnostics.js';
import { WorkspaceError, WorkspaceService } from '../service.js';
import { WorktreeSetupRepository } from '../setup/repository.js';
import { WorktreeSetupService } from '../setup/service.js';
import { StateFile } from '../state-file.js';
import { NoProjectDeletionParticipant } from '../testing.js';
import {
  project,
  repositoryWith,
  stateFileWithWriteCounter,
  testCommandService,
  testDataDirectory,
  testInternalEvents,
  testPtyService,
  testWorktreeDeleteDiagnostics,
  testSurfaceService,
  testWorktreeSetup,
  testWorktreeSetupRepository,
  worktree,
} from './test-support.js';

/**
 * Command cleanup gates more than an explicit worktree delete.
 *
 * `cleanupBeforeWorktreePrune` runs inside `reconcileGitProject`, reached
 * through the `reconcileProject` dispatcher from `openWorktree`, project
 * registration, and workspace reconciliation as well. The folder branch never
 * prunes, so it never reaches this gate. The propagation route is not new — prune already stopped running
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

function failingPruneCommandService(record: string[]): CommandService['Service'] {
  return {
    ...testCommandService,
    cleanupBeforeWorktreePrune: (input: { readonly worktreeId: number }) =>
      Effect.gen(function* () {
        record.push(`prune:${input.worktreeId}`);
        return yield* Effect.fail(cleanupFailure(input.worktreeId));
      }),
  } satisfies CommandService['Service'];
}

// Git discovery that reports the project root and nothing else, so the persisted
// worktree becomes "missing" and reaches the prune path.
function discoveryGit(projectRoot: string, record: string[]): Git['Service'] {
  return {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        const command = args.join(' ');
        if (command.endsWith('rev-parse --is-bare-repository')) {
          return { stdout: 'false\n', stderr: '' };
        }
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
  } satisfies Git['Service'];
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
  readonly repository: ProjectRepository['Service'];
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
  } as unknown as ProjectRepository['Service'];
  return { record, repository, deletedWorktreeIds };
}

function provide<A, E>(
  effect: Effect.Effect<A, E, WorkspaceService>,
  input: {
    readonly repository: ProjectRepository['Service'];
    readonly git: Git['Service'];
    readonly commands: CommandService['Service'];
  },
) {
  return effect.pipe(
    Effect.provide(WorkspaceService.layerNoDeps),
    Effect.provide(NoProjectDeletionParticipant),
    Effect.provideService(CommandService, input.commands),
    Effect.provideService(PtyService, testPtyService),
    Effect.provideService(InternalEvents, testInternalEvents),
    Effect.provideService(ProjectRepository, input.repository),
    Effect.provideService(WorktreeDeleteDiagnosticsReader, testWorktreeDeleteDiagnostics),
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
