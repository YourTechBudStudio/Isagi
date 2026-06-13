import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { branchPathHash, Git, GitCommandError, type GitService } from '../git/index.js';
import {
  DataDirectory,
  StateFile,
  stateFromActiveContext,
  type DataDirectoryService,
  type StateFileService,
} from '../persistence/index.js';
import { SurfaceRepository, type SurfaceRepositoryService } from '../surfaces/index.js';
import {
  WorktreeSetupRepository,
  WorktreeSetupService,
  type WorktreeSetupRepositoryService,
  type WorktreeSetupService as WorktreeSetupServiceShape,
} from '../worktree-setup/index.js';
import type { ProjectRow, WorktreeRow } from './types.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from './workspace.repository.js';
import { WorkspaceError, WorkspaceService, WorkspaceServiceLive } from './workspace.service.js';

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

const worktree: WorktreeRow = {
  id: 10,
  projectId: project.id,
  path: '/repo/isagi',
  branch: 'main',
  head: 'abc123456789',
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  firstSeenAt: '2026-06-04T00:00:00.000Z',
  lastSeenAt: '2026-06-04T00:00:00.000Z',
};

const git = {
  run: () => Effect.die(new Error('git should not be called by active context persistence')),
} satisfies GitService;

const testDataDirectory = {
  paths: {
    root: '/tmp/isagi-test',
    databasePath: '/tmp/isagi-test/isagi.db',
    statePath: '/tmp/isagi-test/state.json',
    worktreesPath: '/tmp/isagi-test/worktrees',
    sessionsPath: '/tmp/isagi-test/sessions',
  },
} satisfies DataDirectoryService;

const testWorktreeSetup = {
  preflight: (candidate) =>
    Effect.succeed({ projectId: candidate.id, status: 'not_configured', summary: [] }),
  updateTrust: (input) =>
    Effect.succeed({
      projectId: input.project.id,
      status: input.request.action === 'disable_hooks' ? 'disabled' : 'trusted',
      ...(input.request.action === 'disable_hooks' ? {} : { hash: input.request.hash }),
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
  findEnvironmentFocus: () => Effect.succeed(null),
  listWorkspaceSurfaceMetadata: Effect.succeed([]),
  listEnvironmentFocusStates: Effect.succeed([]),
  listPanesForSurface: () => Effect.succeed([]),
  listPtySessionsForPanes: () => Effect.succeed([]),
  findSurfaceDeleteTarget: () => Effect.succeed(null),
  renameSurface: () => Effect.die('surface rename is not used by workspace tests'),
  deleteSurface: () => Effect.die('surface delete is not used by workspace tests'),
  deleteSurfacePane: () => Effect.die('surface pane delete is not used by workspace tests'),
  createSinglePaneSurface: () => Effect.die('surface creation is not used by workspace tests'),
  createPtySessionMetadata: () => Effect.die('pty metadata is not used by workspace tests'),
  createSinglePanePtySessionSurface: () =>
    Effect.die('pty session surface creation is not used by workspace tests'),
  setEnvironmentFocus: (input) => Effect.succeed(input),
} satisfies SurfaceRepositoryService;

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
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
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

test('project deletion does not touch frontend-owned active context persistence', async () => {
  let writeCalls = 0;
  let deleteCalls = 0;
  const stateFile = stateFileWithWriteCounter(() => {
    writeCalls += 1;
  });
  const repository = {
    ...repositoryWith({ project, worktree }),
    deleteProject: (projectId: number) =>
      Effect.sync(() => {
        deleteCalls += 1;
        return projectId === project.id;
      }),
  } satisfies WorkspaceRepositoryService;

  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      return yield* workspace.deleteProject(project.id);
    }).pipe(
      Effect.provide(WorkspaceServiceLive),
      Effect.provideService(WorkspaceRepository, repository),
      Effect.provideService(SurfaceRepository, testSurfaceRepository),
      Effect.provideService(StateFile, stateFile),
      Effect.provideService(Git, git),
      Effect.provideService(DataDirectory, testDataDirectory),
      Effect.provideService(WorktreeSetupService, testWorktreeSetup),
      Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
    ),
  );

  assert.deepEqual(output, { projectId: project.id, deleted: true });
  assert.equal(deleteCalls, 1);
  assert.equal(writeCalls, 0);
});

test('project relocation rejects projects that are not missing before touching git', async () => {
  let gitCalls = 0;
  const repository = repositoryWith({ project, worktree });
  const stateFile = stateFileWithWriteCounter(() => {});
  const quietGit = {
    run: () =>
      Effect.sync(() => {
        gitCalls += 1;
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.relocateProject({ projectId: project.id, path: '/repo/elsewhere' });
      }).pipe(
        Effect.provide(WorkspaceServiceLive),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, quietGit),
        Effect.provideService(DataDirectory, testDataDirectory),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    ),
  );

  assert.ok(error instanceof WorkspaceError);
  assert.equal(error.code, 'project_not_missing');
  assert.equal(gitCalls, 0);
});

