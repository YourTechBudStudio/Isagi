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
 * Reorder mutations validate and rewrite ranks inside one transaction, and the
 * rank never leaves the repository. Only a real database can prove either half,
 * so both the accepted moves and every rejection reason are exercised here.
 *
 * Every rejection test also asserts that stored ranks are untouched: a rejection
 * that half-applied a move would still look correct if we only checked the code.
 */

function testLayer(dataRoot: string) {
  const dataDirectoryLayer = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const repository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  return Layer.mergeAll(database, repository);
}

function runWithDatabase<A, E>(
  name: string,
  build: Effect.Effect<A, E, RuntimeDatabaseService | WorkspaceRepositoryService>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), `isagi-${name}-`));
  return Effect.runPromise(build.pipe(Effect.provide(testLayer(dataRoot)))).finally(() => {
    rmSync(dataRoot, { recursive: true, force: true });
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

function readProjectRanks() {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_read_project_ranks', (db) =>
      db
        .select({ id: projects.id, sortOrder: projects.sortOrder })
        .from(projects)
        .orderBy(projects.id)
        .all(),
    );
  });
}

function readWorktreeRanks() {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_read_worktree_ranks', (db) =>
      db
        .select({ id: worktrees.id, sortOrder: worktrees.sortOrder })
        .from(worktrees)
        .orderBy(worktrees.id)
        .all(),
    );
  });
}

function readProjectTimestamps() {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_read_project_timestamps', (db) =>
      db
        .select({ id: projects.id, updatedAt: projects.updatedAt })
        .from(projects)
        .orderBy(projects.id)
        .all(),
    );
  });
}

function setProjectRank(projectId: number, sortOrder: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_set_project_rank', (db) => {
      db.update(projects).set({ sortOrder }).where(eq(projects.id, projectId)).run();
    });
  });
}

function stampProjectUpdatedAt(when: string) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_stamp_project_updated_at', (db) => {
      db.update(projects).set({ updatedAt: when }).run();
    });
  });
}

/** A project whose root checkout plus two linked worktrees are all discovered. */
function insertProjectWithWorktrees(name: string, linkedNames: readonly string[]) {
  return Effect.gen(function* () {
    const repository = yield* WorkspaceRepository;
    const rootPath = `/repo/${name}`;
    const projectId = yield* repository.insertProject({ name, rootPath });
    yield* repository.reconcileProjectWorktrees({
      projectId,
      discovered: [
        { path: rootPath, branch: 'main', head: 'aaa1111' },
        ...linkedNames.map((linked) => ({
          path: `${rootPath}-${linked}`,
          branch: linked,
          head: 'bbb2222',
        })),
      ],
    });
    const all = yield* repository.listWorktrees;
    const owned = all.filter((worktree) => worktree.projectId === projectId);
    const root = owned.find((worktree) => worktree.path === rootPath);
    return {
      projectId,
      rootWorktreeId: root?.id ?? 0,
      linkedWorktreeIds: owned
        .filter((worktree) => worktree.path !== rootPath)
        .map((worktree) => worktree.id),
    };
  });
}

function listProjectWorktreeIds(projectId: number) {
  return Effect.gen(function* () {
    const repository = yield* WorkspaceRepository;
    return (yield* repository.listWorktrees)
      .filter((worktree) => worktree.projectId === projectId)
      .map((worktree) => worktree.id);
  });
}

test('moving a project before an earlier sibling reorders the present list', async () => {
  const ids = await runWithDatabase(
    'reorder-project-before',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha, bravo, charlie] = yield* insertProjects(['alpha', 'bravo', 'charlie']);
      const result = yield* repository.moveProjectOrder({
        projectId: charlie!,
        beforeProjectId: alpha!,
      });
      assert.deepEqual(result, { status: 'moved' });
      assert.equal(bravo, 2);
      return yield* listProjectIds();
    }),
  );

  assert.deepEqual(ids, [3, 1, 2]);
});

