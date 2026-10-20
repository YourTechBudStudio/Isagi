import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, Result } from 'effect';

import { EntityLock } from '../../platform/locks/index.js';
import { SessionLifecycle } from './lifecycle.js';

// Restore exclusion is delegated to the shared per-entity lock, so the layer
// under test needs one. Every test builds its own; nothing here depends on the
// instance being shared with another domain.
const lifecycleLayer = SessionLifecycle.layerNoDeps.pipe(Layer.provide(EntityLock.layer));

const agentKey = { kind: 'agent_session' as const, sessionId: 10 };
const otherAgentKey = { kind: 'agent_session' as const, sessionId: 11 };

test('attach tokens are single use', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* SessionLifecycle;
      const token = yield* lifecycle.issueAttachToken(agentKey);
      const first = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: token.token })
        .pipe(Effect.result);
      const second = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: token.token })
        .pipe(Effect.result);
      return { first, second };
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.equal(Result.isSuccess(result.first), true);
  assert.equal(Result.isFailure(result.second), true);
  if (Result.isFailure(result.second))
    assert.equal(result.second.failure.code, 'attach_token_invalid');
});

test('issuing multiple tokens keeps unresolved attach attempts independent', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* SessionLifecycle;
      const firstToken = yield* lifecycle.issueAttachToken(agentKey);
      const secondToken = yield* lifecycle.issueAttachToken(agentKey);
      const first = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: firstToken.token })
        .pipe(Effect.result);
      const second = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: secondToken.token })
        .pipe(Effect.result);
      return { first, second };
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.equal(Result.isSuccess(result.first), true);
  assert.equal(Result.isSuccess(result.second), true);
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
        .pipe(Effect.result);
      const second = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: secondToken.token })
        .pipe(Effect.result);
      return { first, second };
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.equal(Result.isFailure(result.first), true);
  assert.equal(Result.isFailure(result.second), true);
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
          .pipe(Effect.result);
      }).pipe(Effect.provide(lifecycleLayer)),
    );

    assert.equal(Result.isFailure(result), true);
    if (Result.isFailure(result)) assert.equal(result.failure.code, 'attach_token_expired');
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
        .pipe(Effect.result);
      const retry = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: token.token })
        .pipe(Effect.result);
      return { mismatch, retry };
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.equal(Result.isFailure(result.mismatch), true);
  if (Result.isFailure(result.mismatch))
    assert.equal(result.mismatch.failure.code, 'attach_token_session_mismatch');
  assert.equal(Result.isFailure(result.retry), true);
});

test('superseding an active attachment invokes the moved handle once', async () => {
  const movedCount = await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* SessionLifecycle;
      let moved = 0;
      yield* lifecycle.registerActiveAttachment({
        key: agentKey,
        handle: { moved: Effect.sync(() => moved++) },
        incarnation: 'pty:20',
      });
      yield* lifecycle.supersedeAttachment(agentKey);
      yield* lifecycle.supersedeAttachment(agentKey);
      return moved;
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.equal(movedCount, 1);
});

test('an automatic re-attach displaces a lingering older attachment but never the current holder', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* SessionLifecycle;
      let moved = 0;
      const register = (incarnation: 'pty:20' | 'pty:21') =>
        lifecycle.registerActiveAttachment({
          key: agentKey,
          handle: { moved: Effect.sync(() => moved++) },
          incarnation,
        });
      // The pane's own socket to the process it watched exit is still open, and a Reconnect
      // elsewhere has claimed but not yet connected.
      yield* register('pty:20');
      const pendingExplicit = yield* lifecycle.issueAttachToken(agentKey);
      const lingering = yield* lifecycle
        .displaceObsoleteAttachment(agentKey, 'pty:21')
        .pipe(Effect.result);
      const pendingExplicitStillValid = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: pendingExplicit.token })
        .pipe(Effect.result);
      // Another window has since attached to the live process.
      yield* register('pty:21');
      const token = yield* lifecycle.issueAttachToken(agentKey);
      const held = yield* lifecycle
        .displaceObsoleteAttachment(agentKey, 'pty:21')
        .pipe(Effect.result);
      const tokenStillValid = yield* lifecycle
        .consumeAttachToken({ key: agentKey, token: token.token })
        .pipe(Effect.result);
      return { lingering, pendingExplicitStillValid, held, tokenStillValid, moved };
    }).pipe(Effect.provide(lifecycleLayer)),
  );

  assert.ok(Result.isSuccess(result.lingering));
  assert.ok(
    Result.isSuccess(result.pendingExplicitStillValid),
    'displacing an obsolete socket leaves a pending explicit attach its token',
  );
  assert.ok(Result.isFailure(result.held));
  assert.equal(result.held.failure.code, 'session_already_attached');
  assert.equal(result.moved, 1, 'only the lingering attachment was displaced');
  assert.ok(Result.isSuccess(result.tokenStillValid), "the holder's tokens are left alone");
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
