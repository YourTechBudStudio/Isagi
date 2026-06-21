import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either } from 'effect';

import { SurfaceError, SurfaceService } from '../index.js';
import { insertWorktree, testLayer } from './test-support.js';

test('rename trims surface title, allows duplicates, and leaves pane title unchanged', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-rename-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });

        const renamed = yield* surfaces.renameSurface({
          surfaceId: first.surfaceId,
          title: '  Terminal 2  ',
        });
        return {
          renamed,
          detail: yield* surfaces.getSurfaceDetail(first.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.renamed, {
      surfaceId: output.detail.id,
      title: 'Terminal 2',
    });
    assert.equal(output.detail.title, 'Terminal 2');
    assert.equal(output.detail.panes[0]?.title, 'Terminal');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('rename rejects empty and overlong titles', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surfaces-rename-invalid-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const surface = yield* surfaces.createSinglePaneSurface({
          worktreeId,

          titleBase: 'Terminal',
        });
        const empty = yield* surfaces
          .renameSurface({ surfaceId: surface.surfaceId, title: '   ' })
          .pipe(Effect.either);
        const long = yield* surfaces
          .renameSurface({ surfaceId: surface.surfaceId, title: 'a'.repeat(81) })
          .pipe(Effect.either);
        return { empty, long };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(Either.isLeft(output.empty), true);
    assert.equal(Either.isLeft(output.long), true);
    if (Either.isLeft(output.empty)) {
      assert.ok(output.empty.left instanceof SurfaceError);
      assert.equal(output.empty.left.code, 'invalid_surface_title');
    }
    if (Either.isLeft(output.long)) {
      assert.ok(output.long.left instanceof SurfaceError);
      assert.equal(output.long.left.code, 'invalid_surface_title');
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