test('a null anchor appends the project to the end of the present list', async () => {
  const ids = await runWithDatabase(
    'reorder-project-append',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha] = yield* insertProjects(['alpha', 'bravo', 'charlie']);
      yield* repository.moveProjectOrder({ projectId: alpha!, beforeProjectId: null });
      return yield* listProjectIds();
    }),
  );

  assert.deepEqual(ids, [2, 3, 1]);
});

test('a project reorder renumbers present siblings to a compact sequence', async () => {
  const ranks = await runWithDatabase(
    'reorder-project-compaction',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha, bravo, charlie] = yield* insertProjects(['alpha', 'bravo', 'charlie']);
      // Scattered ranks stand in for a database that migrated onto DEFAULT 0 and
      // then took a few appends.
      yield* setProjectRank(alpha!, 40);
      yield* setProjectRank(bravo!, 41);
      yield* setProjectRank(charlie!, 42);
      yield* repository.moveProjectOrder({ projectId: charlie!, beforeProjectId: bravo! });
      return yield* readProjectRanks();
    }),
  );

  assert.deepEqual(ranks, [
    { id: 1, sortOrder: 0 },
    { id: 2, sortOrder: 2 },
    { id: 3, sortOrder: 1 },
  ]);
});

test('a migrated block tied at zero is repaired by an otherwise no-op move', async () => {
  const result = await runWithDatabase(
    'reorder-project-tie-repair',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha, bravo, charlie] = yield* insertProjects(['alpha', 'bravo', 'charlie']);
      for (const id of [alpha!, bravo!, charlie!]) {
        yield* setProjectRank(id, 0);
      }
      // Asking for the position it already holds. The order does not change, but
      // the tied ranks become a real sequence.
      const moved = yield* repository.moveProjectOrder({
        projectId: alpha!,
        beforeProjectId: alpha!,
      });
      return { moved, ids: yield* listProjectIds(), ranks: yield* readProjectRanks() };
    }),
  );

  assert.deepEqual(result.moved, { status: 'moved' });
  assert.deepEqual(result.ids, [1, 2, 3]);
  assert.deepEqual(result.ranks, [
    { id: 1, sortOrder: 0 },
    { id: 2, sortOrder: 1 },
    { id: 3, sortOrder: 2 },
  ]);
});

test('an already-effective project move writes no rows at all', async () => {
  const timestamps = await runWithDatabase(
    'reorder-project-noop',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha, bravo] = yield* insertProjects(['alpha', 'bravo', 'charlie']);
      // Compact the ranks first so nothing is left to repair.
      yield* repository.moveProjectOrder({ projectId: alpha!, beforeProjectId: bravo! });
      yield* stampProjectUpdatedAt('2020-01-01T00:00:00.000Z');
      yield* repository.moveProjectOrder({ projectId: alpha!, beforeProjectId: bravo! });
      return yield* readProjectTimestamps();
    }),
  );

  assert.deepEqual(
    timestamps.map((row) => row.updatedAt),
    ['2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'],
  );
});

test('a project reorder timestamps only the rows whose rank actually moved', async () => {
  const timestamps = await runWithDatabase(
    'reorder-project-timestamps',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha, bravo, charlie] = yield* insertProjects(['alpha', 'bravo', 'charlie']);
      yield* repository.moveProjectOrder({ projectId: alpha!, beforeProjectId: bravo! });
      yield* stampProjectUpdatedAt('2020-01-01T00:00:00.000Z');
      // Swapping the last two leaves the first project's rank at 0.
      yield* repository.moveProjectOrder({ projectId: charlie!, beforeProjectId: bravo! });
      return yield* readProjectTimestamps();
    }),
  );

  assert.equal(timestamps[0]?.updatedAt, '2020-01-01T00:00:00.000Z');
  assert.notEqual(timestamps[1]?.updatedAt, '2020-01-01T00:00:00.000Z');
  assert.notEqual(timestamps[2]?.updatedAt, '2020-01-01T00:00:00.000Z');
});

