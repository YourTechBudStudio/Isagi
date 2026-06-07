import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { Git, type GitService } from '../git/index.js';
import { StateFile, stateFromActiveContext, type StateFileService } from '../persistence/index.js';
import type { ProjectRow, WorktreeRow } from './types.js';
import { WorkspaceRepository, type WorkspaceRepositoryService } from './workspace-repository.js';
import { WorkspaceError, WorkspaceService, WorkspaceServiceLive } from './workspace-service.js';

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
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, git),
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
      Effect.provideService(StateFile, stateFile),
      Effect.provideService(Git, git),
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
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, quietGit),
      ),
    ),
  );

  assert.ok(error instanceof WorkspaceError);
  assert.equal(error.code, 'project_not_missing');
  assert.equal(gitCalls, 0);
});

test('project relocation restores the same project id and reconciles discovered worktrees', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'isagi-relocated-project-'));
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
        return { added: [{ id: worktree.id, path: input.rootPath }], missing: [] };
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
        Effect.provideService(StateFile, stateFile),
        Effect.provideService(Git, relocationGit),
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
        },
      ],
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
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
      Effect.provideService(StateFile, stateFile),
      Effect.provideService(Git, git),
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
