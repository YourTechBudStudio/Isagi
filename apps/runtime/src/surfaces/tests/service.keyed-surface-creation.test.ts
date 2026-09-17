import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, type Layer } from 'effect';

import { RuntimeDatabase } from '../../persistence/index.js';
import { surfacePanes, worktreeSurfaces } from '../../persistence/schema.js';
import { SurfaceError, SurfaceRepository, SurfaceService, validateSurfaceTitle } from '../index.js';
import { insertWorktree, testLayer } from './test-support.js';

/**
 * Keyed single-pane surface creation, which is what lets a re-entering caller — a workflow
 * preparation retried after a crash — adopt the surface it already made instead of leaving a second
 * one behind. The key is the identity; the title is not, and stays duplicate-safe.
 */

type TestServices = Layer.Layer.Success<ReturnType<typeof testLayer>>;

function inDatabase<A, E>(label: string, effect: Effect.Effect<A, E, TestServices>) {
  const dataRoot = mkdtempSync(join(tmpdir(), `isagi-${label}-`));
  return Effect.runPromise(effect.pipe(Effect.provide(testLayer(dataRoot)))).finally(() =>
    rmSync(dataRoot, { recursive: true, force: true }),
  );
}

/** Both tables, because "adopted, not created again" has to be literal about what was written. */
function countRows() {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    return yield* database.use('test_count_rows', (db) => ({
      surfaces: db.select().from(worktreeSurfaces).all().length,
      panes: db.select().from(surfacePanes).all().length,
    }));
  });
}