test('missing projects are neither reorderable nor renumbered by a reorder', async () => {
  const result = await runWithDatabase(
    'reorder-project-missing-untouched',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha, bravo, charlie] = yield* insertProjects(['alpha', 'bravo', 'charlie']);
      yield* repository.setProjectStatus({ id: bravo!, status: 'missing' });
      yield* setProjectRank(bravo!, 97);
      yield* repository.moveProjectOrder({ projectId: charlie!, beforeProjectId: alpha! });
      return yield* readProjectRanks();
    }),
  );

  // The missing project keeps its meaningless rank; the present pair compacts
  // around it without ever seeing it as a sibling.
  assert.deepEqual(result, [
    { id: 1, sortOrder: 1 },
    { id: 2, sortOrder: 97 },
    { id: 3, sortOrder: 0 },
  ]);
});

test('project reorder rejects an unknown source and leaves ranks unchanged', async () => {
  const result = await runWithDatabase(
    'reorder-project-source-missing',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      yield* insertProjects(['alpha', 'bravo']);
      const before = yield* readProjectRanks();
      const rejected = yield* repository.moveProjectOrder({
        projectId: 999,
        beforeProjectId: null,
      });
      return { rejected, before, after: yield* readProjectRanks() };
    }),
  );

  assert.deepEqual(result.rejected, { status: 'rejected', reason: 'project_not_found' });
  assert.deepEqual(result.after, result.before);
});

test('project reorder rejects a missing source before it can be ranked', async () => {
  const result = await runWithDatabase(
    'reorder-project-source-not-present',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha] = yield* insertProjects(['alpha', 'bravo']);
      yield* repository.setProjectStatus({ id: alpha!, status: 'missing' });
      const before = yield* readProjectRanks();
      const rejected = yield* repository.moveProjectOrder({
        projectId: alpha!,
        beforeProjectId: null,
      });
      return { rejected, before, after: yield* readProjectRanks() };
    }),
  );

  assert.deepEqual(result.rejected, { status: 'rejected', reason: 'project_not_present' });
  assert.deepEqual(result.after, result.before);
});

test('project reorder rejects an unknown anchor and leaves ranks unchanged', async () => {
  const result = await runWithDatabase(
    'reorder-project-anchor-missing',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha] = yield* insertProjects(['alpha', 'bravo']);
      const before = yield* readProjectRanks();
      const rejected = yield* repository.moveProjectOrder({
        projectId: alpha!,
        beforeProjectId: 999,
      });
      return { rejected, before, after: yield* readProjectRanks() };
    }),
  );

  assert.deepEqual(result.rejected, { status: 'rejected', reason: 'before_project_not_found' });
  assert.deepEqual(result.after, result.before);
});

test('project reorder rejects a missing project as an anchor', async () => {
  const result = await runWithDatabase(
    'reorder-project-anchor-not-present',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const [alpha, bravo] = yield* insertProjects(['alpha', 'bravo']);
      yield* repository.setProjectStatus({ id: bravo!, status: 'missing' });
      const before = yield* readProjectRanks();
      const rejected = yield* repository.moveProjectOrder({
        projectId: alpha!,
        beforeProjectId: bravo!,
      });
      return { rejected, before, after: yield* readProjectRanks() };
    }),
  );

  assert.deepEqual(result.rejected, { status: 'rejected', reason: 'before_project_not_present' });
  assert.deepEqual(result.after, result.before);
});

