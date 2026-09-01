import { Context, Effect, Layer } from 'effect';

// Per-entity mutual exclusion for operations that must not interleave on the
// same durable entity, lifted out of `session-lifecycle.service.ts` so the two
// domains that need it cannot drift on the semantics.
//
// The keys are deliberately one closed union rather than an opaque string: a
// lock is only useful when every caller agrees on what it names, and a free-form
// key makes a typo a silent loss of exclusion rather than a compile error.

export type EntityLockKey =
  | { readonly kind: 'agent_session'; readonly id: number }
  | { readonly kind: 'terminal_session'; readonly id: number }
  | { readonly kind: 'editor_context'; readonly id: number };

/**
 * The brand that makes the witness unforgeable. It is declared, never defined,
 * and never exported, so the only expression in the program that satisfies
 * `EntityLockHeld` is the one `withLock` builds below: no other module can name
 * this symbol, and structural typing therefore cannot mint a witness from a
 * bare `{ key }`.
 */
declare const entityLockHeld: unique symbol;

/**
 * Proof, passed by value, that the caller is already inside `withLock` for
 * `key`.
 *
 * It exists so an operation that must run under a lock it does not itself take
 * can require that fact in its type instead of in a comment — and so that no
 * such operation is tempted to re-acquire a semaphore that is not reentrant.
 * Nothing reads the witness yet; it is part of the signature from the start
 * because adding the parameter later would mean editing every call site.
 *
 * The brand is what makes the name honest: a caller that has not held the lock
 * cannot construct this type at all, so a later key comparison is checking
 * *which* lock a genuine witness came from rather than whether it is genuine.
 */
export interface EntityLockHeld {
  readonly [entityLockHeld]: true;
  readonly key: EntityLockKey;
}

export interface EntityLockService {
  readonly withLock: <A, E, R>(
    key: EntityLockKey,
    run: (held: EntityLockHeld) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export const EntityLock = Context.GenericTag<EntityLockService>('isagi/EntityLock');

export function entityLockKeyId(key: EntityLockKey) {
  return `${key.kind}:${key.id}`;
}

/**
 * One instance per runtime scope, which is what makes "the same lock" a fact
 * rather than a convention: two domains that provide this same layer value
 * serialize against each other on a shared key.
 *
 * The map is cleared when the providing scope closes. The service owns no
 * background work and holds nothing but semaphores, so this is memory hygiene
 * at shutdown rather than a lifecycle guarantee — normal code cannot reach the
 * map once its scope is gone.
 */
export const EntityLockLive = Layer.scoped(
  EntityLock,
  Effect.gen(function* () {
    const semaphores = new Map<string, Effect.Semaphore>();

    const service: EntityLockService = {
      withLock: (key, run) =>
        Effect.gen(function* () {
          const keyId = entityLockKeyId(key);
          let semaphore = semaphores.get(keyId);
          if (!semaphore) {
            semaphore = yield* Effect.makeSemaphore(1);
            semaphores.set(keyId, semaphore);
          }
          // The one place a witness is created, and the only reason this file
          // asserts anything: the brand has no runtime representation, so the
          // value carries exactly the key and the cast is the proof.
          const held = { key } as EntityLockHeld;
          return yield* semaphore.withPermits(1)(run(held));
        }),
    };

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.sync(() => {
        semaphores.clear();
      }),
    );
  }),
);
