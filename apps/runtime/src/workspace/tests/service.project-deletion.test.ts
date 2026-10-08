import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after as afterAll, describe } from 'node:test';

import { count, eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { AgentSessionService } from '../../agent-sessions/index.js';
import { createFixtureWorkspace } from '../../git/tests/fixtures.js';
import { DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import { agentSessions, projects, workflowRuns, worktrees } from '../../persistence/schema.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import { realSessionCreationLayer } from '../../session-restore/test-support.js';
import { SurfaceService } from '../../surfaces/index.js';
import { countRunRows, seedProjectRuns } from '../../workflows/store/test-support.js';
import { WorkspaceRepository } from '../workspace.repository.js';
import { WorkspaceService } from '../workspace.service.js';
import { createGitProjectFixture } from './live-git-support.js';
import { liveWorkspaceLayer, type LiveWorkspaceOptions } from './live-workspace-support.js';
import { directoryTree } from './test-support.js';

/**
 * Deleting a project erases everything Isagi knows about it, workflow runs included, in one
 * transaction, and nothing on disk.
 *
 * Runs are seeded through the workflows store's own writers, because the workspace graph has no
 * engine; the claim under test is the delete's transaction, not how runs come to exist.
 * `service.folder-deletion.test.ts` owns the folder-project cascade and the refused gate.
 */

const folders = createFixtureWorkspace('project-deletion');
afterAll(() => {
  folders.cleanup();
});

/** Deletion's gate passes and post-create succeeds; neither is under test here. */
const passingCommands = {
  commands: {
    cleanupBeforeWorktreeDelete: () => Effect.void,
    runPostCreateLifecycle: () => Effect.void,
  },
} satisfies LiveWorkspaceOptions;

function withDataRoot(name: string, body: (dataRoot: string) => Promise<void>) {
  return async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), `isagi-${name}-`));
    try {
      await body(dataRoot);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  };
}

function folderProject(name: string): string {
  const path = folders.directory(name);
  writeFileSync(join(path, 'notes.md'), '# notes\n');
  return path;
}

const register = (path: string) =>
  Effect.gen(function* () {
    const service = yield* WorkspaceService;
    return (yield* service.registerProject({ path })).projectId;
  });

const seedRuns = (projectId: number, runCount: number) =>
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.transaction('test_seed_runs', (db) =>
      seedProjectRuns(db, projectId, { runCount }),
    );
  });

const countRows = (runIds: readonly number[]) =>
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_count_runs', (db) => countRunRows(db, runIds));
  });

const projectRows = (projectId: number) =>
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_read_project_rows', (db) => ({
      projects: db.select().from(projects).where(eq(projects.id, projectId)).all().length,
      worktrees: db.select().from(worktrees).where(eq(worktrees.projectId, projectId)).all().length,
      runs:
        db
          .select({ n: count() })
          .from(workflowRuns)
          .where(eq(workflowRuns.projectId, projectId))
          .get()?.n ?? 0,
    }));
  });

const erasedCounts = {
  runs: 0,
  invocations: 0,
  executions: 0,
  operations: 0,
  events: 0,
  checkpoints: 0,
  // The build catalog is shared, not the project's.
  artifacts: 1,
};