test('a worktree reorder moves a non-root sibling and never touches the root rank', async () => {
  const result = await runWithDatabase(
    'reorder-worktree-basic',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const project = yield* insertProjectWithWorktrees('isagi', ['one', 'two', 'three']);
      const [one, two, three] = project.linkedWorktreeIds;
      const moved = yield* repository.moveProjectWorktreeOrder({
        projectId: project.projectId,
        worktreeId: three!,
        beforeWorktreeId: one!,
      });
      return {
        moved,
        rootId: project.rootWorktreeId,
        two,
        ids: yield* listProjectWorktreeIds(project.projectId),
        ranks: yield* readWorktreeRanks(),
      };
    }),
  );

  assert.deepEqual(result.moved, { status: 'moved' });
  // The root keeps rank 0 and is not part of the compacted run; snapshot
  // composition pins it, so a rank collision here is harmless by design.
  assert.deepEqual(result.ranks, [
    { id: 1, sortOrder: 0 },
    { id: 2, sortOrder: 1 },
    { id: 3, sortOrder: 2 },
    { id: 4, sortOrder: 0 },
  ]);
  assert.deepEqual(result.ids, [1, 4, 2, 3]);
});

test('a null anchor appends a worktree after its non-root siblings', async () => {
  const ids = await runWithDatabase(
    'reorder-worktree-append',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const project = yield* insertProjectWithWorktrees('isagi', ['one', 'two', 'three']);
      const [one] = project.linkedWorktreeIds;
      yield* repository.moveProjectWorktreeOrder({
        projectId: project.projectId,
        worktreeId: one!,
        beforeWorktreeId: null,
      });
      return yield* listProjectWorktreeIds(project.projectId);
    }),
  );

  assert.deepEqual(ids, [1, 3, 4, 2]);
});

test('worktree reorder refuses to move the root worktree', async () => {
  const result = await runWithDatabase(
    'reorder-worktree-root-source',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const project = yield* insertProjectWithWorktrees('isagi', ['one', 'two']);
      const before = yield* readWorktreeRanks();
      const rejected = yield* repository.moveProjectWorktreeOrder({
        projectId: project.projectId,
        worktreeId: project.rootWorktreeId,
        beforeWorktreeId: null,
      });
      return { rejected, before, after: yield* readWorktreeRanks() };
    }),
  );

  assert.deepEqual(result.rejected, { status: 'rejected', reason: 'root_worktree_fixed' });
  assert.deepEqual(result.after, result.before);
});

test('worktree reorder refuses to place anything above the root worktree', async () => {
  const result = await runWithDatabase(
    'reorder-worktree-root-anchor',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const project = yield* insertProjectWithWorktrees('isagi', ['one', 'two']);
      const [, two] = project.linkedWorktreeIds;
      const before = yield* readWorktreeRanks();
      const rejected = yield* repository.moveProjectWorktreeOrder({
        projectId: project.projectId,
        worktreeId: two!,
        beforeWorktreeId: project.rootWorktreeId,
      });
      return { rejected, before, after: yield* readWorktreeRanks() };
    }),
  );

  assert.deepEqual(result.rejected, { status: 'rejected', reason: 'before_root_worktree_fixed' });
  assert.deepEqual(result.after, result.before);
});

test('worktree reorder reports a cross-project source as a mismatch, not as missing', async () => {
  const result = await runWithDatabase(
    'reorder-worktree-source-mismatch',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const first = yield* insertProjectWithWorktrees('alpha', ['one']);
      const second = yield* insertProjectWithWorktrees('bravo', ['two']);
      const before = yield* readWorktreeRanks();
      const rejected = yield* repository.moveProjectWorktreeOrder({
        projectId: first.projectId,
        worktreeId: second.linkedWorktreeIds[0]!,
        beforeWorktreeId: null,
      });
      return { rejected, before, after: yield* readWorktreeRanks() };
    }),
  );

  assert.deepEqual(result.rejected, { status: 'rejected', reason: 'worktree_project_mismatch' });
  assert.deepEqual(result.after, result.before);
});

