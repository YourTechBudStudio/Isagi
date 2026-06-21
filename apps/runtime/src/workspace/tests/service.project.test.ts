import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { CommandService } from '../../commands/index.js';
import { Git, type GitService } from '../../git/index.js';
import { DataDirectory, StateFile } from '../../persistence/index.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import { SurfaceService, SurfaceRepository } from '../../surfaces/index.js';
import { WorktreeSetupRepository, WorktreeSetupService } from '../../worktree-setup/index.js';
import type { ProjectRow } from '../types.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from '../workspace.repository.js';
import { WorkspaceError, WorkspaceService, WorkspaceServiceLive } from '../workspace.service.js';
import {
  git,
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
      Effect.provideService(CommandService, testCommandService),
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
        Effect.provideService(CommandService, testCommandService),
        Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(SurfaceService, testSurfaceService),
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
        Effect.provideService(CommandService, testCommandService),
        Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(SurfaceService, testSurfaceService),
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
