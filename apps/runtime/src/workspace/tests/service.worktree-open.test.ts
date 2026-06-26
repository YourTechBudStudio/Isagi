import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { CommandService, type CommandServiceShape } from '../../commands/index.js';
import { branchPathHash, Git, GitCommandError, type GitService } from '../../git/index.js';
import { DataDirectory, StateFile } from '../../persistence/index.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import { PtyService } from '../../pty-processes/index.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { SurfaceService, SurfaceRepository } from '../../surfaces/index.js';
import { WorktreeSetupRepository, WorktreeSetupService } from '../../worktree-setup/index.js';
import type { WorktreeRow } from '../types.js';
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

test('opening an existing local branch creates an Isagi-managed checkout and returns its worktree', async () => {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-open-worktree-project-')));
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-worktree-data-'));
  const checkoutParent = join(dataRoot, 'worktrees');
  const branch = 'feature/new';
  let created = false;
  let createdPath: string | null = null;
  let nextWorktreeId = 11;
  let worktreeRows: WorktreeRow[] = [{ ...worktree, path: projectRoot }];
  const lifecycleCalls: number[] = [];
  const testProject = { ...project, rootPath: projectRoot };
  const dataDirectory = makeTestDataDirectory(dataRoot, { worktreesPath: checkoutParent });
  const repository = {
    ...repositoryWith({ project: testProject, worktree: null }),
    findWorktree: (worktreeId: number) =>
      Effect.succeed(worktreeRows.find((row) => row.id === worktreeId) ?? null),
    findProjectWorktreeByBranch: (lookup) =>
      Effect.succeed(
        worktreeRows.find(
          (row) => row.projectId === lookup.projectId && row.branch === lookup.branch,
        ) ?? null,
      ),
    listWorktrees: Effect.sync(() => [...worktreeRows]),
    reconcileProjectWorktrees: (input) =>
      Effect.sync(() => {
        const added: { id: number; path: string; branch: string | null }[] = [];
        for (const discovered of input.discovered) {
          const existing = worktreeRows.find((row) => row.path === discovered.path);
          if (existing) {
            worktreeRows = worktreeRows.map((row) =>
              row.id === existing.id
                ? { ...row, branch: discovered.branch, head: discovered.head }
                : row,
            );
          } else {
            const row = {
              ...worktree,
              id: nextWorktreeId++,
              path: discovered.path,
              branch: discovered.branch,
              head: discovered.head,
            } satisfies WorktreeRow;
            worktreeRows = [...worktreeRows, row];
            added.push({ id: row.id, path: row.path, branch: row.branch });
          }
        }
        return { added, missing: [] };
      }),
  } satisfies WorkspaceRepositoryService;
  const stateFile = stateFileWithWriteCounter(() => {});
  const openGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        const command = args.join(' ');
        if (command.endsWith('worktree list --porcelain')) {
          return {
            stdout: `worktree ${projectRoot}\nHEAD abc123456789\nbranch refs/heads/main\n${
              created && createdPath
                ? `\nworktree ${createdPath}\nHEAD def456789012\nbranch refs/heads/${branch}\n`
                : ''
            }`,
            stderr: '',
          };
        }
        if (command.endsWith('branch --format=%(refname:short)')) {
          return { stdout: `main\n${branch}\n`, stderr: '' };
        }
        if (args[2] === 'worktree' && args[3] === 'add') {
          created = true;
          createdPath = args[4] ?? null;
          assert.equal(
            createdPath,
            join(checkoutParent, String(project.id), branchPathHash(branch)),
          );
          assert.equal(args[5], branch);
          if (createdPath) {
            mkdirSync(createdPath, { recursive: true });
          }
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;
  const commandService = {
    ...testCommandService,
    runPostCreateLifecycle: (input: { readonly worktreeId: number }) =>
      Effect.sync(() => {
        lifecycleCalls.push(input.worktreeId);
      }),
  } satisfies CommandServiceShape;

  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.openWorktree({ projectId: project.id, request: { branch } });
      }).pipe(
        Effect.provide(WorkspaceServiceLive),
        Effect.provideService(CommandService, commandService),
        Effect.provideService(PtyService, testPtyService),
        Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(SurfaceService, testSurfaceService),
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, openGit),
        Effect.provideService(DataDirectory, dataDirectory),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    );

    assert.equal(output.projectId, project.id);
    assert.equal(output.branch, branch);
    assert.equal(output.worktreeId, 11);
    assert.deepEqual(lifecycleCalls, [11]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('opening a worktree rejects invalid branch names before branch lookup', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-invalid-branch-project-'));
  const branch = 'not a branch';
  const repository = repositoryWith({
    project: { ...project, rootPath: projectRoot },
    worktree: { ...worktree, path: projectRoot },
  });
  const stateFile = stateFileWithWriteCounter(() => {});
  let branchListCalls = 0;
  const invalidGit = {
    run: (args: readonly string[], options: { readonly cwd?: string | undefined } = {}) => {
      const command = args.join(' ');
      if (command.endsWith('worktree list --porcelain')) {
        return Effect.succeed({
          stdout: `worktree ${projectRoot}\nHEAD abc123456789\nbranch refs/heads/main\n`,
          stderr: '',
        });
      }
      if (command.endsWith(`check-ref-format --branch ${branch}`)) {
        return Effect.fail(
          new GitCommandError({
            args,
            cause: new Error('invalid branch'),
            cwd: options.cwd,
            stderr: 'fatal: invalid branch name',
          }),
        );
      }
      if (command.endsWith('branch --format=%(refname:short)')) {
        branchListCalls += 1;
      }
      return Effect.succeed({ stdout: '', stderr: '' });
    },
  } satisfies GitService;

  try {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const workspace = yield* WorkspaceService;
          return yield* workspace.openWorktree({ projectId: project.id, request: { branch } });
        }).pipe(
          Effect.provide(WorkspaceServiceLive),
          Effect.provideService(CommandService, testCommandService),
          Effect.provideService(PtyService, testPtyService),
          Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
          Effect.provideService(WorkspaceRepository, repository),
          Effect.provideService(SurfaceRepository, testSurfaceRepository),
          Effect.provideService(SurfaceService, testSurfaceService),
          Effect.provideService(StateFile, stateFile),
          Effect.provideService(Git, invalidGit),
          Effect.provideService(DataDirectory, testDataDirectory),
          Effect.provideService(WorktreeSetupService, testWorktreeSetup),
          Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
        ),
      ),
    );

    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, 'invalid_branch_name');
    assert.equal(error.branch, branch);
    assert.equal(branchListCalls, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('opening an existing local branch rejects an occupied deterministic checkout path', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-dirty-worktree-project-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-dirty-worktree-data-'));
  const branch = 'feature/dirty';
  const checkoutPath = join(dataRoot, 'worktrees', String(project.id), branchPathHash(branch));
  mkdirSync(checkoutPath, { recursive: true });
  const testProject = { ...project, rootPath: projectRoot };
  const repository = repositoryWith({
    project: testProject,
    worktree: { ...worktree, path: projectRoot },
  });
  const stateFile = stateFileWithWriteCounter(() => {});
  let addCalls = 0;
  const dirtyPathGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        const command = args.join(' ');
        if (command.endsWith('worktree list --porcelain')) {
          return {
            stdout: `worktree ${projectRoot}\nHEAD abc123456789\nbranch refs/heads/main\n`,
            stderr: '',
          };
        }
        if (command.endsWith('branch --format=%(refname:short)')) {
          return { stdout: `main\n${branch}\n`, stderr: '' };
        }
        if (args[2] === 'worktree' && args[3] === 'add') {
          addCalls += 1;
        }
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;
  const dataDirectory = makeTestDataDirectory(dataRoot);

  try {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const workspace = yield* WorkspaceService;
          return yield* workspace.openWorktree({ projectId: project.id, request: { branch } });
        }).pipe(
          Effect.provide(WorkspaceServiceLive),
          Effect.provideService(CommandService, testCommandService),
          Effect.provideService(PtyService, testPtyService),
          Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
          Effect.provideService(WorkspaceRepository, repository),
          Effect.provideService(SurfaceRepository, testSurfaceRepository),
          Effect.provideService(SurfaceService, testSurfaceService),
          Effect.provideService(StateFile, stateFile),
          Effect.provideService(Git, dirtyPathGit),
          Effect.provideService(DataDirectory, dataDirectory),
          Effect.provideService(WorktreeSetupService, testWorktreeSetup),
          Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
        ),
      ),
    );

    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, 'checkout_path_exists');
    assert.equal(error.path, checkoutPath);
    assert.equal(addCalls, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('opening an existing local branch rejects a stale registered deterministic checkout path', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-registered-worktree-project-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-registered-worktree-data-'));
  const branch = 'main';
  const checkoutPath = join(dataRoot, 'worktrees', String(project.id), branchPathHash(branch));
  const testProject = { ...project, rootPath: projectRoot };
  const repository = repositoryWith({
    project: testProject,
    worktree: { ...worktree, path: projectRoot, branch: 'other' },
  });
  const stateFile = stateFileWithWriteCounter(() => {});
  let addCalls = 0;
  const registeredPathGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        const command = args.join(' ');
        if (command.endsWith('worktree list --porcelain')) {
          return {
            stdout: `worktree ${projectRoot}\nHEAD abc123456789\nbranch refs/heads/other\n\nworktree ${checkoutPath}\nHEAD def456789012\nbranch refs/heads/${branch}\nprunable gitdir file points to non-existent location\n`,
            stderr: '',
          };
        }
        if (command.endsWith('branch --format=%(refname:short)')) {
          return { stdout: `other\n${branch}\n`, stderr: '' };
        }
        if (args[2] === 'worktree' && args[3] === 'add') {
          addCalls += 1;
        }
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;
  const dataDirectory = makeTestDataDirectory(dataRoot);

  try {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const workspace = yield* WorkspaceService;
          return yield* workspace.openWorktree({ projectId: project.id, request: { branch } });
        }).pipe(
          Effect.provide(WorkspaceServiceLive),
          Effect.provideService(CommandService, testCommandService),
          Effect.provideService(PtyService, testPtyService),
          Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
          Effect.provideService(WorkspaceRepository, repository),
          Effect.provideService(SurfaceRepository, testSurfaceRepository),
          Effect.provideService(SurfaceService, testSurfaceService),
          Effect.provideService(StateFile, stateFile),
          Effect.provideService(Git, registeredPathGit),
          Effect.provideService(DataDirectory, dataDirectory),
          Effect.provideService(WorktreeSetupService, testWorktreeSetup),
          Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
        ),
      ),
    );

    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, 'checkout_path_registered');
    assert.equal(error.path, checkoutPath);
    assert.equal(addCalls, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('opening an existing local branch distinguishes checkout parent preparation failures', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-parent-failed-project-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-parent-failed-data-'));
  const branch = 'feature/parent-failed';
  writeFileSync(join(dataRoot, 'worktrees'), 'not a directory');
  const testProject = { ...project, rootPath: projectRoot };
  const repository = repositoryWith({
    project: testProject,
    worktree: { ...worktree, path: projectRoot },
  });
  const stateFile = stateFileWithWriteCounter(() => {});
  const parentFailureGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        const command = args.join(' ');
        if (command.endsWith('worktree list --porcelain')) {
          return {
            stdout: `worktree ${projectRoot}\nHEAD abc123456789\nbranch refs/heads/main\n`,
            stderr: '',
          };
        }
        if (command.endsWith('branch --format=%(refname:short)')) {
          return { stdout: `main\n${branch}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;
  const dataDirectory = makeTestDataDirectory(dataRoot);

  try {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const workspace = yield* WorkspaceService;
          return yield* workspace.openWorktree({ projectId: project.id, request: { branch } });
        }).pipe(
          Effect.provide(WorkspaceServiceLive),
          Effect.provideService(CommandService, testCommandService),
          Effect.provideService(PtyService, testPtyService),
          Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
          Effect.provideService(WorkspaceRepository, repository),
          Effect.provideService(SurfaceRepository, testSurfaceRepository),
          Effect.provideService(SurfaceService, testSurfaceService),
          Effect.provideService(StateFile, stateFile),
          Effect.provideService(Git, parentFailureGit),
          Effect.provideService(DataDirectory, dataDirectory),
          Effect.provideService(WorktreeSetupService, testWorktreeSetup),
          Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
        ),
      ),
    );

    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, 'checkout_parent_unavailable');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
