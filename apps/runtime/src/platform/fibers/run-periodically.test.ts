import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Ref } from 'effect';
import { TestClock } from 'effect/testing';

import { makeLogCapture, runWithTestClock } from '@isagi/testing';

import { runPeriodically } from './run-periodically.js';

test('the first tick runs one interval in, then once per interval', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const ticks = yield* Ref.make(0);
      yield* runPeriodically(
        'PTY status polling',
        '10 seconds',
        Ref.update(ticks, (n) => n + 1),
      );

      yield* TestClock.adjust('9 seconds');
      assert.equal(yield* Ref.get(ticks), 0);
      yield* TestClock.adjust('1 second');
      assert.equal(yield* Ref.get(ticks), 1);
      yield* TestClock.adjust('30 seconds');
      assert.equal(yield* Ref.get(ticks), 4);
    }),
  ));

test('a failed or dying tick is logged as Warn with its cause and the next tick runs', () => {
  const logs = makeLogCapture();
  return runWithTestClock(
    Effect.gen(function* () {
      const ticks = yield* Ref.make(0);
      const tick = Ref.updateAndGet(ticks, (n) => n + 1).pipe(
        Effect.flatMap((n) =>
          n === 1
            ? Effect.fail(new Error('tmux gone'))
            : n === 2
              ? Effect.die(new Error('broken invariant'))
              : Effect.void,
        ),
      );
      yield* runPeriodically('PTY GC', '5 minutes', tick);

      yield* TestClock.adjust('15 minutes');

      assert.equal(yield* Ref.get(ticks), 3);
      assert.deepEqual(
        logs.lines.map((line) => [line.level, line.message, line.annotations.loop]),
        [
          ['Warn', 'PTY GC failed', 'PTY GC'],
          ['Warn', 'PTY GC failed', 'PTY GC'],
        ],
      );
      assert.match(logs.lines[0]?.cause ?? '', /tmux gone/);
      assert.match(logs.lines[1]?.cause ?? '', /broken invariant/);
    }).pipe(Effect.provide(logs.layer)),
  );
});

test('ticks never overlap: a slow tick delays the next one', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const active = yield* Ref.make(0);
      const maxActive = yield* Ref.make(0);
      const started = yield* Ref.make(0);
      const slowTick = Effect.gen(function* () {
        yield* Ref.update(started, (n) => n + 1);
        const now = yield* Ref.updateAndGet(active, (n) => n + 1);
        yield* Ref.update(maxActive, (max) => Math.max(max, now));
        yield* Effect.sleep('15 seconds');
        yield* Ref.update(active, (n) => n - 1);
      });
      yield* runPeriodically('session GC', '10 seconds', slowTick);

      // Ticks start at 10 s, 35 s, 60 s and 85 s: each interval starts when the previous tick ends.
      yield* TestClock.adjust('100 seconds');

      assert.equal(yield* Ref.get(maxActive), 1);
      assert.equal(yield* Ref.get(started), 4);
    }),
  ));

test('the loop never ticks after its scope closes', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const ticks = yield* Ref.make(0);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* runPeriodically(
            'content GC',
            '1 minute',
            Ref.update(ticks, (n) => n + 1),
          );
          yield* TestClock.adjust('1 minute');
        }),
      );
      assert.equal(yield* Ref.get(ticks), 1);

      yield* TestClock.adjust('10 minutes');

      assert.equal(yield* Ref.get(ticks), 1);
    }),
  ));

test('closing the scope during a tick interrupts the tick', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const finished = yield* Ref.make(false);
      const interrupted = yield* Ref.make(false);
      const tick = Effect.sleep('1 hour').pipe(
        Effect.andThen(Ref.set(finished, true)),
        Effect.onInterrupt(() => Ref.set(interrupted, true)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* runPeriodically('PTY GC', '1 second', tick);
          yield* TestClock.adjust('2 seconds');
        }),
      );

      assert.equal(yield* Ref.get(interrupted), true);
      yield* TestClock.adjust('2 hours');
      assert.equal(yield* Ref.get(finished), false);
    }),
  ));

test('a tick that interrupts itself stops the loop with a warning instead of spinning', () => {
  const logs = makeLogCapture();
  return runWithTestClock(
    Effect.gen(function* () {
      const ticks = yield* Ref.make(0);
      yield* runPeriodically(
        'event pump',
        '1 second',
        Ref.update(ticks, (n) => n + 1).pipe(Effect.andThen(Effect.interrupt)),
      );

      yield* TestClock.adjust('1 second');
      yield* TestClock.adjust('1 minute');

      assert.equal(yield* Ref.get(ticks), 1);
      assert.deepEqual(
        logs.lines.map((line) => [line.level, line.message, line.annotations.loop]),
        [['Warn', 'event pump stopped: its tick was interrupted', 'event pump']],
      );
    }).pipe(Effect.provide(logs.layer)),
  );
});