test('worktree reorder reports a cross-project anchor as a mismatch', async () => {
  const result = await runWithDatabase(
    'reorder-worktree-anchor-mismatch',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const first = yield* insertProjectWithWorktrees('alpha', ['one']);
      const second = yield* insertProjectWithWorktrees('bravo', ['two']);
      const before = yield* readWorktreeRanks();
      const rejected = yield* repository.moveProjectWorktreeOrder({
        projectId: first.projectId,
        worktreeId: first.linkedWorktreeIds[0]!,
        beforeWorktreeId: second.linkedWorktreeIds[0]!,
      });
      return { rejected, before, after: yield* readWorktreeRanks() };
    }),
  );

  assert.deepEqual(result.rejected, {
    status: 'rejected',
    reason: 'before_worktree_project_mismatch',
  });
  assert.deepEqual(result.after, result.before);
});

test('worktree reorder rejects unknown sources, unknown anchors, and unknown projects', async () => {
  const result = await runWithDatabase(
    'reorder-worktree-not-found',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const project = yield* insertProjectWithWorktrees('isagi', ['one']);
      const before = yield* readWorktreeRanks();
      const unknownProject = yield* repository.moveProjectWorktreeOrder({
        projectId: 999,
        worktreeId: project.linkedWorktreeIds[0]!,
        beforeWorktreeId: null,
      });
      const unknownSource = yield* repository.moveProjectWorktreeOrder({
        projectId: project.projectId,
        worktreeId: 999,
        beforeWorktreeId: null,
      });
      const unknownAnchor = yield* repository.moveProjectWorktreeOrder({
        projectId: project.projectId,
        worktreeId: project.linkedWorktreeIds[0]!,
        beforeWorktreeId: 999,
      });
      return {
        unknownProject,
        unknownSource,
        unknownAnchor,
        before,
        after: yield* readWorktreeRanks(),
      };
    }),
  );

  assert.deepEqual(result.unknownProject, { status: 'rejected', reason: 'project_not_found' });
  assert.deepEqual(result.unknownSource, { status: 'rejected', reason: 'worktree_not_found' });
  assert.deepEqual(result.unknownAnchor, {
    status: 'rejected',
    reason: 'before_worktree_not_found',
  });
  assert.deepEqual(result.after, result.before);
});

test('worktree reorder rejects a project that is not present', async () => {
  const result = await runWithDatabase(
    'reorder-worktree-project-not-present',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const project = yield* insertProjectWithWorktrees('isagi', ['one']);
      yield* repository.setProjectStatus({ id: project.projectId, status: 'missing' });
      const before = yield* readWorktreeRanks();
      const rejected = yield* repository.moveProjectWorktreeOrder({
        projectId: project.projectId,
        worktreeId: project.linkedWorktreeIds[0]!,
        beforeWorktreeId: null,
      });
      return { rejected, before, after: yield* readWorktreeRanks() };
    }),
  );

  assert.deepEqual(result.rejected, { status: 'rejected', reason: 'project_not_present' });
  assert.deepEqual(result.after, result.before);
});

test('a project with no root checkout treats every worktree as reorderable', async () => {
  const ids = await runWithDatabase(
    'reorder-worktree-rootless',
    Effect.gen(function* () {
      const repository = yield* WorkspaceRepository;
      const projectId = yield* repository.insertProject({
        name: 'isagi',
        rootPath: '/repo/isagi',
      });
      // Stale or externally damaged state: nothing sits at the project root.
      yield* repository.reconcileProjectWorktrees({
        projectId,
        discovered: [
          { path: '/repo/isagi-one', branch: 'one', head: 'aaa1111' },
          { path: '/repo/isagi-two', branch: 'two', head: 'bbb2222' },
        ],
      });
      const worktreeIds = yield* listProjectWorktreeIds(projectId);
      const moved = yield* repository.moveProjectWorktreeOrder({
        projectId,
        worktreeId: worktreeIds[1]!,
        beforeWorktreeId: worktreeIds[0]!,
      });
      assert.deepEqual(moved, { status: 'moved' });
      return yield* listProjectWorktreeIds(projectId);
    }),
  );

  assert.deepEqual(ids, [2, 1]);
});
