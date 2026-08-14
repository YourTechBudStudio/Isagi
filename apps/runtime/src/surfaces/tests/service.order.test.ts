import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either, type Layer } from 'effect';

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

      const rejected = yield* surfaces
        .moveSurfaceOrder({ worktreeId, surfaceId: foreign.surfaceId, beforeSurfaceId: null })
        .pipe(Effect.either);
      return { rejected, ids: yield* surfaceIdsInOrder(worktreeId) };
    }),
  );

  assert.equal(Either.isLeft(output.rejected), true);
  if (Either.isLeft(output.rejected)) {
    assert.ok(output.rejected.left instanceof SurfaceOrderError);
    assert.equal(output.rejected.left.reason, 'surface_worktree_mismatch');
  }
  assert.deepEqual(output.ids, [1, 2, 3]);
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

      const rejected = yield* surfaces
        .moveSurfaceOrder({
          worktreeId,
          surfaceId: first!,
          beforeSurfaceId: foreign.surfaceId,
        })
        .pipe(Effect.either);
      return { rejected, ids: yield* surfaceIdsInOrder(worktreeId) };
    }),
  );

  assert.equal(Either.isLeft(output.rejected), true);
  if (Either.isLeft(output.rejected)) {
    assert.ok(output.rejected.left instanceof SurfaceOrderError);
    assert.equal(output.rejected.left.reason, 'before_surface_worktree_mismatch');
    assert.equal(output.rejected.left.beforeSurfaceId, 4);
  }
  assert.deepEqual(output.ids, [1, 2, 3]);
});

test('unknown worktrees, surfaces, and anchors each get their own reason', async () => {
  const output = await withSurfaces('order-not-found', (worktreeId) =>
    Effect.gen(function* () {
      const surfaces = yield* SurfaceService;
      const [first] = yield* threeSurfaces(worktreeId);
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
  assert.deepEqual(output.ids, [1, 2, 3]);
});
