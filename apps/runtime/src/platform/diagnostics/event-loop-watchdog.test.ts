import assert from 'node:assert/strict';
import test from 'node:test';

import { Duration, Effect, Layer } from 'effect';

import { makeLogCapture, runScoped, runWithTestClock } from '@isagi/testing';

import { EventLoopWatchdog, EventLoopWatchdogSettings } from './event-loop-watchdog.js';
import { diagnosticPhase } from './phase.js';

/**
 * The watchdog measures real time on purpose. These tests block the event loop for real (a synchronous busy wait) and
 * wait in real time, with the sampling interval and threshold shortened through `EventLoopWatchdogSettings`.
 */

const settings = Layer.succeed(EventLoopWatchdogSettings, {
  interval: Duration.millis(20),
  lagThreshold: Duration.millis(100),
});

/** Holds the event loop, the way a slow synchronous call would. */
const blockEventLoop = (ms: number) =>
  Effect.sync(() => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // busy wait
    }
  });

/** Waits in real time, whatever clock the test runs under. */
const realDelay = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

test('a blocked event loop is reported with its lag and the active phase, even under a TestClock', async () => {
  const logs = makeLogCapture();
  await runWithTestClock(
    Effect.gen(function* () {
      yield* Layer.build(EventLoopWatchdog.layer);
      yield* realDelay(50);
      // The phase stays active while the watchdog wakes up late, as a hung phase would.
      yield* diagnosticPhase(
        'watchdog-test-phase',
        { probe: 'blocked' },
        blockEventLoop(300).pipe(Effect.andThen(realDelay(100))),
      );
    }).pipe(Effect.provide(Layer.mergeAll(logs.layer, settings))),
  );

  const warnings = logs.lines.filter((line) => line.message === 'Event loop lag detected');
  assert.ok(warnings.length >= 1, `expected a lag warning, got ${JSON.stringify(logs.lines)}`);
  const [warning] = warnings;
  assert.equal(warning?.level, 'Warn');
  assert.ok(Number(warning?.annotations.lagMs) >= 100, `lag ${String(warning?.annotations.lagMs)}`);
  assert.equal(warning?.annotations.markerPhase, 'watchdog-test-phase');
  assert.deepEqual(warning?.annotations.markerContext, { probe: 'blocked' });
  assert.equal(typeof warning?.annotations.markerElapsedMs, 'number');
});

test('closing the watchdog scope stops it', async () => {
  const logs = makeLogCapture();
  let linesAtClose = -1;
  await runScoped(
    Effect.gen(function* () {
      yield* Effect.scoped(
        Layer.build(EventLoopWatchdog.layer).pipe(Effect.andThen(realDelay(50))),
      );
      linesAtClose = logs.lines.length;
      yield* blockEventLoop(300);
      yield* realDelay(100);
    }).pipe(Effect.provide(Layer.mergeAll(logs.layer, settings))),
  );
  assert.ok(linesAtClose >= 0);
  assert.deepEqual(logs.lines.slice(linesAtClose), []);
});
