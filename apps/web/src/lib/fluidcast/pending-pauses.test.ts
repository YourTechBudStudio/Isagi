import assert from 'node:assert/strict';
import test from 'node:test';

import { Deferred, Duration, Effect, Fiber, Logger } from 'effect';

import { makePendingPauses, pauseSettleBound } from './pending-pauses.js';

interface Logged {
  readonly level: string;
  readonly message: unknown;
}

/** Runs `effect` recording every log entry, so a test can assert what was (not) logged. */
const runLogged = <A, E>(effect: Effect.Effect<A, E>) => {
  const logs: Logged[] = [];
  const logger = Logger.make((options) => {
    logs.push({ level: options.logLevel, message: options.message });
  });
  return Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([logger])))).then((value) => ({
    value,
    logs,
  }));
};

const id = 'fc-1';

test('the production bound is 2 s', () => {
  assert.equal(Duration.toMillis(pauseSettleBound), 2000);
});

test('settled is immediate with no pause outstanding', async () => {
  const pauses = makePendingPauses();
  const { logs } = await runLogged(pauses.settled(id));
  assert.deepEqual(logs, []);
});

test('settled waits for an outstanding pause to land', async () => {
  const pauses = makePendingPauses();
  const order: string[] = [];

  await runLogged(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const pause = yield* Effect.forkChild(
        pauses.track(
          id,
          Deferred.await(gate).pipe(Effect.tap(() => Effect.sync(() => order.push('paused')))),
        ),
      );
      yield* Effect.yieldNow;
      const waiter = yield* Effect.forkChild(
        pauses.settled(id).pipe(Effect.tap(() => Effect.sync(() => order.push('subscribed')))),
      );
      yield* Effect.yieldNow;
      assert.deepEqual(order, []);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(waiter);
      yield* Fiber.join(pause);
    }),
  );

  assert.deepEqual(order, ['paused', 'subscribed']);
});

test('two pauses that land out of order: settled waits for both', async () => {
  const pauses = makePendingPauses();
  const order: string[] = [];

  await runLogged(
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const track = (gate: Deferred.Deferred<void>, name: string) =>
        Effect.forkChild(
          pauses.track(
            id,
            Deferred.await(gate).pipe(Effect.tap(() => Effect.sync(() => order.push(name)))),
          ),
        );
      yield* track(first, 'first');
      yield* track(second, 'second');
      yield* Effect.yieldNow;
      const waiter = yield* Effect.forkChild(
        pauses.settled(id).pipe(Effect.tap(() => Effect.sync(() => order.push('subscribed')))),
      );
      yield* Effect.yieldNow;
      // The later pause lands first; one landing must not release the subscription.
      yield* Deferred.succeed(second, undefined);
      yield* Effect.yieldNow;
      assert.deepEqual(order, ['second']);
      yield* Deferred.succeed(first, undefined);
      yield* Fiber.join(waiter);
    }),
  );

  assert.deepEqual(order, ['second', 'first', 'subscribed']);
});

test('another session’s pause does not hold a subscription back', async () => {
  const pauses = makePendingPauses();

  await runLogged(
    Effect.gen(function* () {
      // Detached: a tracked pause is uninterruptible, so a child fiber would keep the test alive.
      yield* Effect.forkDetach(pauses.track('other', Effect.never));
      yield* Effect.yieldNow;
      yield* pauses.settled(id);
    }),
  );
});

test('a pause that never lands releases the subscription at the bound, with a Warning', async () => {
  const pauses = makePendingPauses({ bound: Duration.millis(20) });

  const { logs } = await runLogged(
    Effect.gen(function* () {
      yield* Effect.forkDetach(pauses.track(id, Effect.never));
      yield* Effect.yieldNow;
      yield* pauses.settled(id);
    }),
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, 'Warn');
  assert.match(String(logs[0]?.message), /did not settle/);
});

test('a failed pause still releases the subscription, with a Warning, and settled never fails', async () => {
  const pauses = makePendingPauses();

  const { logs } = await runLogged(
    Effect.gen(function* () {
      yield* pauses.track(id, Effect.fail(new Error('boom')));
      // Already settled, so nothing outstanding.
      yield* pauses.settled(id);
      const gate = yield* Deferred.make<void>();
      yield* Effect.forkChild(
        pauses.track(id, Deferred.await(gate).pipe(Effect.andThen(Effect.fail('nope')))),
      );
      yield* Effect.yieldNow;
      const waiter = yield* Effect.forkChild(pauses.settled(id));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(waiter);
    }),
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, 'Warn');
  assert.match(String(logs[0]?.message), /failed/);
});

test('a tracked pause is not cut by interrupting its caller', async () => {
  const pauses = makePendingPauses();
  let landed = false;

  await runLogged(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        pauses.track(
          id,
          Deferred.await(gate).pipe(Effect.tap(() => Effect.sync(() => (landed = true)))),
        ),
      );
      yield* Effect.yieldNow;
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(interrupting);
    }),
  );

  assert.equal(landed, true);
});
