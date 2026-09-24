import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import BetterSqlite from 'better-sqlite3';
import { Effect, Layer } from 'effect';

import { DataDirectory } from './data-directory.service.js';
import { RuntimeDatabaseLive } from './database.service.js';
import { RuntimeIdentity, RuntimeIdentityLive } from './runtime-identity.service.js';
import { StateFile, StateFileLive } from './state-file.service.js';
import { makeTestDataDirectory } from './test-support.js';

const readIdentity = (directory: ReturnType<typeof makeTestDataDirectory>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* RuntimeIdentity;
      return identity.runtimeId;
    }).pipe(
      Effect.provide(
        RuntimeIdentityLive.pipe(
          Layer.provide(RuntimeDatabaseLive),
          Layer.provide(Layer.succeed(DataDirectory, directory)),
        ),
      ),
    ),
  );

/**
 * The whole point of the column: one database, one runtime id, for as long as that file exists.
 *
 * Each of the three claims below is a distinct way the id could have been silently duplicated, and
 * a duplicate is not a cosmetic defect — `runtime_id` is stamped on every operation row precisely so
 * that two values in one database can be read as "two runtimes", and an id that churned would make
 * that reading a lie about a single machine's own history.
 */
test('the runtime id is minted once and survives a reopen and a state-file reset', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-runtime-identity-'));
  const directory = makeTestDataDirectory(root);

  try {
    const first = await readIdentity(directory);
    assert.match(
      first,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      'A minted identity must be a real UUID, not a placeholder.',
    );

    // Closing and reopening the database is the ordinary case — every runtime restart does it.
    assert.equal(await readIdentity(directory), first, 'A reopen must not mint a second identity.');

    // The reason the database owns this rather than `state.json`: the state file resets itself to
    // defaults on any parse failure, which would silently mint a rival identity for the same data
    // root. Corrupting it here proves the identity does not travel with it.
    writeFileSync(directory.paths.statePath, '{ not json', 'utf8');
    const originalConsoleWarn = console.warn;
    console.warn = () => {};
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const stateFile = yield* StateFile;
          return yield* stateFile.read;
        }).pipe(Effect.provide(StateFileLive), Effect.provideService(DataDirectory, directory)),
      );
    } finally {
      console.warn = originalConsoleWarn;
    }
    assert.equal(
      await readIdentity(directory),
      first,
      'A state-file reset must not reach the runtime identity.',
    );

    // Exactly one row, so nothing can read a "latest" identity and get a different answer than the
    // service did.
    const inspect = new BetterSqlite(directory.paths.databasePath, { readonly: true });
    try {
      assert.deepEqual(inspect.prepare('SELECT id, runtime_id FROM runtime_identity').all(), [
        { id: 1, runtime_id: first },
      ]);
    } finally {
      inspect.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A recreated database is a new runtime, and must say so.
 *
 * This is the other half of the durability rule. The id is allowed — required — to change when the
 * database file is replaced, because no operation rows precede it in the new file; what must never
 * happen is the id changing while history that names the old one survives.
 */
test('a recreated database mints a new runtime id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-runtime-identity-'));
  const directory = makeTestDataDirectory(root);

  try {
    const first = await readIdentity(directory);
    rmSync(directory.paths.databasePath, { force: true });
    const second = await readIdentity(directory);
    assert.notEqual(second, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
