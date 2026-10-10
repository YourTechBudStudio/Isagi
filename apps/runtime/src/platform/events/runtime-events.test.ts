import assert from 'node:assert/strict';
import test from 'node:test';

import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from 'effect';

import type { RuntimeEvent } from '@isagi/contracts';
import { runScoped } from '@isagi/testing';

import { RuntimeEvents } from './runtime-events.js';
import { tapRuntimeEvents } from './testing.js';

test('runtime event bus publishes events to subscribers', async () => {
  const event = agentSessionChangedEvent(1);

  const received = await runScoped(
    Effect.gen(function* () {
      const eventBus = yield* RuntimeEvents;
      const subscription = yield* tapRuntimeEvents;
      yield* eventBus.publish(event);
      return yield* subscription.take;
    }).pipe(Effect.provide(RuntimeEvents.layer)),
  );

  assert.deepEqual(received, event);
});

test('subscribers receive events published after they subscribe, in order', async () => {
  const received = await runScoped(
    Effect.gen(function* () {
      const eventBus = yield* RuntimeEvents;
      // Published before anyone subscribed: nobody receives it.
      yield* eventBus.publish(agentSessionChangedEvent(0));
      const first = yield* tapRuntimeEvents;
      const second = yield* tapRuntimeEvents;
      for (const id of [1, 2, 3]) yield* eventBus.publish(agentSessionChangedEvent(id));
      const takeThree = (tap: typeof first) =>
        Effect.all([tap.take, tap.take, tap.take]).pipe(
          Effect.map((events) => events.map((event) => event.id)),
        );
      return { first: yield* takeThree(first), second: yield* takeThree(second) };
    }).pipe(Effect.provide(RuntimeEvents.layer)),
  );

  assert.deepEqual(received.first, ['evt_test_1', 'evt_test_2', 'evt_test_3']);
  assert.deepEqual(received.second, ['evt_test_1', 'evt_test_2', 'evt_test_3']);
});

test('a slow subscriber does not block publishers', async () => {
  // The bus is an unbounded PubSub: a subscriber that stops pulling only grows its own backlog. Publishers never wait
  // and other subscribers keep receiving every event.
  const count = 1_000;
  const result = await runScoped(
    Effect.gen(function* () {
      const eventBus = yield* RuntimeEvents;
      const release = yield* Deferred.make<void>();
      const slowStarted = yield* Deferred.make<void>();
      const slowEvents = yield* eventBus.subscribe;
      const slowReceived: string[] = [];
      const slow = yield* slowEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => slowReceived.push(event.id)).pipe(
            Effect.andThen(Deferred.succeed(slowStarted, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        ),
        Effect.forkScoped,
      );
      const fast = yield* tapRuntimeEvents;

      for (let id = 1; id <= count; id += 1) yield* eventBus.publish(agentSessionChangedEvent(id));
      yield* Deferred.await(slowStarted);

      const fastReceived: string[] = [];
      for (let id = 1; id <= count; id += 1) fastReceived.push((yield* fast.take).id);
      const slowReceivedWhileBlocked = slowReceived.length;
      yield* Fiber.interrupt(slow);
      return { fastReceived, slowReceivedWhileBlocked };
    }).pipe(Effect.provide(RuntimeEvents.layer)),
  );

  assert.equal(result.fastReceived.length, count);
  assert.equal(result.fastReceived.at(-1), `evt_test_${count}`);
  assert.equal(result.slowReceivedWhileBlocked, 1);
});

test('publishing after the bus shut down is a no-op', async () => {
  await runScoped(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(RuntimeEvents.layer, scope);
      const eventBus = Context.get(context, RuntimeEvents);
      const events = yield* eventBus.subscribe.pipe(Scope.provide(scope));
      const consumer = yield* events.pipe(Stream.runCollect, Effect.forkChild);
      yield* Scope.close(scope, Exit.void);

      // Neither fails nor interrupts the publisher.
      const published = yield* Effect.exit(eventBus.publish(agentSessionChangedEvent(1)));
      assert.ok(Exit.isSuccess(published));
      // The subscription ended with the bus; its consumer did not receive the late event.
      const consumed = yield* Fiber.await(consumer);
      assert.ok(Exit.isFailure(consumed) || consumed.value.length === 0);
    }),
  );
});

function agentSessionChangedEvent(id: number) {
  return {
    id: `evt_test_${id}`,
    type: 'agent_session_changed',
    occurredAt: '2026-06-12T00:00:00.000Z',
    payload: {
      agentSessionId: 1,
      worktreeId: 2,
      surfaceId: 3,
      paneId: 4,
      status: 'failed',
      statusReason: 'harness_metadata_missing',
      diagnosticCode: 'harness_metadata_missing',
    },
  } satisfies RuntimeEvent;
}