test('project relocation restores the same project id and reconciles discovered worktrees', async () => {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-relocated-project-')));
  mkdirSync(join(projectRoot, '.git'));
  const missingProject: ProjectRow = {
    ...project,
    rootPath: '/repo/missing-isagi',
    status: 'missing',
    lastSeenAt: null,
    missingReason: 'Project path not found: /repo/missing-isagi',
  };
  let restoredRootPath: string | null = null;
  let restoredProjectId: number | null = null;
  const repository = {
    ...repositoryWith({ project: missingProject, worktree: null }),
    findProjectByRootPath: () => Effect.succeed(null),
    restoreProjectAtRootPath: (input) =>
      Effect.sync(() => {
        restoredProjectId = input.projectId;
        restoredRootPath = input.rootPath;
        return { added: [{ id: worktree.id, path: input.rootPath, branch: 'main' }], missing: [] };
      }),
  } satisfies WorkspaceRepositoryService;
  const stateFile = stateFileWithWriteCounter(() => {});
  const relocationGit = {
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
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;

  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.relocateProject({ projectId: project.id, path: projectRoot });
      }).pipe(
        Effect.provide(WorkspaceServiceLive),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, relocationGit),
        Effect.provideService(DataDirectory, testDataDirectory),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    );

    assert.equal(restoredProjectId, project.id);
    assert.equal(restoredRootPath, projectRoot);
    assert.deepEqual(output, {
      projectId: project.id,
      findings: [
        { kind: 'project_restored', projectId: project.id, path: projectRoot },
        {
          kind: 'worktree_added',
          projectId: project.id,
          worktreeId: worktree.id,
          path: projectRoot,
          branch: 'main',
        },
      ],
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('project branch listing rejects a present project whose path disappeared before touching git branches', async () => {
  const missingRoot = join(tmpdir(), 'isagi-missing-branch-list-project');
  let gitBranchCalls = 0;
  let status: ProjectRow['status'] = 'present';
  const missingPathProject = { ...project, rootPath: missingRoot };
  const repository = {
    ...repositoryWith({ project: missingPathProject, worktree: null }),
    findProject: (projectId: number) =>
      Effect.succeed(
        projectId === project.id
          ? {
              ...missingPathProject,
              status,
              missingReason: status === 'missing' ? 'missing' : null,
            }
          : null,
      ),
    setProjectStatus: (input) =>
      Effect.sync(() => {
        status = input.status;
      }),
  } satisfies WorkspaceRepositoryService;
  const stateFile = stateFileWithWriteCounter(() => {});
  const branchGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        if (args.join(' ').endsWith('branch --format=%(refname:short)')) {
          gitBranchCalls += 1;
        }
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.listProjectBranches({ projectId: project.id });
      }).pipe(
        Effect.provide(WorkspaceServiceLive),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, branchGit),
        Effect.provideService(DataDirectory, testDataDirectory),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    ),
  );

  assert.ok(error instanceof WorkspaceError);
  assert.equal(error.code, 'project_not_present');
  assert.equal(status, 'missing');
  assert.equal(gitBranchCalls, 0);
});

