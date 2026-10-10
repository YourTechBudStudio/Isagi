import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Clock, Console, Data, Effect, Fiber } from 'effect';
import { TestClock, TestConsole } from 'effect/testing';

import { runScoped, runWithTestClock } from './effect.js';

class ProbeFailure extends Data.TaggedError('ProbeFailure')<{ readonly reason: string }> {}

describe('runScoped', () => {
  test('resolves with the value and closes the scope before settling', async () => {
    const events: string[] = [];
    const value = await runScoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => events.push('finalized')));
        events.push('ran');
        return 42;
      }),
    );
    assert.equal(value, 42);
    assert.deepEqual(events, ['ran', 'finalized']);
  });

  test('rejects with the tagged failure itself, so assert.rejects can match its class', async () => {
    await assert.rejects(
      runScoped(Effect.fail(new ProbeFailure({ reason: 'boom' }))),
      ProbeFailure,
    );
  });

  test('rejects with the defect itself and still runs finalizers', async () => {
    let finalized = false;
    await assert.rejects(
      runScoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => (finalized = true)));
          return yield* Effect.die(new Error('defect text'));
        }),
      ),
      /defect text/,
    );
    assert.equal(finalized, true);
  });

  test('uses the live clock', async () => {
    const now = await runScoped(Clock.currentTimeMillis);
    assert.ok(Math.abs(now - Date.now()) < 5_000, `expected wall-clock time, got ${now}`);
  });
});

describe('runWithTestClock', () => {
  test('time moves only when the test adjusts the clock', async () => {
    const woke = await runWithTestClock(
      Effect.gen(function* () {
        const sleeper = yield* Effect.forkChild(Effect.as(Effect.sleep('1 hour'), 'awake'));
        yield* TestClock.adjust('59 minutes');
        assert.equal(sleeper.pollUnsafe(), undefined);
        yield* TestClock.adjust('1 minute');
        return yield* Fiber.join(sleeper);
      }),
    );
    assert.equal(woke, 'awake');
  });

  test('captures Console output instead of printing it', async () => {
    const lines = await runWithTestClock(
      Effect.gen(function* () {
        yield* Console.log('hello from the test');
        return yield* TestConsole.logLines;
      }),
    );
    assert.deepEqual(lines, ['hello from the test']);
  });

  test('gives every run a fresh clock', async () => {
    const first = await runWithTestClock(
      Effect.gen(function* () {
        yield* TestClock.adjust('10 seconds');
        return yield* Clock.currentTimeMillis;
      }),
    );
    const second = await runWithTestClock(Clock.currentTimeMillis);
    assert.equal(first, 10_000);
    assert.equal(second, 0);
  });

  test('rejects with the tagged failure itself and closes the scope', async () => {
    let finalized = false;
    await assert.rejects(
      runWithTestClock(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => (finalized = true)));
          return yield* new ProbeFailure({ reason: 'late' });
        }),
      ),
      (error: unknown) => error instanceof ProbeFailure && error.reason === 'late',
    );
    assert.equal(finalized, true);
  });
});
