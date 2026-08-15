import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Either, type Layer } from 'effect';

import { RuntimeDatabase } from '../../persistence/index.js';
import { worktreeSurfaces } from '../../persistence/schema.js';
import { SurfaceOrderError, SurfaceRepository, SurfaceService } from '../index.js';
import { insertWorktree, testLayer } from './test-support.js';

/**
 * Surface reordering runs against a real database because the sibling list, the
 * parent check, and the rank rewrite all live inside one repository transaction.
 * These tests cover both halves of the seam: the accepted moves through the
 * repository, and the conversion of each rejection into a tagged domain error.
 */

/** Three surfaces on one worktree, in creation order. */
function threeSurfaces(worktreeId: number) {
  return Effect.gen(function* () {
    const surfaces = yield* SurfaceService;
    const ids: number[] = [];
    for (const titleBase of ['First', 'Second', 'Third']) {
      const created = yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase });
      ids.push(created.surfaceId);
    }
    return ids;
  });
}

function surfaceIdsInOrder(worktreeId: number) {
  return Effect.gen(function* () {
    const repository = yield* SurfaceRepository;
    return (yield* repository.listWorkspaceSurfaceMetadata)
      .filter((surface) => surface.worktreeId === worktreeId)
      .map((surface) => surface.id);
  });
}

/**
 * Displayed order can look untouched while stored ranks were rewritten, so the
 * rejection tests compare the raw column instead. Scrambling the ranks first is
 * what gives that comparison teeth: against an already-compact list a stray
 * normalization would write nothing and stay invisible.
 */
function readSurfaceRanks() {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_read_surface_ranks', (db) =>
      db
        .select({
          id: worktreeSurfaces.id,
          sortOrder: worktreeSurfaces.sortOrder,
          updatedAt: worktreeSurfaces.updatedAt,
        })
        .from(worktreeSurfaces)
        .orderBy(worktreeSurfaces.id)
        .all(),
    );
  });
}

function setSurfaceRank(surfaceId: number, sortOrder: number) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('test_set_surface_rank', (db) => {
      db.update(worktreeSurfaces)
        .set({ sortOrder })
        .where(eq(worktreeSurfaces.id, surfaceId))
        .run();
    });
  });
}

type SurfaceTestServices = Layer.Layer.Success<ReturnType<typeof testLayer>>;

function withSurfaces<A, E>(
  name: string,
  build: (worktreeId: number) => Effect.Effect<A, E, SurfaceTestServices>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), `isagi-surfaces-${name}-`));
  return Effect.runPromise(
    Effect.gen(function* () {
      const worktreeId = yield* insertWorktree('/repo/isagi');
      return yield* build(worktreeId);
    }).pipe(Effect.provide(testLayer(dataRoot))),
  ).finally(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });
}

test('moving a surface before an earlier sibling reorders the worktree list', async () => {
  const output = await withSurfaces('order-before', (worktreeId) =>
    Effect.gen(function* () {
      const surfaces = yield* SurfaceService;
      const [first, , third] = yield* threeSurfaces(worktreeId);
      const moved = yield* surfaces.moveSurfaceOrder({
        worktreeId,
        surfaceId: third!,
        beforeSurfaceId: first!,
      });
      return { moved, ids: yield* surfaceIdsInOrder(worktreeId) };
    }),
  );

  assert.deepEqual(output.moved, { worktreeId: 1, surfaceId: 3 });
  assert.deepEqual(output.ids, [3, 1, 2]);
});

test('a null anchor appends the surface to the end of its worktree', async () => {
  const ids = await withSurfaces('order-append', (worktreeId) =>
    Effect.gen(function* () {
      const surfaces = yield* SurfaceService;
      const [first] = yield* threeSurfaces(worktreeId);
      yield* surfaces.moveSurfaceOrder({
        worktreeId,
        surfaceId: first!,
        beforeSurfaceId: null,
      });
      return yield* surfaceIdsInOrder(worktreeId);
    }),
  );

  assert.deepEqual(ids, [2, 3, 1]);
});

test('moving a surface before itself succeeds and leaves the order alone', async () => {
  const output = await withSurfaces('order-self', (worktreeId) =>
    Effect.gen(function* () {
      const surfaces = yield* SurfaceService;
      const [, second] = yield* threeSurfaces(worktreeId);
      const moved = yield* surfaces.moveSurfaceOrder({
        worktreeId,
        surfaceId: second!,
        beforeSurfaceId: second!,
      });
      return { moved, ids: yield* surfaceIdsInOrder(worktreeId) };
    }),
  );

  assert.deepEqual(output.moved, { worktreeId: 1, surfaceId: 2 });
  assert.deepEqual(output.ids, [1, 2, 3]);
});

