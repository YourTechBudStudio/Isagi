import assert from 'node:assert/strict';
import test from 'node:test';

import { Data, Deferred, Effect, Layer, Schema, Stream } from 'effect';

import {
  apiBasePath,
  apiInfrastructureErrorSchema,
  type ApiContentEndpoint,
  type WireSchema,
} from '@isagi/contracts';

import {
  registerStreamingContentEndpoint,
  type StreamingContent,
} from './streaming-content-endpoint.js';
import { withListeningServer } from './testing.js';

// Against a real listening socket: a severed response and a client abort only exist there.

class SourceFailed extends Data.TaggedError('SourceFailed')<{ readonly reason: string }> {}

const endpoint = {
  id: 'test.streamingContent',
  method: 'GET',
  path: '/test/stream',
  errors: Schema.Union([
    apiInfrastructureErrorSchema,
    Schema.Struct({
      code: Schema.Literal('test_source_failed'),
      status: Schema.Literal(502),
      message: Schema.String,
      requestId: Schema.String,
      data: Schema.Struct({ reason: Schema.String }),
    }),
  ]),
} as const satisfies ApiContentEndpoint<WireSchema>;

/** A source holding a resource in the stream's scope, so a test can see the scope close. */
function trackedSource(rest: Stream.Stream<Uint8Array, SourceFailed>) {
  const opened = Effect.runSync(Deferred.make<void>());
  const closed = Effect.runSync(Deferred.make<void>());
  const stream = Stream.scoped(
    Stream.fromEffect(
      Effect.acquireRelease(Deferred.succeed(opened, undefined), () =>
        Deferred.succeed(closed, undefined),
      ),
    ).pipe(Stream.flatMap(() => rest)),
  );
  return {
    stream,
    opened: () => Effect.runPromise(Deferred.await(opened)),
    closed: () => within(Effect.runPromise(Deferred.await(closed))),
  };
}

function serve<A>(
  stream: Stream.Stream<Uint8Array, SourceFailed>,
  run: (url: string) => Promise<A>,
) {
  return withListeningServer(
    Layer.empty,
    (fastify, runtime) =>
      registerStreamingContentEndpoint(
        fastify,
        runtime,
        endpoint,
        () => Effect.succeed<StreamingContent<SourceFailed>>({ mediaType: 'audio/ogg', stream }),
        {
          beforeFirstChunk: (error) => ({
            code: 'test_source_failed' as const,
            status: 502 as const,
            message: 'The source failed.',
            data: { reason: error.reason },
          }),
        },
      ),
    (server) => run(`${server.origin}${apiBasePath}/test/stream`),
  );
}

const within = <A>(promise: Promise<A>, ms = 2_000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);

const bytes = (text: string) => new TextEncoder().encode(text);

test('bytes stream with their media type and no length, and the scope closes at the end', async () => {
  const source = trackedSource(Stream.make(bytes('first '), bytes('second')));
  await serve(source.stream, async (url) => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/ogg');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(await response.text(), 'first second');
    await source.closed();
  });
});

test('a failure before the first chunk is the declared rejection and closes the scope', async () => {
  const source = trackedSource(Stream.fail(new SourceFailed({ reason: 'RequestError' })));
  await serve(source.stream, async (url) => {
    const response = await fetch(url);
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: { code: string; data: unknown } };
    assert.equal(body.error.code, 'test_source_failed');
    assert.deepEqual(body.error.data, { reason: 'RequestError' });
    await source.closed();
  });
});

test('a client abort before the first chunk closes the scope and sends nothing', async () => {
  const source = trackedSource(Stream.never);
  await serve(source.stream, async (url) => {
    const abort = new AbortController();
    const response = fetch(url, { signal: abort.signal });
    await within(source.opened());
    abort.abort();
    await assert.rejects(response);
    await source.closed();
  });
});

test('a failure after the first chunk severs the response and closes the scope', async () => {
  const source = trackedSource(
    Stream.make(bytes('partial')).pipe(
      Stream.concat(
        Stream.fromEffect(
          Effect.andThen(Effect.sleep('20 millis'), Effect.fail(new SourceFailed({ reason: 'x' }))),
        ),
      ),
    ),
  );
  await serve(source.stream, async (url) => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    await assert.rejects(response.text(), 'a truncated body must not read as complete');
    await source.closed();
  });
});
