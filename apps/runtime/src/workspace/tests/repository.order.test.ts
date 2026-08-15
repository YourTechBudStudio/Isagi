import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import {
  DataDirectory,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type RuntimeDatabaseService,
} from '../../persistence/index.js';
import { projects, worktrees } from '../../persistence/schema.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import {
  WorkspaceRepository,
  WorkspaceRepositoryLive,
  type WorkspaceRepositoryService,
} from '../workspace.repository.js';

/**
 * Sibling order is established in SQL and the rank never leaves the repository,
 * so these are the only tests that can prove it. The service-level workspace
 * tests substitute a fake repository and therefore cannot observe ordering,
 * tie-breaking, or the transactional append rules exercised here.
 */

function testLayer(dataRoot: string) {
  const dataDirectoryLayer = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const repository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  return Layer.mergeAll(database, repository);
}

/** Runs `build` against a throwaway database rooted in its own temp directory. */
function runWithDatabase<A, E>(
  name: string,
  build: Effect.Effect<A, E, RuntimeDatabaseService | WorkspaceRepositoryService>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), `isagi-${name}-`));
  return Effect.runPromise(build.pipe(Effect.provide(testLayer(dataRoot)))).finally(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });
}

/** Forces stored ranks, standing in for migrated rows and for scrambled order. */
function setProjectRank(projectId: number, sortOrder: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_set_project_rank', (db) => {
      db.update(projects).set({ sortOrder }).where(eq(projects.id, projectId)).run();
    });
  });
}

function setWorktreeRank(worktreeId: number, sortOrder: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_set_worktree_rank', (db) => {
      db.update(worktrees).set({ sortOrder }).where(eq(worktrees.id, worktreeId)).run();
    });
  });
}

function readWorktreeRanks() {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_read_worktree_ranks', (db) =>
      db
        .select({ id: worktrees.id, path: worktrees.path, sortOrder: worktrees.sortOrder })
        .from(worktrees)
        .orderBy(worktrees.id)
        .all(),
    );
  });
}

function readProjectRow(projectId: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_read_project_row', (db) =>
      db.select().from(projects).where(eq(projects.id, projectId)).get(),
    );
  });
}

function stampProjectSeenAt(projectId: number, when: string) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_stamp_project_seen_at', (db) => {
      db.update(projects)
        .set({ updatedAt: when, lastSeenAt: when })
        .where(eq(projects.id, projectId))
        .run();
    });
  });
}

function insertProjects(names: readonly string[]) {
  return Effect.gen(function* () {
    const repository = yield* WorkspaceRepository;
    const ids: number[] = [];
    for (const name of names) {
      ids.push(yield* repository.insertProject({ name, rootPath: `/repo/${name}` }));
    }
    return ids;
  });
}

function listProjectIds() {
  return Effect.gen(function* () {
    const repository = yield* WorkspaceRepository;
    return (yield* repository.listProjects).map((project) => project.id);
  });
}

test('project order falls back to identifiers when migrated ranks are tied', async () => {
  const ids = await runWithDatabase(
    'project-tied-ranks',
    Effect.gen(function* () {
      const inserted = yield* insertProjects(['alpha', 'bravo', 'charlie']);
      // Every row a migration touches lands on the same DEFAULT 0.
      for (const id of inserted) {
        yield* setProjectRank(id, 0);
      }
      return yield* listProjectIds();
    }),
  );

  assert.deepEqual(ids, [1, 2, 3]);
});

test('explicit project ranks override identifier order', async () => {
  const ids = await runWithDatabase(
    'project-explicit-ranks',
    Effect.gen(function* () {
      const [alpha, bravo, charlie] = yield* insertProjects(['alpha', 'bravo', 'charlie']);
      yield* setProjectRank(alpha!, 2);
      yield* setProjectRank(bravo!, 0);
      yield* setProjectRank(charlie!, 1);
      return yield* listProjectIds();
    }),
  );

  assert.deepEqual(ids, [2, 3, 1]);
});

test('present projects precede missing projects, which keep identifier order', async () => {
  const ids = await runWithDatabase(
    'project-sections',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha, bravo, charlie, delta] = yield* insertProjects([
        'alpha',
        'bravo',
        'charlie',
        'delta',
      ]);
      yield* repository.setProjectStatus({ id: bravo!, status: 'missing' });
      yield* repository.setProjectStatus({ id: alpha!, status: 'missing' });
      // A missing project's retained rank is deliberately meaningless, so a high
      // rank on one and a low rank on the other must not reorder the section.
      yield* setProjectRank(bravo!, 99);
      yield* setProjectRank(alpha!, 0);
      yield* setProjectRank(delta!, 0);
      yield* setProjectRank(charlie!, 1);
      return yield* listProjectIds();
    }),
  );

  assert.deepEqual(ids, [4, 3, 1, 2]);
});

