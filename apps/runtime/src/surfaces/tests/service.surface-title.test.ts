import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, type Layer } from 'effect';

import { RuntimeDatabase } from '../../persistence/index.js';
import { surfacePanes, worktreeSurfaces } from '../../persistence/schema.js';
import { SurfaceError, SurfaceService, validateSurfaceTitle } from '../index.js';
import { insertWorktree, testLayer } from './test-support.js';

type TestServices = Layer.Layer.Success<ReturnType<typeof testLayer>>;

function inDatabase<A, E>(label: string, effect: Effect.Effect<A, E, TestServices>) {
  const dataRoot = mkdtempSync(join(tmpdir(), `isagi-${label}-`));
  return Effect.runPromise(effect.pipe(Effect.provide(testLayer(dataRoot)))).finally(() =>
    rmSync(dataRoot, { recursive: true, force: true }),
  );
}

test('a title that rename would refuse is refused at creation too', async () => {
  const result = await inDatabase(
    'surface-title',
    Effect.gen(function* () {
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const surfaces = yield* SurfaceService;
      const blank = yield* surfaces
        .createSinglePaneSurface({ worktreeId, titleBase: '   ' })
        .pipe(Effect.flip);
      const tooLong = yield* surfaces
        .createSinglePaneSurface({ worktreeId, titleBase: 'x'.repeat(81) })
        .pipe(Effect.flip);
      const trimmed = yield* surfaces.createSinglePaneSurface({
        worktreeId,
        titleBase: '  Trimmed  ',
      });
      const database = yield* RuntimeDatabase;
      const rows = yield* database.use('test_count_rows', (db) => ({
        surfaces: db.select().from(worktreeSurfaces).all().length,
        panes: db.select().from(surfacePanes).all().length,
      }));
      return { blank, tooLong, trimmed, rows };
    }),
  );

  assert.ok(result.blank instanceof SurfaceError);
  assert.equal(result.blank.code, 'invalid_surface_title');
  assert.ok(result.tooLong instanceof SurfaceError);
  assert.equal(result.tooLong.code, 'invalid_surface_title');
  assert.equal(result.trimmed.title, 'Trimmed');
  // Only the accepted title was written; neither rejection left a surface behind.
  assert.deepEqual(result.rows, { surfaces: 1, panes: 1 });
});

test('the exported title rule is the one creation applies', async () => {
  // Re-exported so launch-time placement validation refuses a title by this rule rather than a
  // second copy of it.
  assert.equal(await Effect.runPromise(validateSurfaceTitle('  Keep  ')), 'Keep');
  const error = await Effect.runPromise(Effect.flip(validateSurfaceTitle('')));
  assert.equal(error.code, 'invalid_surface_title');
});