test('project branch listing combines local branches with known open worktrees', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-branch-list-project-'));
  const testProject = { ...project, rootPath: projectRoot };
  const repository = repositoryWith({
    project: testProject,
    worktree: { ...worktree, path: projectRoot },
  });
  const stateFile = stateFileWithWriteCounter(() => {});
  const branchGit = {
    run: (args: readonly string[]) =>
      Effect.sync(() => {
        const command = args.join(' ');
        if (command.endsWith('branch --format=%(refname:short)')) {
          return { stdout: 'feature/new\nmain\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }),
  } satisfies GitService;

  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.listProjectBranches({ projectId: project.id });
      }).pipe(
        Effect.provide(WorkspaceServiceLive),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, branchGit),
        Effect.provideService(DataDirectory, testDataDirectory),
        Effect.provideService(WorktreeSetupService, testWorktreeSetup),
        Effect.provideService(WorktreeSetupRepository, testWorktreeSetupRepository),
      ),
    );

    assert.deepEqual(output.branches, [
      { name: 'feature/new', worktreeId: null },
      { name: 'main', worktreeId: worktree.id },
    ]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('opening an existing local branch creates an Isagi-managed checkout and returns its worktree', async () => {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-open-worktree-project-')));
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-open-worktree-data-'));
  const checkoutParent = join(dataRoot, 'worktrees');
  const branch = 'feature/new';
  let created = false;
  let createdPath: string | null = null;
  let nextWorktreeId = 11;
  let worktreeRows: WorktreeRow[] = [{ ...worktree, path: projectRoot }];
  const testProject = { ...project, rootPath: projectRoot };
  const dataDirectory = {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: checkoutParent,
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService;
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

  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.openWorktree({ projectId: project.id, request: { branch } });
      }).pipe(
        Effect.provide(WorkspaceServiceLive),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
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
          Effect.provideService(WorkspaceRepository, repository),
          Effect.provideService(SurfaceRepository, testSurfaceRepository),
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
          Effect.provideService(WorkspaceRepository, repository),
          Effect.provideService(SurfaceRepository, testSurfaceRepository),
          Effect.provideService(StateFile, stateFile),
          Effect.provideService(Git, missingBaseGit),
          Effect.provideService(DataDirectory, {
            paths: {
              root: dataRoot,
              databasePath: join(dataRoot, 'isagi.db'),
              statePath: join(dataRoot, 'state.json'),
              worktreesPath: join(dataRoot, 'worktrees'),
              sessionsPath: join(dataRoot, 'sessions'),
            },
          } satisfies DataDirectoryService),
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
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, openGit),
        Effect.provideService(DataDirectory, {
          paths: {
            root: dataRoot,
            databasePath: join(dataRoot, 'isagi.db'),
            statePath: join(dataRoot, 'state.json'),
            worktreesPath: checkoutParent,
            sessionsPath: join(dataRoot, 'sessions'),
          },
        } satisfies DataDirectoryService),
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
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, openGit),
        Effect.provideService(DataDirectory, {
          paths: {
            root: dataRoot,
            databasePath: join(dataRoot, 'isagi.db'),
            statePath: join(dataRoot, 'state.json'),
            worktreesPath: join(dataRoot, 'worktrees'),
            sessionsPath: join(dataRoot, 'sessions'),
          },
        } satisfies DataDirectoryService),
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
            Effect.provideService(WorkspaceRepository, repository),
            Effect.provideService(SurfaceRepository, testSurfaceRepository),
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
  const dataDirectory = {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService;

  try {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const workspace = yield* WorkspaceService;
          return yield* workspace.openWorktree({ projectId: project.id, request: { branch } });
        }).pipe(
          Effect.provide(WorkspaceServiceLive),
          Effect.provideService(WorkspaceRepository, repository),
          Effect.provideService(SurfaceRepository, testSurfaceRepository),
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
  const dataDirectory = {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService;

  try {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const workspace = yield* WorkspaceService;
          return yield* workspace.openWorktree({ projectId: project.id, request: { branch } });
        }).pipe(
          Effect.provide(WorkspaceServiceLive),
          Effect.provideService(WorkspaceRepository, repository),
          Effect.provideService(SurfaceRepository, testSurfaceRepository),
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
  const dataDirectory = {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService;

  try {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const workspace = yield* WorkspaceService;
          return yield* workspace.openWorktree({ projectId: project.id, request: { branch } });
        }).pipe(
          Effect.provide(WorkspaceServiceLive),
          Effect.provideService(WorkspaceRepository, repository),
          Effect.provideService(SurfaceRepository, testSurfaceRepository),
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
      Effect.provideService(WorkspaceRepository, repository),
      Effect.provideService(SurfaceRepository, testSurfaceRepository),
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

function repositoryWith(input: {
  readonly project: ProjectRow | null;
  readonly worktree: WorktreeRow | null;
}): WorkspaceRepositoryService {
  return {
    findProject: (projectId) =>
      Effect.succeed(input.project && input.project.id === projectId ? input.project : null),
    findProjectByRootPath: () => Effect.succeed(input.project),
    findWorktree: (worktreeId) =>
      Effect.succeed(input.worktree && input.worktree.id === worktreeId ? input.worktree : null),
    findProjectWorktreeByBranch: (lookup) =>
      Effect.succeed(
        input.worktree &&
          input.worktree.projectId === lookup.projectId &&
          input.worktree.branch === lookup.branch
          ? input.worktree
          : null,
      ),
    deleteProject: () => Effect.succeed(false),
    insertProject: () => Effect.succeed(project.id),
    listProjects: Effect.succeed(input.project ? [input.project] : []),
    listWorktrees: Effect.succeed(input.worktree ? [input.worktree] : []),
    reconcileProjectWorktrees: () => Effect.succeed({ added: [], missing: [] }),
    restoreProjectAtRootPath: () => Effect.succeed({ added: [], missing: [] }),
    setProjectStatus: () => Effect.void,
  };
}

function stateFileWithWriteCounter(onWrite: () => void): StateFileService {
  let state = stateFromActiveContext(null, null, 0);

  return {
    read: Effect.sync(() => state),
    write: (nextState) =>
      Effect.sync(() => {
        state = nextState;
        onWrite();
      }),
    writeActiveContextIfFresh: (input) =>
      Effect.sync(() => {
        if (input.revision > state.workspace.activeContextRevision) {
          state = stateFromActiveContext(
            input.activeProjectId,
            input.activeWorktreeId,
            input.revision,
          );
          onWrite();
        }
        return state;
      }),
  };
}