describe('deleting a project', () => {
  test(
    "erases its runs and every child row, its worktrees and sessions, and leaves another project's alone",
    withDataRoot('project-delete-runs', async (dataRoot) => {
      const git = createGitProjectFixture('project-delete-runs');
      try {
        // A Git project with an Isagi-created worktree under `<data>/worktrees`, an extra branch,
        // and a `.isagi/workflows` folder: everything the user owns on disk that deletion must keep.
        mkdirSync(join(git.rootPath, '.isagi', 'workflows'), { recursive: true });
        writeFileSync(join(git.rootPath, '.isagi', 'workflows', 'keep.txt'), 'keep\n');
        git.git(['branch', 'extra']);

        const seeded = await Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* WorkspaceService;
            const repository = yield* WorkspaceRepository;
            const doomed = yield* register(git.rootPath);
            const kept = yield* register(folderProject('project-delete-runs-kept'));
            const opened = yield* service.openWorktree({
              projectId: doomed,
              request: { branch: 'feature/kept-on-disk', base: { kind: 'branch', ref: 'main' } },
            });
            assert.equal(opened.status, 'created');
            const rootWorktree = (yield* repository.listWorktrees).find(
              (row) => row.projectId === doomed && row.path === git.rootPath,
            );
            if (!rootWorktree)
              throw new Error('Expected the Git project to own its root checkout.');
            return {
              doomed,
              kept,
              rootWorktreeId: rootWorktree.id,
              doomedRuns: (yield* seedRuns(doomed, 2)).runIds,
              keptRuns: (yield* seedRuns(kept, 1)).runIds,
            };
          }).pipe(Effect.provide(liveWorkspaceLayer(dataRoot, passingCommands))),
        );

        // A real agent session in the doomed project, created through its owning service.
        await Effect.runPromise(
          Effect.gen(function* () {
            const surfaces = yield* SurfaceService;
            const agents = yield* AgentSessionService;
            const surface = yield* surfaces.createSinglePaneSurface({
              worktreeId: seeded.rootWorktreeId,
              titleBase: 'Agent',
            });
            const bound = yield* surfaces.createPaneSession({
              worktreeId: seeded.rootWorktreeId,
              create: { kind: 'agent_session', paneId: surface.paneId, harness: 'pi' },
            });
            if (bound.session.kind !== 'agent_session') throw new Error('Expected an agent pane.');
            yield* agents.ensureActivePtyProcess(bound.session.agentSessionId);
          }).pipe(
            Effect.provide(
              realSessionCreationLayer(dataRoot, { ptyLaunches: [], harnessLaunches: [] }),
            ),
          ),
        );

        const worktreesPath = makeTestDataDirectory(dataRoot).paths.worktreesPath;
        const branches = () => git.git(['branch', '--format=%(refname:short)']).trim().split('\n');
        const projectTreeBefore = directoryTree(git.rootPath);
        const worktreesTreeBefore = directoryTree(worktreesPath);
        const branchesBefore = branches();
        assert.ok(branchesBefore.includes('extra'));
        assert.ok(branchesBefore.includes('feature/kept-on-disk'));
        assert.ok(worktreesTreeBefore.length > 0, 'the Isagi-created worktree exists on disk');

        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* WorkspaceService;
            const database = yield* RuntimeDatabase;
            const sessionsOf = (projectId: number) =>
              database.use('test_count_sessions', (db) =>
                db
                  .select({ id: agentSessions.id })
                  .from(agentSessions)
                  .innerJoin(worktrees, eq(worktrees.id, agentSessions.worktreeId))
                  .where(eq(worktrees.projectId, projectId))
                  .all(),
              );
            const before = {
              doomed: yield* projectRows(seeded.doomed),
              doomedRuns: yield* countRows(seeded.doomedRuns),
              doomedSessions: (yield* sessionsOf(seeded.doomed)).length,
              kept: yield* projectRows(seeded.kept),
              keptRuns: yield* countRows(seeded.keptRuns),
            };
            const deleted = yield* service.deleteProject(seeded.doomed);
            return {
              before,
              deleted,
              after: {
                doomed: yield* projectRows(seeded.doomed),
                doomedRuns: yield* countRows(seeded.doomedRuns),
                doomedSessions: (yield* sessionsOf(seeded.doomed)).length,
                kept: yield* projectRows(seeded.kept),
                keptRuns: yield* countRows(seeded.keptRuns),
              },
            };
          }).pipe(Effect.provide(liveWorkspaceLayer(dataRoot, passingCommands))),
        );

        // The fixture was real before the delete, or nothing below means anything.
        assert.deepEqual(outcome.before.doomed, { projects: 1, worktrees: 2, runs: 2 });
        assert.deepEqual(outcome.before.doomedRuns, {
          runs: 2,
          invocations: 2,
          executions: 2,
          operations: 2,
          events: 2,
          checkpoints: 2,
          artifacts: 1,
        });
        assert.equal(outcome.before.doomedSessions, 1);

        assert.deepEqual(outcome.deleted, { projectId: seeded.doomed, deleted: true });
        assert.deepEqual(outcome.after.doomed, { projects: 0, worktrees: 0, runs: 0 });
        assert.deepEqual(outcome.after.doomedRuns, erasedCounts);
        assert.equal(outcome.after.doomedSessions, 0);
        assert.deepEqual(outcome.after.kept, outcome.before.kept);
        assert.deepEqual(outcome.after.keptRuns, outcome.before.keptRuns);

        // Nothing on disk moved: the project folder (its `.git` and `.isagi` included), the
        // Isagi-created worktree, and every branch.
        assert.deepEqual(directoryTree(git.rootPath), projectTreeBefore);
        assert.deepEqual(directoryTree(worktreesPath), worktreesTreeBefore);
        assert.deepEqual(branches(), branchesBefore);
      } finally {
        git.cleanup();
      }
    }),
  );

  test(
    'rolls back the project delete when run erasure fails, and succeeds when asked again',
    withDataRoot('project-delete-atomic', async (dataRoot) => {
      const path = folderProject('project-delete-atomic');
      const seeded = await Effect.runPromise(
        Effect.gen(function* () {
          const projectId = yield* register(path);
          return { projectId, runIds: (yield* seedRuns(projectId, 1)).runIds };
        }).pipe(Effect.provide(liveWorkspaceLayer(dataRoot, passingCommands))),
      );

      const failed = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const before = yield* projectRows(seeded.projectId);
          const failure = yield* Effect.flip(service.deleteProject(seeded.projectId));
          return { before, failure, after: yield* projectRows(seeded.projectId) };
        }).pipe(
          Effect.provide(
            liveWorkspaceLayer(dataRoot, {
              ...passingCommands,
              runErasure: {
                eraseProjectRunsInTransaction: (db, projectId) => {
                  // Erase for real first, so the rollback has something to undo.
                  db.delete(workflowRuns).where(eq(workflowRuns.projectId, projectId)).run();
                  throw new Error('erasure failed');
                },
              },
            }),
          ),
        ),
      );

      assert.ok(failed.failure instanceof DatabaseError);
      assert.equal(failed.failure.operation, 'delete_project');
      assert.deepEqual(failed.before, { projects: 1, worktrees: 1, runs: 1 });
      assert.deepEqual(
        failed.after,
        failed.before,
        'the project, its worktree and its runs remain',
      );

      const retried = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const deleted = yield* service.deleteProject(seeded.projectId);
          return {
            deleted,
            rows: yield* projectRows(seeded.projectId),
            runs: yield* countRows(seeded.runIds),
          };
        }).pipe(Effect.provide(liveWorkspaceLayer(dataRoot, passingCommands))),
      );

      assert.deepEqual(retried.deleted, { projectId: seeded.projectId, deleted: true });
      assert.deepEqual(retried.rows, { projects: 0, worktrees: 0, runs: 0 });
      assert.deepEqual(retried.runs, erasedCounts);
    }),
  );

  test(
    'a folder added again after deletion is a new project with no runs',
    withDataRoot('project-delete-readd', async (dataRoot) => {
      const path = folderProject('project-delete-readd');
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const first = yield* register(path);
          yield* seedRuns(first, 2);
          yield* service.deleteProject(first);
          const second = yield* register(path);
          return {
            first,
            second,
            firstRows: yield* projectRows(first),
            secondRows: yield* projectRows(second),
          };
        }).pipe(Effect.provide(liveWorkspaceLayer(dataRoot, passingCommands))),
      );

      assert.notEqual(outcome.second, outcome.first);
      assert.deepEqual(outcome.firstRows, { projects: 0, worktrees: 0, runs: 0 });
      assert.deepEqual(outcome.secondRows, { projects: 1, worktrees: 1, runs: 0 });
    }),
  );
});
