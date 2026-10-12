import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause, Effect, Exit, Fiber, Layer, Option } from 'effect';
import { FetchHttpClient, type HttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';

import {
  InvalidRuntimeUrl,
  ServerWaitFailed,
  waitForRuntimeHealth,
  waitForWebServer,
} from './boot.js';

const runtimeUrl = 'http://127.0.0.1:43129';
const healthUrl = `${runtimeUrl}/api/v1/health`;

const healthy = {
  data: {
    context: { arch: 'arm64', node: 'v24.0.0', pid: 4242, platform: 'darwin' },
    name: 'isagi-runtime',
    ok: true,
    timestamp: '2026-10-09T00:00:00.000Z',
    version: '0.0.4',
  },
  meta: { requestId: 'request-1' },
};

const unavailable = {
  error: {
    code: 'api_unhandled_error',
    status: 503,
    message: 'starting',
    requestId: 'request-2',
  },
};

interface SeenRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A fake server behind `FetchHttpClient.Fetch`; `answer` gets the 1-based attempt number. */
function fakeServer(answer: (attempt: number) => Response | Promise<Response>) {
  const seen: SeenRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return answer(seen.length);
  };
  const layer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return {
    seen,
    run: <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
      effect.pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.provide(TestClock.layer()),
        Effect.runPromise,
      ),
  };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

/** Lets the fake's promise settle and the waiting fiber reach its next sleep; time stays frozen. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 10; turn += 1) {
    yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
  }
});

/** Advances through every retry interval the waiters use (39 × 250 ms). */
const exhaustRetries = Effect.gen(function* () {
  for (let attempt = 1; attempt < 40; attempt += 1) {
    yield* settle;
    yield* TestClock.adjust('250 millis');
  }
  yield* settle;
});

test('runtime health resolves on the first healthy answer without extra headers', async () => {
  const server = fakeServer(() => json(healthy));
  await server.run(waitForRuntimeHealth(runtimeUrl));
  assert.deepEqual(server.seen, [{ url: healthUrl, headers: {} }]);
});

test('runtime health retries every 250 ms until the runtime answers healthy', async () => {
  const server = fakeServer((attempt) => (attempt < 3 ? json(unavailable, 503) : json(healthy)));
  await server.run(
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(waitForRuntimeHealth(runtimeUrl));
      yield* settle;
      assert.equal(server.seen.length, 1);
      yield* TestClock.adjust('250 millis');
      yield* settle;
      assert.equal(server.seen.length, 2);
      yield* TestClock.adjust('250 millis');
      yield* Fiber.join(waiting);
      assert.equal(server.seen.length, 3);
    }),
  );
});

test('runtime health gives up after 40 attempts and names the last failure', async () => {
  const server = fakeServer(() => json(unavailable, 503));
  const failure = await server.run(
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(Effect.flip(waitForRuntimeHealth(runtimeUrl)));
      yield* exhaustRetries;
      return yield* Fiber.join(waiting);
    }),
  );
  assert.ok(failure instanceof ServerWaitFailed);
  assert.equal(
    failure.message,
    `Timed out waiting for ${healthUrl}: ${healthUrl} responded with 503`,
  );
  assert.equal(server.seen.length, 40);
});

test('runtime health bounds each attempt and rejects payloads outside the contract', async () => {
  const server = fakeServer((attempt) =>
    attempt === 1
      ? new Promise<Response>(() => {})
      : json({ ...healthy, data: { ...healthy.data, ok: false } }),
  );
  const failure = await server.run(
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(Effect.flip(waitForRuntimeHealth(runtimeUrl)));
      yield* settle;
      yield* TestClock.adjust('1 second');
      yield* exhaustRetries;
      return yield* Fiber.join(waiting);
    }),
  );
  assert.equal(server.seen.length, 40);
  assert.match(
    failure.message,
    /^Timed out waiting for http:\/\/127\.0\.0\.1:43129\/api\/v1\/health: /,
  );
  assert.doesNotMatch(failure.message, /request timed out/);
});

test('a hung runtime health attempt times out after one second', async () => {
  const server = fakeServer(() => new Promise<Response>(() => {}));
  const failure = await server.run(
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(Effect.flip(waitForRuntimeHealth(runtimeUrl)));
      for (let attempt = 1; attempt <= 40; attempt += 1) {
        yield* settle;
        yield* TestClock.adjust('1 second');
        yield* settle;
        yield* TestClock.adjust('250 millis');
      }
      return yield* Fiber.join(waiting);
    }),
  );
  assert.equal(
    failure.message,
    `Timed out waiting for ${healthUrl}: ${healthUrl} request timed out after 1000ms`,
  );
  assert.equal(server.seen.length, 40);
});

test('a runtime URL that is not a valid base fails at once, as a failure, without echoing it', async () => {
  const server = fakeServer(() => json(healthy));
  const exit = await server.run(Effect.exit(waitForRuntimeHealth('localhost:4100')));
  assert.ok(Exit.isFailure(exit));
  const failure = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(failure), 'a typed failure, not a defect');
  assert.ok(failure.value instanceof InvalidRuntimeUrl);
  assert.equal(failure.value.message, 'Invalid URL');
  assert.deepEqual(server.seen, []);
});

test('the web server wait retries non-2xx answers and sends a bare GET', async () => {
  const webUrl = 'http://localhost:5173/';
  const server = fakeServer((attempt) =>
    attempt === 1 ? new Response('starting', { status: 502 }) : new Response('<html>'),
  );
  await server.run(
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(waitForWebServer(webUrl));
      yield* settle;
      yield* TestClock.adjust('250 millis');
      yield* Fiber.join(waiting);
    }),
  );
  assert.deepEqual(server.seen, [
    { url: webUrl, headers: {} },
    { url: webUrl, headers: {} },
  ]);
});

test('the web server wait names the last status when it gives up', async () => {
  const webUrl = 'http://localhost:5173/';
  const server = fakeServer(() => new Response('down', { status: 502 }));
  const failure = await server.run(
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(Effect.flip(waitForWebServer(webUrl)));
      yield* exhaustRetries;
      return yield* Fiber.join(waiting);
    }),
  );
  assert.equal(failure.message, `Timed out waiting for ${webUrl}: ${webUrl} responded with 502`);
});
