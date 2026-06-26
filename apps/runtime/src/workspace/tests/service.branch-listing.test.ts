import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { CommandService } from '../../commands/index.js';
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
        Effect.provideService(CommandService, testCommandService),
        Effect.provideService(PtyService, testPtyService),
        Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(SurfaceService, testSurfaceService),
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
        Effect.provideService(CommandService, testCommandService),
        Effect.provideService(PtyService, testPtyService),
        Effect.provideService(InternalRuntimeEventBus, testInternalEvents),
        Effect.provideService(WorkspaceRepository, repository),
        Effect.provideService(SurfaceRepository, testSurfaceRepository),
        Effect.provideService(SurfaceService, testSurfaceService),
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
