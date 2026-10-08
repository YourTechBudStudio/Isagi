import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import {
  DataDirectory,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type RuntimeDatabaseService,
} from '../persistence/index.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import { WorkflowRunErasure, WorkflowRunErasureLive } from './erasure.js';
import { countRunRows, seedProjectRuns } from './store/test-support.js';

/** Runs `body` against a real, migrated database in its own temp data root. */
function withDatabase(
  body: (
    database: RuntimeDatabaseService,
    erase: (projectId: number) => Effect.Effect<number, unknown>,
  ) => Effect.Effect<void, unknown>,
) {
  return async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-run-erasure-'));
    const layer = Layer.mergeAll(
      RuntimeDatabaseLive.pipe(
        Layer.provide(Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot))),
      ),
      WorkflowRunErasureLive,
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* RuntimeDatabase;
          const erasure = yield* WorkflowRunErasure;
          const erase = (projectId: number) =>
            database.transaction('erase', (db) =>
              erasure.eraseProjectRunsInTransaction(db, projectId),
            );
          yield* body(database, erase);
        }).pipe(Effect.provide(layer), Effect.scoped),
      );
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  };
}

test(
  "erasing a project removes its runs and every child row, and leaves other projects' runs alone",
  withDatabase((database, erase) =>
    Effect.gen(function* () {
      const { erased, kept } = yield* database.transaction('seed', (db) => ({
        erased: seedProjectRuns(db, 1, { runCount: 2 }).runIds,
        kept: seedProjectRuns(db, 2).runIds,
      }));
      const before = yield* database.use('count', (db) => countRunRows(db, erased));
      assert.deepEqual(before, {
        runs: 2,
        invocations: 2,
        executions: 2,
        operations: 2,
        events: 2,
        checkpoints: 2,
        artifacts: 1,
      });
      const keptBefore = yield* database.use('count', (db) => countRunRows(db, kept));

      assert.equal(yield* erase(1), 2);

      const after = yield* database.use('count', (db) => countRunRows(db, erased));
      assert.deepEqual(after, {
        runs: 0,
        invocations: 0,
        executions: 0,
        operations: 0,
        events: 0,
        checkpoints: 0,
        // The build catalog is shared and not the project's to erase.
        artifacts: 1,
      });
      assert.deepEqual(yield* database.use('count', (db) => countRunRows(db, kept)), keptBefore);
    }),
  ),
);

test(
  'erasing again, or erasing a project with no runs, erases nothing',
  withDatabase((database, erase) =>
    Effect.gen(function* () {
      yield* database.transaction('seed', (db) => seedProjectRuns(db, 1));
      assert.equal(yield* erase(1), 1);
      assert.equal(yield* erase(1), 0);
      assert.equal(yield* erase(404), 0);
    }),
  ),
);
