import assert from 'node:assert/strict';
import test from 'node:test';

import BetterSqlite from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Data, Effect, Exit } from 'effect';

import { DatabaseError, type RuntimeDrizzleDatabase } from './database.js';
import { makeRuntimeDatabase } from './testing.js';

class NameTaken extends Data.TaggedError('NameTaken')<{ readonly name: string }> {}

function openDatabase() {
  const client = new BetterSqlite(':memory:');
  client.exec('create table names (name text not null)');
  const database: RuntimeDrizzleDatabase = drizzle(client);
  return { client, service: makeRuntimeDatabase(database) };
}

const countNames = (database: RuntimeDrizzleDatabase) =>
  database.get<{ count: number }>(sql`select count(*) as count from names`).count;

test('an aborted transaction rolls back and fails with the typed error', async () => {
  const { client, service } = openDatabase();
  try {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.exit(
          service.transaction<void, NameTaken>('insert_name', (database, abort) => {
            database.run(sql`insert into names (name) values ('a')`);
            return abort(new NameTaken({ name: 'a' }));
          }),
        ),
      ),
    );

    assert.ok(Exit.isFailure(exit));
    assert.equal(exit.cause.reasons.length, 1);
    const reason = exit.cause.reasons[0];
    assert.ok(reason?._tag === 'Fail' && reason.error instanceof NameTaken);
    assert.equal(await Effect.runPromise(Effect.scoped(service.use('count_names', countNames))), 0);
  } finally {
    client.close();
  }
});

test('a transaction that throws rolls back and fails with DatabaseError', async () => {
  const { client, service } = openDatabase();
  try {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(
          service.transaction('insert_name', (database) => {
            database.run(sql`insert into names (name) values ('a')`);
            throw new Error('constraint violated');
          }),
        ),
      ),
    );

    assert.ok(failure instanceof DatabaseError);
    assert.equal(failure.operation, 'insert_name');
    assert.equal(await Effect.runPromise(Effect.scoped(service.use('count_names', countNames))), 0);
  } finally {
    client.close();
  }
});

test('a transaction that returns commits', async () => {
  const { client, service } = openDatabase();
  try {
    await Effect.runPromise(
      Effect.scoped(
        service.transaction('insert_name', (database) => {
          database.run(sql`insert into names (name) values ('a')`);
        }),
      ),
    );

    assert.equal(await Effect.runPromise(Effect.scoped(service.use('count_names', countNames))), 1);
  } finally {
    client.close();
  }
});