describe('keyed single-pane surface creation', () => {
  test('a re-entry under the same key adopts the surface instead of creating a second', async () => {
    const result = await inDatabase(
      'keyed-surface-reentry',
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          titleBase: 'Implement story #44',
          creationKey: 'workflow-run-7-surface',
        });
        const afterFirst = yield* countRows();
        const second = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          titleBase: 'Implement story #44',
          creationKey: 'workflow-run-7-surface',
        });
        return { first, second, afterFirst, afterSecond: yield* countRows() };
      }),
    );

    assert.deepEqual(result.second, result.first);
    assert.deepEqual(result.afterFirst, { surfaces: 1, panes: 1 });
    assert.deepEqual(result.afterSecond, result.afterFirst);
    // Adoption returns the title that was written, not a `… 2` the duplicate-safe rule would have
    // produced had this been a second creation.
    assert.equal(result.second.title, 'Implement story #44');
  });

  test('the key is written to the surface row and never to its pane', async () => {
    const keys = await inDatabase(
      'keyed-surface-keyspace',
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const created = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          titleBase: 'Keyed',
          creationKey: 'workflow-run-8-surface',
        });
        const database = yield* RuntimeDatabase;
        return yield* database.use('test_read_keys', (db) => ({
          surface: db
            .select({ creationKey: worktreeSurfaces.creationKey })
            .from(worktreeSurfaces)
            .where(eq(worktreeSurfaces.id, created.surfaceId))
            .get()?.creationKey,
          pane: db
            .select({ creationKey: surfacePanes.creationKey })
            .from(surfacePanes)
            .where(eq(surfacePanes.id, created.paneId))
            .get()?.creationKey,
        }));
      }),
    );

    assert.equal(keys.surface, 'workflow-run-8-surface');
    // Pane keys are `splitPane`'s keyspace. Writing both would make one string resolvable through
    // two different lookups, which is exactly what the separate-tables rule exists to prevent.
    assert.equal(keys.pane, null);
  });

  test('an unkeyed creation leaves the column null and still duplicates titles safely', async () => {
    const result = await inDatabase(
      'keyed-surface-unkeyed',
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase: 'Pi' });
        const second = yield* surfaces.createSinglePaneSurface({ worktreeId, titleBase: 'Pi' });
        return { first, second, rows: yield* countRows() };
      }),
    );

    assert.equal(result.first.title, 'Pi');
    assert.equal(result.second.title, 'Pi 2');
    assert.notEqual(result.second.surfaceId, result.first.surfaceId);
    assert.deepEqual(result.rows, { surfaces: 2, panes: 2 });
  });

  test('a re-entry still adopts after the original pane was split off and closed', async () => {
    const result = await inDatabase(
      'keyed-surface-pane-closed',
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const surfaces = yield* SurfaceService;
        const first = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          titleBase: 'Implement story #44',
          creationKey: 'workflow-run-10-surface',
        });
        // The person splits the surface and closes the pane it was created with. Both are ordinary
        // supported edits, and `deleteSurfacePane` removes exactly that row without renumbering its
        // sibling — so nothing sits at sort order 0 any more.
        // Split at the repository, not through `splitPane`: the sibling pane's session is beside
        // the point here, and this is the write that actually appends a row above sort order 0.
        const split = yield* (yield* SurfaceRepository).splitSurfacePane({
          surfaceId: first.surfaceId,
          sourcePaneId: first.paneId,
          titleBase: 'Second',
          direction: 'right',
        });
        assert.ok(split);
        yield* surfaces.deleteSurfacePane({ surfaceId: first.surfaceId, paneId: first.paneId });
        // A preparation that crashed before recording its receipt re-enters here. It must adopt
        // the surface the key names, not fail and not create a second one.
        const reentry = yield* surfaces.createSinglePaneSurface({
          worktreeId,
          titleBase: 'Implement story #44',
          creationKey: 'workflow-run-10-surface',
        });
        return { first, split, reentry, rows: yield* countRows() };
      }),
    );

    assert.equal(result.reentry.surfaceId, result.first.surfaceId);
    // The surviving pane, which is the split one — the key names the surface, and the pane it was
    // created with no longer exists.
    assert.equal(result.reentry.paneId, result.split.paneId);
    assert.notEqual(result.reentry.paneId, result.first.paneId);
    assert.deepEqual(result.rows, { surfaces: 1, panes: 1 });
  });

  test('a key bound to another worktree is creation_key_mismatch and writes nothing', async () => {
    const result = await inDatabase(
      'keyed-surface-mismatch',
      Effect.gen(function* () {
        const owner = yield* insertWorktree('/repo/one');
        const other = yield* insertWorktree('/repo/two');
        const surfaces = yield* SurfaceService;
        yield* surfaces.createSinglePaneSurface({
          worktreeId: owner,
          titleBase: 'Keyed',
          creationKey: 'workflow-run-9-surface',
        });
        const before = yield* countRows();
        const error = yield* surfaces
          .createSinglePaneSurface({
            worktreeId: other,
            titleBase: 'Keyed',
            creationKey: 'workflow-run-9-surface',
          })
          .pipe(Effect.flip);
        return { error, before, after: yield* countRows() };
      }),
    );

    assert.ok(result.error instanceof SurfaceError);
    assert.equal(result.error.code, 'creation_key_mismatch');
    // An expected failure, not a defect: the caller reused a key against a destination it does not
    // name, and the wire contract has a reason for exactly that.
    assert.deepEqual(result.after, result.before);
  });

  test('a title that rename would refuse is refused at creation too', async () => {
    const errors = await inDatabase(
      'keyed-surface-title',
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
        return { blank, tooLong, trimmed, rows: yield* countRows() };
      }),
    );

    assert.ok(errors.blank instanceof SurfaceError);
    assert.equal(errors.blank.code, 'invalid_surface_title');
    assert.ok(errors.tooLong instanceof SurfaceError);
    assert.equal(errors.tooLong.code, 'invalid_surface_title');
    assert.equal(errors.trimmed.title, 'Trimmed');
    // Only the accepted title was written; neither rejection left a surface behind.
    assert.deepEqual(errors.rows, { surfaces: 1, panes: 1 });
  });

  test('the exported title rule is the one creation applies', async () => {
    // Re-exported so launch-time placement validation refuses a title by this rule rather than a
    // second copy of it. Asserted here so the export cannot quietly become a different function.
    assert.equal(await Effect.runPromise(validateSurfaceTitle('  Keep  ')), 'Keep');
    const error = await Effect.runPromise(Effect.flip(validateSurfaceTitle('')));
    assert.equal(error.code, 'invalid_surface_title');
  });
});
