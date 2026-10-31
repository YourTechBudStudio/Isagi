import assert from 'node:assert/strict';
import test from 'node:test';

import { Deferred, Effect, Layer, Schema, Stream } from 'effect';

import {
  apiBasePath,
  apiInfrastructureErrorSchema,
  type ApiEventStreamEndpoint,
  type WireSchema,
} from '@isagi/contracts';

import type { ApiHandler } from './endpoint.js';
import { registerEventStreamEndpoint } from './event-stream-endpoint.js';
import { withListeningServer } from './testing.js';

// Against a real listening socket: a disconnect, a shutdown and CORS headers only exist there.

const endpoint = {
  id: 'test.events',
  method: 'GET',
  path: '/test/events/:id',
  params: Schema.Struct({ id: Schema.String }),
  errors: Schema.Union([
    apiInfrastructureErrorSchema,
    Schema.Struct({
      code: Schema.Literal('test_not_found'),
      status: Schema.Literal(404),
      message: Schema.String,
      requestId: Schema.String,
    }),
  ]),
} as const satisfies ApiEventStreamEndpoint<WireSchema, WireSchema>;

type Handle = ApiHandler<typeof endpoint, Stream.Stream<unknown>, never>;

function serve<A>(
  handle: Handle,
  run: (server: { url: string; interruptRoutes: () => Promise<void> }) => Promise<A>,
  heartbeatInterval: number = 60_000,
  allowedOrigins: readonly string[] = [],
) {
  return withListeningServer(
    Layer.empty,
    (fastify, runtime) =>
      registerEventStreamEndpoint(fastify, runtime, endpoint, handle, { heartbeatInterval }),
    (server) =>
      run({
        url: `${server.origin}${apiBasePath}/test/events/one`,
        interruptRoutes: server.interruptRoutes,
      }),
    { allowedOrigins },
  );
}

/** Reads until `until` matches the accumulated text, or the body ends. */
async function readUntil(body: ReadableStream<Uint8Array>, until: (text: string) => boolean) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return { text, done: true, reader };
    text += decoder.decode(value, { stream: true });
    if (until(text)) return { text, done: false, reader };
  }
}

const within = <A>(promise: Promise<A>, ms = 2_000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);

test('a stream opens with a comment, frames each item as one event and ends with the items', () =>
  serve(
    () => Effect.succeed(Stream.make({ a: 1 }, 'two')),
    async ({ url }) => {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-accel-buffering'), 'no');
      assert.equal(response.headers.get('content-length'), null);
      assert.equal(await response.text(), ': connected\n\ndata: {"a":1}\n\ndata: "two"\n\n');
    },
  ));

test('heartbeats keep an idle stream alive until the items end', () =>
  serve(
    () => Effect.succeed(Stream.fromEffect(Effect.as(Effect.sleep('150 millis'), 'late'))),
    async ({ url }) => {
      const text = await (await fetch(url)).text();
      assert.match(text, /^: connected\n\n(: heartbeat\n\n)+data: "late"\n\n$/);
    },
    30,
  ));

test('a refusal is the JSON error envelope, sent before any stream opens', () =>
  serve(
    (request) => request.reject({ code: 'test_not_found', status: 404, message: 'No such thing.' }),
    async ({ url }) => {
      const response = await fetch(url);
      assert.equal(response.status, 404);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'test_not_found');
    },
  ));

test('a client disconnect interrupts the item stream', async () => {
  const stopped = Effect.runSync(Deferred.make<void>());
  await serve(
    () => Effect.succeed(Stream.never.pipe(Stream.ensuring(Deferred.succeed(stopped, undefined)))),
    async ({ url }) => {
      const abort = new AbortController();
      const response = await fetch(url, { signal: abort.signal });
      await readUntil(response.body!, (text) => text.includes(': connected'));
      abort.abort();
      await within(Effect.runPromise(Deferred.await(stopped)));
    },
  );
});

test('shutdown ends an open stream', () =>
  serve(
    () => Effect.succeed(Stream.never),
    async ({ url, interruptRoutes }) => {
      const response = await fetch(url);
      const opened = await readUntil(response.body!, (text) => text.includes(': connected'));
      await interruptRoutes();
      // The body ends, cleanly or as a severed connection; what matters is that it does not hang.
      await within(
        (async () => {
          try {
            while (!(await opened.reader.read()).done);
          } catch {}
        })(),
      );
    },
  ));

test('an allowed origin gets its CORS header on the stream', async () => {
  await serve(
    () => Effect.succeed(Stream.make(1)),
    async ({ url }) => {
      const response = await fetch(url, { headers: { Origin: 'http://allowed.test' } });
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://allowed.test');
      await response.text();
    },
    60_000,
    ['http://allowed.test'],
  );
});
