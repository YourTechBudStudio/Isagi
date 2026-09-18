import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import test from 'node:test';

import { Effect, Schema } from 'effect';
import Fastify from 'fastify';

import { apiInfrastructureErrorSchema, type ApiContentEndpoint } from '@isagi/contracts';

import { registerContentEndpoint, type ContentResponse } from './content-endpoint.js';

/**
 * The branch no other test can reach: a stream that fails *after* a 200 is committed.
 *
 * Everything before the first byte is covered against the real evidence route in
 * `workflows/api.test.ts`. This file exists for the half that cannot be verified by inspection —
 * whether the connection is actually severed rather than left hanging, and whether the diagnostic
 * that is the only remaining record of the failure really fires.
 *
 * It is not hypothetical. Decision 8 verifies a hash only at the last byte, so truncated stored
 * content reaches here on an ordinary read, and this is the mechanism every future content route
 * inherits.
 *
 * The severing case runs against a real listening socket rather than `fastify.inject`, because
 * `inject` has no socket to sever: destroying the raw response there never completes the injected
 * request, and the test that was meant to prove the client is not left hanging would hang itself.
 */

const endpoint = {
  id: 'test.content',
  method: 'GET',
  path: '/test/content',
  errors: apiInfrastructureErrorSchema,
} as const satisfies ApiContentEndpoint<Schema.Schema.AnyNoContext>;

function routeServing(handle: () => Effect.Effect<ContentResponse, unknown>) {
  const fastify = Fastify({ logger: false });
  registerContentEndpoint(fastify, endpoint, {
    handle,
    run: (effect) => Effect.runPromise(effect as Effect.Effect<never, never, never>),
  });
  return fastify;
}

/** Captures the diagnostic channel, which only writes when runtime diagnostics are on. */
function captureDiagnostics() {
  const previous = process.env.ISAGI_RUNTIME_DEBUG;
  const originalWarn = console.warn;
  const lines: string[] = [];
  process.env.ISAGI_RUNTIME_DEBUG = '1';
  console.warn = (...args: readonly unknown[]) => {
    lines.push(args.map((part) => JSON.stringify(part) ?? String(part)).join(' '));
  };
  return {
    lines,
    restore: () => {
      console.warn = originalWarn;
      if (previous === undefined) delete process.env.ISAGI_RUNTIME_DEBUG;
      else process.env.ISAGI_RUNTIME_DEBUG = previous;
    },
  };
}

test('a stream that fails after the headers severs the response and says so in the log', async () => {
  const diagnostics = captureDiagnostics();
  // Held so the failure is triggered from the test body once the headers have *provably* arrived.
  // A timer would only assume that, and losing the race would take the other branch and fail the
  // one test whose job is to prove the two branches are distinct.
  let serving: Readable | undefined;
  const fastify = routeServing(() =>
    Effect.sync(() => {
      const stream = new Readable({ read() {} });
      stream.push(Buffer.from('the first part arrived'));
      serving = stream;
      return { stream, mediaType: 'text/plain', byteSize: 512, filename: null };
    }),
  );

  try {
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const { port } = fastify.server.address() as AddressInfo;
    // Resolves on the response head, so reaching here *is* the proof that the 200 is committed.
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/test/content`);

    // A 200 that will end short. There is no honest alternative once the status line is sent:
    // turning the failure into a 500 body would append an error document to a partial file, and
    // completing the response normally would present truncated content as whole.
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.equal(response.headers.get('content-length'), '512');

    assert.ok(serving, 'the route reached the stream');
    serving.destroy(new Error('blob truncated mid-read'));

    // The client sees a broken connection, not a hang and not a short body it might mistake for
    // the whole file. This is the assertion the whole branch exists for.
    await assert.rejects(
      () => response.text(),
      'reading the promised 512 bytes fails, because the connection was severed',
    );

    const logged = diagnostics.lines.find((line) => line.includes('api.content_stream_failed'));
    assert.ok(logged, 'the severed connection is recorded, since nothing else can report it');
    assert.ok(logged.includes('blob truncated mid-read'), 'with the cause');
    assert.ok(logged.includes('test.content'), 'and the endpoint it happened on');
  } finally {
    diagnostics.restore();
    await fastify.close();
  }
});

test('a handler that fails before the first byte still gets the JSON envelope', async () => {
  // The companion case, asserted beside it so the two branches are visible together: the distinction
  // is the whole contract of a content route, and a refactor that collapsed them would still pass a
  // test of either one alone.
  const fastify = routeServing(() => Effect.fail(new Error('nothing to serve')));

  const response = await fastify.inject({ method: 'GET', url: '/api/v1/test/content' });

  assert.equal(response.statusCode, 500);
  assert.equal(response.headers['content-type']?.toString().startsWith('application/json'), true);
  const decoded = JSON.parse(response.body) as { error: { code: string } };
  assert.equal(decoded.error.code, 'api_unhandled_error');
});
