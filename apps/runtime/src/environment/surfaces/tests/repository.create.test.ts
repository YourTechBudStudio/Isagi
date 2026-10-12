import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { type DatabaseError, RuntimeDatabase } from '../../../platform/persistence/index.js';
import { surfacePanes, worktreeEnvironmentStates, worktreeSurfaces } from '../../tables.js';
import { testLayer } from '../../testing.js';
import { SurfaceError } from '../errors.js';
import { SurfaceRepository } from '../repository.js';

/**
 * A creating transaction re-reads its worktree, so a worktree deleted after the service's own checks is refused
 * inside the transaction with the same `worktree_not_found` refusal, not reported as a database fault, and nothing is
 * written.
 */
async function refusalFor(
  create: (
    surfaces: SurfaceRepository['Service'],
  ) => Effect.Effect<unknown, DatabaseError | SurfaceError>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-surface-create-'));
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const surfaces = yield* SurfaceRepository;
          const database = yield* RuntimeDatabase;
          const error = yield* Effect.flip(create(surfaces));
          const rows = yield* database.use('test_count_surface_rows', (db) => ({
            surfaces: db.select().from(worktreeSurfaces).all().length,
            panes: db.select().from(surfacePanes).all().length,
            focus: db.select().from(worktreeEnvironmentStates).all().length,
          }));
          return { error, rows };
        }).pipe(Effect.provide(testLayer(dataRoot))),
      ),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

for (const [name, create] of [
  [
    'a single-pane surface',
    (surfaces: SurfaceRepository['Service']) =>
      surfaces.createSinglePaneSurface({ worktreeId: 404, titleBase: 'Terminal' }),
  ],
  [
    'an empty surface',
    (surfaces: SurfaceRepository['Service']) =>
      surfaces.createEmptySurface({ worktreeId: 404, titleBase: 'Scratch' }),
  ],
] as const) {
  test(`creating ${name} in a missing worktree is refused with worktree_not_found and writes nothing`, async () => {
    const { error, rows } = await refusalFor(create);

    assert.ok(error instanceof SurfaceError);
    assert.deepEqual(
      { code: error.code, worktreeId: error.worktreeId, message: error.message },
      { code: 'worktree_not_found', worktreeId: 404, message: 'Worktree 404 was not found.' },
    );
    assert.deepEqual(rows, { surfaces: 0, panes: 0, focus: 0 });
  });
}
