import { randomUUID } from 'node:crypto';

import { Context, Effect, Layer } from 'effect';

import { DatabaseError, RuntimeDatabase } from './database.service.js';
import { runtimeIdentity } from './schema.js';

/**
 * This runtime's own durable identity.
 *
 * It answers one question and exposes nothing else: *which runtime recorded this?* The id is
 * stamped on every operation row, so a database that someone copied off another machine explains
 * itself rather than looking like local history.
 *
 * The database owns it, not `state.json`. The state file resets itself to defaults on any parse
 * failure, which would silently mint a second identity for the same data root; the database is also
 * the artifact that actually travels when someone copies their work. So the id lives and dies with
 * the database file: it survives a state-file reset and a copy or restore of the data root, and
 * changes only when the database is recreated — in which case no operation rows precede it. Two
 * distinct `runtime_id` values in one database therefore always mean two runtimes.
 */
export interface RuntimeIdentityService {
  readonly runtimeId: string;
}

export const RuntimeIdentity = Context.GenericTag<RuntimeIdentityService>('isagi/RuntimeIdentity');

/**
 * Reads the single identity row, creating it on first start.
 *
 * `id` is a constant primary key rather than an autoincrement sequence, which is what makes a
 * concurrent second insert unable to create a second identity: the second writer conflicts on the
 * key and re-reads the winner instead of minting a rival id.
 */
export const RuntimeIdentityLive = Layer.effect(
  RuntimeIdentity,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const runtimeId = yield* database.transaction('runtime_read_or_create_identity', (db) => {
      const existing = db.select().from(runtimeIdentity).limit(1).get();
      if (existing) return existing.runtimeId;
      const created = db
        .insert(runtimeIdentity)
        .values({ id: 1, runtimeId: randomUUID(), createdAt: new Date().toISOString() })
        .onConflictDoNothing()
        .returning()
        .get();
      // `onConflictDoNothing` returns nothing when another writer won the race, so the winner is
      // re-read rather than assumed. There is exactly one row either way.
      return created?.runtimeId ?? db.select().from(runtimeIdentity).limit(1).get()?.runtimeId;
    });
    if (!runtimeId) {
      return yield* Effect.fail(
        new DatabaseError({
          operation: 'runtime_read_or_create_identity',
          cause: new Error(
            'runtime_identity holds no row after an insert that reported no conflict',
          ),
        }),
      );
    }
    return { runtimeId } satisfies RuntimeIdentityService;
  }),
);