test('a surface from another worktree is rejected rather than adopted', async () => {
  const output = await withSurfaces('order-foreign-surface', (worktreeId) =>
    Effect.gen(function* () {
      const surfaces = yield* SurfaceService;
      yield* threeSurfaces(worktreeId);
      const otherWorktreeId = yield* insertWorktree('/repo/other');
      const foreign = yield* surfaces.createSinglePaneSurface({
        worktreeId: otherWorktreeId,
        titleBase: 'Elsewhere',
      });
      yield* setSurfaceRank(1, 7);
      yield* setSurfaceRank(2, 9);
      const ranksBefore = yield* readSurfaceRanks();

      const rejected = yield* surfaces
        .moveSurfaceOrder({ worktreeId, surfaceId: foreign.surfaceId, beforeSurfaceId: null })
        .pipe(Effect.either);
      return {
        rejected,
        ranksBefore,
        ranksAfter: yield* readSurfaceRanks(),
        ids: yield* surfaceIdsInOrder(worktreeId),
      };
    }),
  );

  assert.equal(Either.isLeft(output.rejected), true);
  if (Either.isLeft(output.rejected)) {
    assert.ok(output.rejected.left instanceof SurfaceOrderError);
    assert.equal(output.rejected.left.reason, 'surface_worktree_mismatch');
  }
  assert.deepEqual(output.ids, [3, 1, 2]);
  assert.deepEqual(output.ranksAfter, output.ranksBefore);
});

test('an anchor from another worktree is rejected and the order is untouched', async () => {
  const output = await withSurfaces('order-foreign-anchor', (worktreeId) =>
    Effect.gen(function* () {
      const surfaces = yield* SurfaceService;
      const [first] = yield* threeSurfaces(worktreeId);
      const otherWorktreeId = yield* insertWorktree('/repo/other');
      const foreign = yield* surfaces.createSinglePaneSurface({
        worktreeId: otherWorktreeId,
        titleBase: 'Elsewhere',
      });
      yield* setSurfaceRank(1, 7);
      yield* setSurfaceRank(2, 9);
      const ranksBefore = yield* readSurfaceRanks();

      const rejected = yield* surfaces
        .moveSurfaceOrder({
          worktreeId,
          surfaceId: first!,
          beforeSurfaceId: foreign.surfaceId,
        })
        .pipe(Effect.either);
      return {
        rejected,
        ranksBefore,
        ranksAfter: yield* readSurfaceRanks(),
        ids: yield* surfaceIdsInOrder(worktreeId),
      };
    }),
  );

  assert.equal(Either.isLeft(output.rejected), true);
  if (Either.isLeft(output.rejected)) {
    assert.ok(output.rejected.left instanceof SurfaceOrderError);
    assert.equal(output.rejected.left.reason, 'before_surface_worktree_mismatch');
    assert.equal(output.rejected.left.beforeSurfaceId, 4);
  }
  assert.deepEqual(output.ids, [3, 1, 2]);
  assert.deepEqual(output.ranksAfter, output.ranksBefore);
});

test('unknown worktrees, surfaces, and anchors each get their own reason', async () => {
  const output = await withSurfaces('order-not-found', (worktreeId) =>
    Effect.gen(function* () {
      const surfaces = yield* SurfaceService;
      const [first] = yield* threeSurfaces(worktreeId);
      yield* setSurfaceRank(1, 7);
      yield* setSurfaceRank(2, 9);
      const ranksBefore = yield* readSurfaceRanks();
      const unknownWorktree = yield* surfaces
        .moveSurfaceOrder({ worktreeId: 999, surfaceId: first!, beforeSurfaceId: null })
        .pipe(Effect.either);
      const unknownSurface = yield* surfaces
        .moveSurfaceOrder({ worktreeId, surfaceId: 999, beforeSurfaceId: null })
        .pipe(Effect.either);
      const unknownAnchor = yield* surfaces
        .moveSurfaceOrder({ worktreeId, surfaceId: first!, beforeSurfaceId: 999 })
        .pipe(Effect.either);
      return {
        unknownWorktree,
        unknownSurface,
        unknownAnchor,
        ranksBefore,
        ranksAfter: yield* readSurfaceRanks(),
        ids: yield* surfaceIdsInOrder(worktreeId),
      };
    }),
  );

  const reasons = [output.unknownWorktree, output.unknownSurface, output.unknownAnchor].map(
    (result) =>
      Either.isLeft(result) && result.left instanceof SurfaceOrderError
        ? result.left.reason
        : 'unexpected_success',
  );
  assert.deepEqual(reasons, [
    'worktree_not_found',
    'surface_not_found',
    'before_surface_not_found',
  ]);
  assert.deepEqual(output.ids, [3, 1, 2]);
  assert.deepEqual(output.ranksAfter, output.ranksBefore);
});

test('a surface created after a reorder appends below the user-established order', async () => {
  const output = await withSurfaces('order-create-appends', (worktreeId) =>
    Effect.gen(function* () {
      const surfaces = yield* SurfaceService;
      const [first, , third] = yield* threeSurfaces(worktreeId);
      // Third, First, Second — the maximum rank is now held by a surface that is
      // neither the newest nor the last created.
      yield* surfaces.moveSurfaceOrder({
        worktreeId,
        surfaceId: third!,
        beforeSurfaceId: first!,
      });
      const created = yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase: 'Fourth' });
      return { created: created.surfaceId, ids: yield* surfaceIdsInOrder(worktreeId) };
    }),
  );

  assert.deepEqual(output.ids, [3, 1, 2, output.created]);
});
