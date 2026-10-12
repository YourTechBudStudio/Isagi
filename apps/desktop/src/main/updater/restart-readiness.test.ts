import assert from 'node:assert/strict';
import test from 'node:test';

import { Duration, Effect, Fiber, Layer, type Scope } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';

import type { RuntimeLifecycleFailure } from '../runtime-process/index.js';
import {
  readRestartReadiness,
  restartReadinessTimeout,
  type RestartReadinessDiagnosticCategory,
} from './restart-readiness.js';
import { activityResponse, settle, testRuntimeUrl } from './test-support.js';

const runWithTestClock = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);

/** Reads readiness through the real `FetchHttpClient` over a fake `fetch`. */
function reader(
  fetch: typeof globalThis.fetch,
  runtimeUrl: Effect.Effect<string, RuntimeLifecycleFailure> = Effect.succeed(testRuntimeUrl),
) {
  const diagnostics: RestartReadinessDiagnosticCategory[] = [];
  const read = readRestartReadiness(runtimeUrl, (category) =>
    Effect.sync(() => void diagnostics.push(category)),
  ).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    ),
  );
  return { read, diagnostics };
}

test('restart readiness decodes clear and working agent results', () =>
  runWithTestClock(
    Effect.gen(function* () {
      for (const [count, expected] of [
        [0, { kind: 'clear' }],
        [3, { kind: 'working_agents', workingAgentCount: 3 }],
      ] as const) {
        const subject = reader(() => Promise.resolve(activityResponse(count)));
        assert.deepEqual(yield* subject.read, expected);
        assert.deepEqual(subject.diagnostics, []);
      }
    }),
  ));

test('restart readiness maps transport, HTTP, and decoding failures to categorized unknown', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const cases = [
        {
          expected: 'transport',
          fetch: () => Promise.reject(new Error('secret transport cause')),
        },
        {
          expected: 'http',
          fetch: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  error: {
                    code: 'agent_session_activity_unavailable',
                    status: 500,
                    message: 'Agent session activity could not be read.',
                    requestId: 'request-1',
                  },
                }),
                { status: 500 },
              ),
            ),
        },
        {
          expected: 'decoding',
          fetch: () => Promise.resolve(new Response('{', { status: 200 })),
        },
        {
          expected: 'decoding',
          fetch: () => Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 })),
        },
      ] as const;
      for (const { expected, fetch } of cases) {
        const subject = reader(fetch);
        assert.deepEqual(yield* subject.read, { kind: 'unknown' });
        assert.deepEqual(subject.diagnostics, [expected]);
      }
    }),
  ));

test('restart readiness reports an unusable runtime URL as a diagnosed unknown', () =>
  runWithTestClock(
    Effect.gen(function* () {
      let fetched = false;
      // A degraded external runtime still hands back its configured URL, so a
      // malformed one must stay in the failure channel instead of escaping as a
      // defect the coordinator never sees.
      const subject = reader(() => {
        fetched = true;
        return Promise.resolve(activityResponse(0));
      }, Effect.succeed('not-a-url'));
      assert.deepEqual(yield* subject.read, { kind: 'unknown' });
      assert.deepEqual(subject.diagnostics, ['transport']);
      assert.equal(fetched, false);
    }),
  ));

test('restart readiness applies one timeout to runtime access and aborts an in-flight fetch', () =>
  runWithTestClock(
    Effect.gen(function* () {
      let aborted = false;
      const subject = reader(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(new Error('aborted'));
              },
              { once: true },
            );
          }),
      );
      const reading = yield* Effect.forkChild(subject.read);
      yield* settle;
      yield* TestClock.adjust(Duration.subtract(restartReadinessTimeout, Duration.millis(1)));
      yield* settle;
      assert.equal(aborted, false, 'the deadline fired early');
      yield* TestClock.adjust(Duration.millis(1));
      assert.deepEqual(yield* Fiber.join(reading), { kind: 'unknown' });
      assert.equal(aborted, true);
      assert.deepEqual(subject.diagnostics, ['timeout']);

      // The same deadline covers asking for the runtime's URL.
      const waiting = reader(() => Promise.resolve(activityResponse(0)), Effect.never);
      const resolving = yield* Effect.forkChild(waiting.read);
      yield* settle;
      yield* TestClock.adjust(restartReadinessTimeout);
      assert.deepEqual(yield* Fiber.join(resolving), { kind: 'unknown' });
      assert.deepEqual(waiting.diagnostics, ['timeout']);
    }),
  ));

test('restart readiness aborts a response whose body never finishes', () =>
  runWithTestClock(
    Effect.gen(function* () {
      let signal: AbortSignal | undefined;
      // Headers arrive immediately; the body never does. The deadline owns the
      // whole operation, so the transport must not be left alive behind it.
      const subject = reader((_input, init) => {
        signal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      });
      const reading = yield* Effect.forkChild(subject.read);
      yield* settle;
      assert.equal(signal?.aborted, false);
      yield* TestClock.adjust(restartReadinessTimeout);
      assert.deepEqual(yield* Fiber.join(reading), { kind: 'unknown' });
      assert.equal(signal?.aborted, true);
      assert.deepEqual(subject.diagnostics, ['timeout']);
    }),
  ));
