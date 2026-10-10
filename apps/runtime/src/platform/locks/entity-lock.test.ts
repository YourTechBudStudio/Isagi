import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import {
  EntityLock,
  EntityLockLive,
  entityLockKeyId,
  type EntityLockHeld,
  type EntityLockKey,
  type EntityLockService,
} from './entity-lock.js';

const agentKey = { kind: 'agent_session', id: 10 } as const;
const otherAgentKey = { kind: 'agent_session', id: 11 } as const;
const editorKey = { kind: 'editor_context', id: 10 } as const;

// Records start/end around a sleep, so an interleaving is visible in the
// transcript rather than inferred from timing.
function recorded(lock: EntityLockService, key: EntityLockKey, name: string, events: string[]) {
  return lock.withLock(key, () =>
    Effect.gen(function* () {
      events.push(`${name}:start`);
      yield* Effect.sleep('20 millis');
      events.push(`${name}:end`);
    }),
  );
}

test('work on the same key serializes', async () => {
  const events = await Effect.runPromise(
    Effect.gen(function* () {
      const lock = yield* EntityLock;
      const transcript: string[] = [];
      yield* Effect.all(
        [recorded(lock, agentKey, 'a', transcript), recorded(lock, agentKey, 'b', transcript)],
        { concurrency: 'unbounded' },
      );
      return transcript;
    }).pipe(Effect.provide(EntityLockLive)),
  );

  assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('work on different ids of the same kind does not serialize', async () => {
  const events = await Effect.runPromise(
    Effect.gen(function* () {
      const lock = yield* EntityLock;
      const transcript: string[] = [];
      yield* Effect.all(
        [recorded(lock, agentKey, 'a', transcript), recorded(lock, otherAgentKey, 'b', transcript)],
        { concurrency: 'unbounded' },
      );
      return transcript;
    }).pipe(Effect.provide(EntityLockLive)),
  );

  assert.deepEqual(events, ['a:start', 'b:start', 'a:end', 'b:end']);
});

// The kinds are what keep two domains sharing one instance from colliding on a
// numeric id they each assign independently.
test('work on the same id under different kinds does not serialize', async () => {
  const events = await Effect.runPromise(
    Effect.gen(function* () {
      const lock = yield* EntityLock;
      const transcript: string[] = [];
      yield* Effect.all(
        [
          recorded(lock, agentKey, 'session', transcript),
          recorded(lock, editorKey, 'editor', transcript),
        ],
        { concurrency: 'unbounded' },
      );
      return transcript;
    }).pipe(Effect.provide(EntityLockLive)),
  );

  assert.deepEqual(events, ['session:start', 'editor:start', 'session:end', 'editor:end']);
});

test('the witness carries the exact key the lock was granted for', async () => {
  const held = await Effect.runPromise(
    Effect.gen(function* () {
      const lock = yield* EntityLock;
      return yield* lock.withLock(editorKey, (granted: EntityLockHeld) => Effect.succeed(granted));
    }).pipe(Effect.provide(EntityLockLive)),
  );

  assert.deepEqual(held.key, editorKey);
});

test('a witness cannot be forged outside the lock', () => {
  // A type-level assertion, checked by `pnpm typecheck` rather than at runtime:
  // the witness is what an operation that must run under a held lock asks for,
  // so a caller being able to mint one from a bare key would make the whole
  // parameter decorative. `@ts-expect-error` fails the build if this ever
  // compiles again.
  // @ts-expect-error a bare key is not proof the lock is held
  const forged: EntityLockHeld = { key: editorKey };
  assert.ok(forged);
});

test('key ids distinguish kind and id', () => {
  assert.equal(entityLockKeyId(agentKey), 'agent_session:10');
  assert.equal(entityLockKeyId(editorKey), 'editor_context:10');
  assert.notEqual(entityLockKeyId(agentKey), entityLockKeyId(editorKey));
});
