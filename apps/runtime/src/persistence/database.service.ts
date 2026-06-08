import BetterSqlite from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Context, Data, Effect, Layer } from 'effect';

import { DataDirectory } from './data-directory.service.js';
import { migrationsDirectory } from './migrations.js';
import * as schema from './schema.js';

const applicationId = 0x49534147; // ISAG
const schemaVersion = 1;

type RuntimeDrizzleDatabase = BetterSQLite3Database<typeof schema>;

type RuntimeDatabaseClient = BetterSqlite.Database;

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

export interface RuntimeDatabaseService {
  readonly use: <A>(
    operation: string,
    run: (database: RuntimeDrizzleDatabase) => A,
  ) => Effect.Effect<A, DatabaseError>;
  readonly transaction: <A>(
    operation: string,
    run: (database: RuntimeDrizzleDatabase) => A,
  ) => Effect.Effect<A, DatabaseError>;
}

export const RuntimeDatabase = Context.GenericTag<RuntimeDatabaseService>('isagi/RuntimeDatabase');

export const RuntimeDatabaseLive = Layer.scoped(
  RuntimeDatabase,
  Effect.gen(function* () {
    const directory = yield* DataDirectory;
    const resource = yield* Effect.acquireRelease(
      Effect.try({
        try: () => openRuntimeDatabase(directory.paths.databasePath),
        catch: (cause) => new DatabaseError({ operation: 'open_database', cause }),
      }),
      ({ client }) => Effect.sync(() => client.close()),
    );

    return {
      use: (operation, run) =>
        Effect.try({
          try: () => run(resource.database),
          catch: (cause) => new DatabaseError({ operation, cause }),
        }),
      transaction: (operation, run) =>
        Effect.try({
          try: () =>
            resource.database.transaction((transaction) =>
              run(transaction as unknown as RuntimeDrizzleDatabase),
            ),
          catch: (cause) => new DatabaseError({ operation, cause }),
        }),
    } satisfies RuntimeDatabaseService;
  }),
);

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

  const database = drizzle(client, { schema });
  migrate(database, { migrationsFolder: migrationsDirectory() });

  return { client, database };
}
