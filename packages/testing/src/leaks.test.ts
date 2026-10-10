import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import { Effect, Exit, Layer, Schedule, Scope } from 'effect';
import { TestClock } from 'effect/testing';

import { runScoped, runWithTestClock } from './effect.js';
import { expectNoNewHandles, expectNoProcessMatching, makeFiberProbe } from './leaks.js';

describe('makeFiberProbe', () => {
  test('a layer-forked loop is counted while alive and ends when its scope closes', () =>
    runWithTestClock(
      Effect.gen(function* () {
        const probe = makeFiberProbe();
        let ticks = 0;
        const ticker = Layer.effectDiscard(
          Effect.forkScoped(
            Effect.sync(() => ticks++).pipe(Effect.repeat(Schedule.spaced('1 minute'))),
          ),
        );
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(ticker.pipe(Layer.provide(probe.layer)), scope);
        yield* TestClock.adjust('3 minutes');
        assert.ok(ticks >= 3, `expected the loop to tick, got ${ticks}`);
        assert.ok(probe.counts.active >= 1, `expected a live fiber, got ${probe.counts.active}`);
        yield* Scope.close(scope, Exit.void);
        assert.equal(probe.counts.active, 0);
      }),
    ));

  test('detects a detached fiber that outlives its scope', () =>
    runWithTestClock(
      Effect.gen(function* () {
        const probe = makeFiberProbe();
        const leaky = Layer.effectDiscard(Effect.forkDetach(Effect.never)).pipe(
          Layer.provide(probe.layer),
        );
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(leaky, scope);
        yield* Scope.close(scope, Exit.void);
        assert.equal(probe.counts.active, 1);
      }),
    ));
});

describe('expectNoNewHandles', () => {
  test('passes for a scoped timer and child process released by their finalizers', () =>
    runScoped(
      expectNoNewHandles(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => setInterval(() => {}, 1_000)),
              (timer) => Effect.sync(() => clearInterval(timer)),
            );
            yield* Effect.acquireRelease(
              Effect.sync(() => spawn('sleep', ['5'])),
              (child) =>
                Effect.callback<void>((resume) => {
                  child.once('exit', () => resume(Effect.void));
                  child.kill('SIGTERM');
                }),
            );
          }),
        ),
      ),
    ));

  test('returns the body result', async () => {
    assert.equal(await runScoped(expectNoNewHandles(Effect.succeed('ok'))), 'ok');
  });

  test('fails for a leaked interval', async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await assert.rejects(
        runScoped(
          expectNoNewHandles(Effect.sync(() => void (timer = setInterval(() => {}, 1_000)))),
        ),
        /leaked handles: \{"Timeout":1\}/,
      );
    } finally {
      clearInterval(timer);
    }
  });
});

describe('expectNoProcessMatching', () => {
  // A node child whose command line carries the marker (a shell could exec away its own argv).
  const spawnMarked = (marker: string) =>
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore' });

  test('passes once the marked process has exited', async () => {
    const marker = `isagi-testing-${randomUUID()}`;
    const child = spawnMarked(marker);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    setTimeout(() => child.kill('SIGTERM'), 100);
    await runScoped(expectNoProcessMatching(marker));
    await exited;
  });

  test('passes when nothing ever matched', () =>
    runScoped(expectNoProcessMatching(`isagi-testing-${randomUUID()}`)));

  test('fails with the survivor pid and command line when the process outlives the window', async () => {
    const marker = `isagi-testing-${randomUUID()}`;
    const child = spawnMarked(marker);
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      await assert.rejects(
        runScoped(expectNoProcessMatching(marker, { withinMs: 200 })),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(`still running after 200 ms`) &&
          error.message.includes(String(child.pid)) &&
          error.message.includes(marker),
      );
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('matches the marker literally, not as a pattern', async () => {
    const marker = `isagi-testing-${randomUUID()}`;
    const child = spawnMarked(marker);
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      // As a regex, `.` would match any character and find the running process.
      await runScoped(expectNoProcessMatching(marker.replace('-', '.'), { withinMs: 0 }));
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('rejects an empty marker, which would match every process', async () => {
    await assert.rejects(runScoped(expectNoProcessMatching('  ')), /marker must not be empty/);
  });
});
