import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Either, Layer } from 'effect';

import { EntityLockLive } from '../lib/locks/entity-lock.js';
import { SessionLifecycle, SessionLifecycleLive } from './index.js';

// Restore exclusion is delegated to the shared per-entity lock, so the layer
// under test needs one. Every test builds its own; nothing here depends on the
// instance being shared with another domain.
const lifecycleLayer = SessionLifecycleLive.pipe(Layer.provide(EntityLockLive));

const agentKey = { kind: 'agent_session' as const, sessionId: 10 };
const otherAgentKey = { kind: 'agent_session' as const, sessionId: 11 };

test('attach tokens are single use', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* SessionLifecycle;
      const token = yield* lifecycle.issueAttachToken(agentKey);
      const first = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: token.token })
        .pipe(Effect.either);
      const second = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: token.token })
        .pipe(Effect.either);
      return { first, second };
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.equal(Either.isRight(result.first), true);
  assert.equal(Either.isLeft(result.second), true);
  if (Either.isLeft(result.second)) assert.equal(result.second.left.code, 'attach_token_invalid');
});

test('issuing multiple tokens keeps unresolved attach attempts independent', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* SessionLifecycle;
      const firstToken = yield* lifecycle.issueAttachToken(agentKey);
      const secondToken = yield* lifecycle.issueAttachToken(agentKey);
      const first = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: firstToken.token })
        .pipe(Effect.either);
      const second = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: secondToken.token })
        .pipe(Effect.either);
      return { first, second };
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.equal(Either.isRight(result.first), true);
  assert.equal(Either.isRight(result.second), true);
});

test('revoking attach tokens invalidates all outstanding tokens for a session', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* SessionLifecycle;
      const firstToken = yield* lifecycle.issueAttachToken(agentKey);
      const secondToken = yield* lifecycle.issueAttachToken(agentKey);
      yield* lifecycle.revokeAttachTokens(agentKey);
      const first = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: firstToken.token })
        .pipe(Effect.either);
      const second = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: secondToken.token })
        .pipe(Effect.either);
      return { first, second };
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.equal(Either.isLeft(result.first), true);
  assert.equal(Either.isLeft(result.second), true);
});

test('attach tokens expire after five minutes', async () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* SessionLifecycle;
        const token = yield* lifecycle.issueAttachToken(agentKey);
        Date.now = () => 1_000 + 5 * 60 * 1000 + 1;
        return yield* lifecycle
          .consumeAttachToken({ key: agentKey, token: token.token })
          .pipe(Effect.either);
      }).pipe(Effect.provide(lifecycleLayer)),
    );

    assert.equal(Either.isLeft(result), true);
    if (Either.isLeft(result)) assert.equal(result.left.code, 'attach_token_expired');
  } finally {
    Date.now = originalNow;
  }
});

test('token consumption rejects session mismatches and still consumes the token', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* SessionLifecycle;
      const token = yield* lifecycle.issueAttachToken(agentKey);
      const mismatch = yield* lifecycle
        .consumeAttachToken({ key: otherAgentKey, token: token.token })
        .pipe(Effect.either);
      const retry = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: token.token })
        .pipe(Effect.either);
      return { mismatch, retry };
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.equal(Either.isLeft(result.mismatch), true);
  if (Either.isLeft(result.mismatch))
    assert.equal(result.mismatch.left.code, 'attach_token_session_mismatch');
  assert.equal(Either.isLeft(result.retry), true);
});

test('superseding an active attachment invokes the moved handle once', async () => {
  const movedCount = await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* SessionLifecycle;
      let moved = 0;
      yield* lifecycle.registerActiveAttachment({
        key: agentKey,
        handle: { moved: Effect.sync(() => moved++) },
      });
      yield* lifecycle.supersedeAttachment(agentKey);
      yield* lifecycle.supersedeAttachment(agentKey);
      return moved;
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.equal(movedCount, 1);
});

test('restore locks serialize work by durable session key only', async () => {
  const order = await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* SessionLifecycle;
      const events: string[] = [];
      const locked = (name: string) =>
        lifecycle.withRestoreLock(
          agentKey,
          Effect.gen(function* () {
            events.push(`${name}:start`);
            yield* Effect.sleep('20 millis');
            events.push(`${name}:end`);
          }),
        );
      yield* Effect.all([locked('a'), locked('b')], { concurrency: 'unbounded' });
      return events;
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});