test('a newly registered project appends after every present project', async () => {
  const ids = await runWithDatabase(
    'project-append',
    Effect.gen(function* () {
      const [alpha, bravo] = yield* insertProjects(['alpha', 'bravo']);
      // Reverse the first two so the appended project cannot pass for "by id".
      yield* setProjectRank(alpha!, 5);
      yield* setProjectRank(bravo!, 4);
      yield* insertProjects(['charlie']);
      return yield* listProjectIds();
    }),
  );

  assert.deepEqual(ids, [2, 1, 3]);
});

test('repeated present status writes refresh metadata without moving the project', async () => {
  const result = await runWithDatabase(
    'project-present-idempotent',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha] = yield* insertProjects(['alpha', 'bravo', 'charlie']);
      const before = yield* readProjectRow(alpha!);
      yield* stampProjectSeenAt(alpha!, '2000-01-01T00:00:00.000Z');

      // Broad reconciliation calls this for every present project on every sweep.
      yield* repository.setProjectStatus({ id: alpha!, status: 'present' });
      yield* repository.setProjectStatus({ id: alpha!, status: 'present' });

      const after = yield* readProjectRow(alpha!);
      return {
        ids: yield* listProjectIds(),
        rankBefore: before?.sortOrder,
        rankAfter: after?.sortOrder,
        refreshed: after?.lastSeenAt !== '2000-01-01T00:00:00.000Z',
        updated: after?.updatedAt !== '2000-01-01T00:00:00.000Z',
      };
    }),
  );

  assert.deepEqual(result.ids, [1, 2, 3]);
  assert.equal(result.rankAfter, result.rankBefore);
  assert.equal(result.refreshed, true);
  assert.equal(result.updated, true);
});

test('a project restored to present appends exactly once', async () => {
  const result = await runWithDatabase(
    'project-restore-appends-once',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha] = yield* insertProjects(['alpha', 'bravo', 'charlie']);

      yield* repository.setProjectStatus({
        id: alpha!,
        status: 'missing',
        missingReason: 'Project path not found: /repo/alpha',
      });
      yield* repository.setProjectStatus({ id: alpha!, status: 'present' });
      const afterRestore = yield* listProjectIds();
      const restoredRow = yield* readProjectRow(alpha!);

      // A second sweep must not append again.
      yield* repository.setProjectStatus({ id: alpha!, status: 'present' });

      return {
        afterRestore,
        afterSecondSweep: yield* listProjectIds(),
        rankAfterRestore: restoredRow?.sortOrder,
        rankAfterSecondSweep: (yield* readProjectRow(alpha!))?.sortOrder,
        missingReason: restoredRow?.missingReason,
      };
    }),
  );

  assert.deepEqual(result.afterRestore, [2, 3, 1]);
  assert.deepEqual(result.afterSecondSweep, [2, 3, 1]);
  assert.equal(result.rankAfterRestore, result.rankAfterSecondSweep);
  assert.equal(result.missingReason, null);
});

test('relocation restores a project to the end of the present section', async () => {
  const ids = await runWithDatabase(
    'project-relocation-appends',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha] = yield* insertProjects(['alpha', 'bravo', 'charlie']);
      yield* repository.setProjectStatus({ id: alpha!, status: 'missing' });

      yield* repository.restoreProjectAtRootPath({
        discovered: [{ path: '/repo/alpha-moved', branch: 'main', head: 'abc1234' }],
        projectId: alpha!,
        rootPath: '/repo/alpha-moved',
      });

      return yield* listProjectIds();
    }),
  );

  assert.deepEqual(ids, [2, 3, 1]);
});

test('newly discovered worktrees append in discovery order and consume no rank when known', async () => {
  const result = await runWithDatabase(
    'worktree-append',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const projectId = yield* repository.insertProject({
        name: 'isagi',
        rootPath: '/repo/isagi',
      });
      const discovered = [
        { path: '/repo/isagi', branch: 'main', head: 'aaa1111' },
        { path: '/repo/isagi-feature', branch: 'feature/one', head: 'bbb2222' },
        { path: '/repo/isagi-chore', branch: 'chore/two', head: 'ccc3333' },
      ];
      yield* repository.reconcileProjectWorktrees({ projectId, discovered });

      // A sweep that only refreshes known worktrees must consume no ranks, so
      // the next genuinely new worktree lands at rank 3 rather than 6.
      yield* repository.reconcileProjectWorktrees({ projectId, discovered });
      yield* repository.reconcileProjectWorktrees({
        projectId,
        discovered: [...discovered, { path: '/repo/isagi-late', branch: 'late', head: 'ddd4444' }],
      });

      const rows = yield* repository.listWorktrees;
      return rows.map((worktree) => worktree.path);
    }),
  );

  assert.deepEqual(result, [
    '/repo/isagi',
    '/repo/isagi-feature',
    '/repo/isagi-chore',
    '/repo/isagi-late',
  ]);
});

