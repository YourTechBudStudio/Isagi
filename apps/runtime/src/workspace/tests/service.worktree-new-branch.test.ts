import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { CommandService } from '../../commands/index.js';
import { branchPathHash, Git, type GitService } from '../../git/index.js';
import { DataDirectory, StateFile } from '../../persistence/index.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
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
  testSurfaceRepository,
  testSurfaceService,
  testWorktreeSetup,
  testWorktreeSetupRepository,
  worktree,
} from './test-support.js';

test('opening a missing branch without a base asks the client for base selection', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-missing-base-project-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-missing-base-data-'));
  const branch = 'feature/new';
  const repository = repositoryWith({
    project: { ...project, rootPath: projectRoot },
    worktree: { ...worktree, path: projectRoot },
  });
  const stateFile = stateFileWithWriteCounter(() => {});
  let addCalls = 0;
  const missingBaseGit = {
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
          return { stdout: 'main\n', stderr: '' };
        }
        if (command.endsWith(`check-ref-format --branch ${branch}`)) {
          return { stdout: `${branch}\n`, stderr: '' };
        }
        if (args[2] === 'worktree' && args[3] === 'add') {
          addCalls += 1;
        }
        return { stdout: '', stderr: '' };
      }),
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
          Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
          Effect.provideService(WorkspaceRepository, repository),
          Effect.provideService(SurfaceRepository, testSurfaceRepository),
          Effect.provideService(SurfaceService, testSurfaceService),
          Effect.provideService(StateFile, stateFile),
          Effect.provideService(Git, missingBaseGit),
          Effect.provideService(DataDirectory, makeTestDataDirectory(dataRoot)),
          Effect.provideService(WorktreeSetupService, testWorktreeSetup),
          Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
        ),
      ),
    );

    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, 'new_branch_requires_base');
    assert.equal(error.branch, branch);
    assert.equal(addCalls, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('opening a missing branch creates it from a local branch base', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-new-branch-project-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-new-branch-data-'));
  const checkoutParent = join(dataRoot, 'worktrees');
  const branch = 'feature/from-main';
  let created = false;
  let createdPath: string | null = null;
  let worktreeRows: WorktreeRow[] = [{ ...worktree, path: projectRoot }];
  const repository = {
    ...repositoryWith({ project: { ...project, rootPath: projectRoot }, worktree: null }),
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
          if (worktreeRows.some((row) => row.path === discovered.path)) {
            continue;
          }
          const row = {
            ...worktree,
            id: 11,
            path: discovered.path,
            branch: discovered.branch,
            head: discovered.head,
          } satisfies WorktreeRow;
          worktreeRows = [...worktreeRows, row];
          added.push({ id: row.id, path: row.path, branch: row.branch });
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
          return { stdout: 'main\n', stderr: '' };
        }
        if (command.endsWith(`check-ref-format --branch ${branch}`)) {
          return { stdout: `${branch}\n`, stderr: '' };
        }
        if (args[2] === 'worktree' && args[3] === 'add') {
          created = true;
          createdPath = args[6] ?? null;
          assert.deepEqual(args.slice(4, 8), ['-b', branch, createdPath, 'main']);
          if (createdPath) {
            mkdirSync(createdPath, { recursive: true });
          }
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;

  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.openWorktree({
          projectId: project.id,
          request: { branch, base: { kind: 'branch', ref: 'main' } },
        });
      }).pipe(
        Effect.provide(WorkspaceServiceLive),
        Effect.provideService(CommandService, testCommandService),
        Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(SurfaceService, testSurfaceService),
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, openGit),
        Effect.provideService(
          DataDirectory,
          makeTestDataDirectory(dataRoot, { worktreesPath: checkoutParent }),
        ),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    );

    assert.deepEqual(output, {
      projectId: project.id,
      worktreeId: 11,
      branch,
      status: 'created',
      setup: { status: 'skipped', reason: 'not_configured' },
    });
    assert.equal(createdPath, join(checkoutParent, String(project.id), branchPathHash(branch)));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('opening a missing branch can create it from the current detached worktree', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-new-commit-branch-project-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-new-commit-branch-data-'));
  const branch = 'feature/from-commit';
  const commit = 'abc123456789';
  const detachedPath = join(projectRoot, '../isagi-detached');
  const detachedWorktree = {
    ...worktree,
    id: 12,
    path: detachedPath,
    branch: null,
    head: commit,
  } satisfies WorktreeRow;
  let addArgs: readonly string[] | null = null;
  const repository = {
    ...repositoryWith({ project: { ...project, rootPath: projectRoot }, worktree: null }),
    findWorktree: (worktreeId: number) =>
      Effect.succeed(worktreeId === detachedWorktree.id ? detachedWorktree : null),
    findProjectWorktreeByBranch: () =>
      Effect.succeed(
        addArgs
          ? {
              ...worktree,
              id: 11,
              path: join(dataRoot, 'worktrees', String(project.id), branchPathHash(branch)),
              branch,
              head: commit,
            }
          : null,
      ),
  } satisfies WorkspaceRepositoryService;
  const stateFile = stateFileWithWriteCounter(() => {});
  const openGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        const command = args.join(' ');
        if (command.endsWith('worktree list --porcelain')) {
          return {
            stdout: `worktree ${projectRoot}\nHEAD def456789012\nbranch refs/heads/main\n\nworktree ${detachedPath}\nHEAD ${commit}\n`,
            stderr: '',
          };
        }
        if (command.endsWith('branch --format=%(refname:short)')) {
          return { stdout: 'main\n', stderr: '' };
        }
        if (command.endsWith(`check-ref-format --branch ${branch}`)) {
          return { stdout: `${branch}\n`, stderr: '' };
        }
        if (args[2] === 'worktree' && args[3] === 'add') {
          addArgs = args;
          const checkoutPath = args[6];
          if (checkoutPath) {
            mkdirSync(checkoutPath, { recursive: true });
          }
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;

  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.openWorktree({
          projectId: project.id,
          request: { branch, base: { kind: 'detached_worktree', worktreeId: detachedWorktree.id } },
        });
      }).pipe(
        Effect.provide(WorkspaceServiceLive),
        Effect.provideService(CommandService, testCommandService),
        Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(SurfaceService, testSurfaceService),
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, openGit),
        Effect.provideService(DataDirectory, makeTestDataDirectory(dataRoot)),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    );

    assert.ok(addArgs);
    assert.deepEqual((addArgs as readonly string[]).slice(4, 8), [
      '-b',
      branch,
      join(dataRoot, 'worktrees', String(project.id), branchPathHash(branch)),
      commit,
    ]);
    assert.deepEqual(output, {
      projectId: project.id,
      worktreeId: 11,
      branch,
      status: 'created',
      setup: { status: 'skipped', reason: 'not_configured' },
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('opening a missing branch rejects invalid detached worktree bases before checkout', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-invalid-detached-base-project-'));
  const branch = 'feature/from-invalid-detached';
  const commit = 'abc123456789';
  const detachedPath = join(projectRoot, '../isagi-detached-invalid');
  const cases = [
    {
      name: 'wrong project',
      baseWorktree: {
        ...worktree,
        id: 12,
        projectId: 99,
        path: detachedPath,
        branch: null,
        head: commit,
      },
      discovered: `worktree ${projectRoot}\nHEAD def456789012\nbranch refs/heads/main\n\nworktree ${detachedPath}\nHEAD ${commit}\n`,
    },
    {
      name: 'branch-backed worktree',
      baseWorktree: { ...worktree, id: 12, path: detachedPath, branch: 'main', head: commit },
      discovered: `worktree ${projectRoot}\nHEAD def456789012\nbranch refs/heads/main\n\nworktree ${detachedPath}\nHEAD ${commit}\nbranch refs/heads/main\n`,
    },
    {
      name: 'missing head',
      baseWorktree: { ...worktree, id: 12, path: detachedPath, branch: null, head: null },
      discovered: `worktree ${projectRoot}\nHEAD def456789012\nbranch refs/heads/main\n\nworktree ${detachedPath}\n`,
    },
    {
      name: 'no longer detached in Git',
      baseWorktree: { ...worktree, id: 12, path: detachedPath, branch: null, head: commit },
      discovered: `worktree ${projectRoot}\nHEAD def456789012\nbranch refs/heads/main\n\nworktree ${detachedPath}\nHEAD ${commit}\nbranch refs/heads/other\n`,
    },
  ] satisfies readonly {
    readonly name: string;
    readonly baseWorktree: WorktreeRow;
    readonly discovered: string;
  }[];

  try {
    for (const scenario of cases) {
      let addCalls = 0;
      const repository = {
        ...repositoryWith({ project: { ...project, rootPath: projectRoot }, worktree: null }),
        findWorktree: (worktreeId: number) =>
          Effect.succeed(worktreeId === scenario.baseWorktree.id ? scenario.baseWorktree : null),
      } satisfies WorkspaceRepositoryService;
      const stateFile = stateFileWithWriteCounter(() => {});
      const invalidBaseGit = {
        run: (args: readonly string[]) =>
          Effect.sync(() => {
            const command = args.join(' ');
            if (command.endsWith('worktree list --porcelain')) {
              return { stdout: scenario.discovered, stderr: '' };
            }
            if (command.endsWith('branch --format=%(refname:short)')) {
              return { stdout: 'main\n', stderr: '' };
            }
            if (command.endsWith(`check-ref-format --branch ${branch}`)) {
              return { stdout: `${branch}\n`, stderr: '' };
            }
            if (args[2] === 'worktree' && args[3] === 'add') {
              addCalls += 1;
            }
            return { stdout: '', stderr: '' };
          }),
      } satisfies GitService;

      const error = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            const workspace = yield* WorkspaceService;
            return yield* workspace.openWorktree({
              projectId: project.id,
              request: {
                branch,
                base: { kind: 'detached_worktree', worktreeId: scenario.baseWorktree.id },
              },
            });
          }).pipe(
            Effect.provide(WorkspaceServiceLive),
            Effect.provideService(CommandService, testCommandService),
            Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
            Effect.provideService(WorkspaceRepository, repository),
            Effect.provideService(SurfaceRepository, testSurfaceRepository),
            Effect.provideService(SurfaceService, testSurfaceService),
            Effect.provideService(StateFile, stateFile),
            Effect.provideService(Git, invalidBaseGit),
            Effect.provideService(DataDirectory, testDataDirectory),
            Effect.provideService(WorktreeSetupService, testWorktreeSetup),
            Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
          ),
        ),
      );

      assert.ok(error instanceof WorkspaceError, scenario.name);
      assert.equal(error.code, 'base_ref_not_found', scenario.name);
      assert.equal(error.worktreeId, scenario.baseWorktree.id, scenario.name);
      assert.equal(addCalls, 0, scenario.name);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
