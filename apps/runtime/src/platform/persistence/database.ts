import BetterSqlite from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Context, Data, Effect, Layer } from 'effect';

import { describeSafely, type SafeDiagnostic } from '../diagnostics/index.js';
import { DataDirectory } from './data-directory.js';
import { migrationsDirectory } from './migrations.js';

const applicationId = 0x49534147; // ISAG
const schemaVersion = 1;

/**
 * Schema-less on purpose: every table lives in its owning module's `tables.ts`, and queries import
 * the tables they use. Only `db.query.*` needs a schema object, and the runtime does not use it.
 */
export type RuntimeDrizzleDatabase = BetterSQLite3Database;

type RuntimeDatabaseClient = BetterSqlite.Database;

export class DatabaseError
  extends Data.TaggedError('DatabaseError')<{
    readonly cause: unknown;
    readonly operation: string;
  }>
  implements SafeDiagnostic
{
  [describeSafely]() {
    return { label: `Database operation ${this.operation} failed`, cause: this.cause };
  }
}

const make = Effect.gen(function* () {
  const directory = yield* DataDirectory;
  const resource = yield* Effect.acquireRelease(
    Effect.try({
      try: () => openRuntimeDatabase(directory.paths.databasePath),
      catch: (cause) => new DatabaseError({ operation: 'open_database', cause }),
    }),
    ({ client }) => Effect.sync(() => client.close()),
  );

  return makeRuntimeDatabase(resource.database);
});

/** Thrown by a transaction's `abort` so the rollback carries the caller's typed error out of better-sqlite3. */
class TransactionAbort {
  constructor(readonly error: unknown) {}
}

/** The service over an open Drizzle database. Exported for test doubles through `testing.ts`. */
export function makeRuntimeDatabase(database: RuntimeDrizzleDatabase): RuntimeDatabase['Service'] {
  return RuntimeDatabase.of({
    use: (operation, run) =>
      Effect.try({
        try: () => run(database),
        catch: (cause) => new DatabaseError({ operation, cause }),
      }),
    transaction: <A, E = never>(
      operation: string,
      run: (database: RuntimeDrizzleDatabase, abort: (error: E) => never) => A,
    ) =>
      Effect.try({
        try: () =>
          database.transaction((transaction) =>
            run(transaction as unknown as RuntimeDrizzleDatabase, (error) => {
              throw new TransactionAbort(error);
            }),
          ),
        catch: (cause): DatabaseError | E =>
          cause instanceof TransactionAbort
            ? (cause.error as E)
            : new DatabaseError({ operation, cause }),
      }),
  });
}

/**
 * The runtime's SQLite database.
 *
 * The driver is synchronous and single-connection: `use` and `transaction` callbacks run synchronously, so never
 * `yield*` or `await` inside them and never run an Effect inside a transaction. Transactions are therefore serialised,
 * and interruption cannot land mid-transaction.
 */
export class RuntimeDatabase extends Context.Service<
  RuntimeDatabase,
  {
    readonly use: <A>(
      operation: string,
      run: (database: RuntimeDrizzleDatabase) => A,
    ) => Effect.Effect<A, DatabaseError>;
    /**
     * Runs `run` inside one SQLite transaction. `abort(error)` rolls back and fails with `error`; any other throw rolls
     * back and fails with `DatabaseError`.
     */
    readonly transaction: <A, E = never>(
      operation: string,
      run: (database: RuntimeDrizzleDatabase, abort: (error: E) => never) => A,
    ) => Effect.Effect<A, DatabaseError | E>;
  }
>()('isagi/runtime/platform/persistence/RuntimeDatabase') {
  static readonly layer = Layer.effect(RuntimeDatabase, make);
}

function openRuntimeDatabase(path: string): {
  readonly client: RuntimeDatabaseClient;
  readonly database: RuntimeDrizzleDatabase;
} {
  const client = new BetterSqlite(path, { timeout: 5000 });
  client.pragma('journal_mode = WAL');
  client.pragma('synchronous = NORMAL');
  client.pragma('foreign_keys = ON');
  client.pragma('busy_timeout = 5000');
  client.pragma('temp_store = MEMORY');
  client.pragma('journal_size_limit = 67108864');
  client.pragma(`application_id = ${applicationId}`);
  client.pragma(`user_version = ${schemaVersion}`);

  const database = drizzle(client);
  migrate(database, { migrationsFolder: migrationsDirectory() });

  return { client, database };
}