test('reconciliation cannot reclaim ownership of a reordered worktree list', async () => {
  const result = await runWithDatabase(
    'worktree-reconcile-preserves-order',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const projectId = yield* repository.insertProject({
        name: 'isagi',
        rootPath: '/repo/isagi',
      });
      const discovered = [
        { path: '/repo/isagi', branch: 'main', head: 'aaa1111' },
        { path: '/repo/isagi-one', branch: 'one', head: 'bbb2222' },
        { path: '/repo/isagi-two', branch: 'two', head: 'ccc3333' },
        { path: '/repo/isagi-three', branch: 'three', head: 'ddd4444' },
      ];
      yield* repository.reconcileProjectWorktrees({ projectId, discovered });

      const inserted = yield* repository.listWorktrees;
      const worktreeId = (path: string) => {
        const found = inserted.find((worktree) => worktree.path === path);
        if (!found) throw new Error(`Missing test worktree ${path}.`);
        return found.id;
      };
      // three, one, two — an order no discovery sweep would produce on its own.
      yield* repository.moveProjectWorktreeOrder({
        projectId,
        worktreeId: worktreeId('/repo/isagi-three'),
        beforeWorktreeId: worktreeId('/repo/isagi-one'),
      });

      const reordered = yield* readWorktreeRanks();
      const reorderedPaths = (yield* repository.listWorktrees).map((worktree) => worktree.path);

      // Git reports worktrees in its own order, which here is deliberately
      // neither the discovery order nor the user's. Existing rows are refreshed,
      // never re-ranked, so the sweep must not move anything.
      yield* repository.reconcileProjectWorktrees({
        projectId,
        discovered: [discovered[2]!, discovered[0]!, discovered[3]!, discovered[1]!],
      });

      return {
        reordered,
        reorderedPaths,
        reconciled: yield* readWorktreeRanks(),
        reconciledPaths: (yield* repository.listWorktrees).map((worktree) => worktree.path),
      };
    }),
  );

  assert.deepEqual(result.reorderedPaths, [
    '/repo/isagi',
    '/repo/isagi-three',
    '/repo/isagi-one',
    '/repo/isagi-two',
  ]);
  assert.deepEqual(result.reconciledPaths, result.reorderedPaths);
  // Raw ranks, not just display order: a sweep that renumbered every row back to
  // discovery order and happened to agree would still be a defect.
  assert.deepEqual(result.reconciled, result.reordered);
});

test('worktree order honors explicit ranks and falls back to identifiers when tied', async () => {
  const result = await runWithDatabase(
    'worktree-ranks',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const projectId = yield* repository.insertProject({
        name: 'isagi',
        rootPath: '/repo/isagi',
      });
      yield* repository.reconcileProjectWorktrees({
        projectId,
        discovered: [
          { path: '/repo/isagi', branch: 'main', head: 'aaa1111' },
          { path: '/repo/isagi-feature', branch: 'feature/one', head: 'bbb2222' },
          { path: '/repo/isagi-chore', branch: 'chore/two', head: 'ccc3333' },
        ],
      });
      const inserted = yield* repository.listWorktrees;

      const tied = yield* Effect.gen(function* () {
        for (const worktree of inserted) {
          yield* setWorktreeRank(worktree.id, 0);
        }
        return (yield* repository.listWorktrees).map((worktree) => worktree.id);
      });

      yield* setWorktreeRank(inserted[0]!.id, 2);
      yield* setWorktreeRank(inserted[1]!.id, 1);
      yield* setWorktreeRank(inserted[2]!.id, 0);

      return { tied, ranked: (yield* repository.listWorktrees).map((worktree) => worktree.id) };
    }),
  );

  assert.deepEqual(result.tied, [1, 2, 3]);
  assert.deepEqual(result.ranked, [3, 2, 1]);
});

test('worktree order is grouped by project', async () => {
  const paths = await runWithDatabase(
    'worktree-project-grouping',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const first = yield* repository.insertProject({ name: 'alpha', rootPath: '/repo/alpha' });
      const second = yield* repository.insertProject({ name: 'bravo', rootPath: '/repo/bravo' });
      yield* repository.reconcileProjectWorktrees({
        projectId: second,
        discovered: [{ path: '/repo/bravo', branch: 'main', head: 'bbb2222' }],
      });
      yield* repository.reconcileProjectWorktrees({
        projectId: first,
        discovered: [{ path: '/repo/alpha', branch: 'main', head: 'aaa1111' }],
      });

      return (yield* repository.listWorktrees).map((worktree) => worktree.path);
    }),
  );

  assert.deepEqual(paths, ['/repo/alpha', '/repo/bravo']);
});
