import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Stream } from 'effect';

import { fluidcastEventStreamEndpoints } from '@isagi/contracts';

import {
  RuntimeApiError,
  RuntimeClient,
  RuntimeDecodeError,
  RuntimeTransportError,
} from './index.js';
import { fakeRuntime, json, runtimeUrl } from './test-support.js';

const events = fluidcastEventStreamEndpoints.events;

const readAll = RuntimeClient.use((client) =>
  Stream.runCollect(client.requestEventStream(events, { fluidcastSessionId: 'fc a' })),
).pipe(Effect.map((items) => [...items]));

const sse = (body: string | ReadableStream<Uint8Array>) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

test('an event stream is a GET for text/event-stream at the interpolated path', async () => {
  const runtime = fakeRuntime(() => sse(''));

  await runtime.run(readAll);

  assert.equal(runtime.seen[0]?.method, 'GET');
  assert.equal(runtime.seen[0]?.url, `${runtimeUrl}/api/v1/fluidcast-sessions/fc%20a/events`);
  assert.deepEqual(runtime.seen[0]?.headers, { accept: 'text/event-stream' });
});

test("each event's data is parsed as JSON; comments and heartbeats are dropped", async () => {
  const runtime = fakeRuntime(() =>
    sse(': open\n\ndata: {"_tag":"Snapshot","cursor":0}\n\n: heartbeat\n\ndata: [1,2]\n\n'),
  );

  const items = await runtime.run(readAll);

  assert.deepEqual(items, [{ _tag: 'Snapshot', cursor: 0 }, [1, 2]]);
});

test('an event split across chunks decodes once it is complete', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"a"'));
      controller.enqueue(encoder.encode(':1}\n'));
      controller.enqueue(encoder.encode('\n'));
      controller.close();
    },
  });
  const runtime = fakeRuntime(() => sse(body));

  assert.deepEqual(await runtime.run(readAll), [{ a: 1 }]);
});

test('a refusal before the stream opens is the declared error envelope', async () => {
  const runtime = fakeRuntime(() =>
    json(
      {
        error: {
          code: 'fluidcast_session_not_found',
          status: 404,
          message: 'gone',
          requestId: 'r',
          data: { fluidcastSessionId: 'fc a' },
        },
      },
      404,
    ),
  );

  const error = await runtime.run(readAll.pipe(Effect.flip));

  assert.ok(error instanceof RuntimeApiError);
  assert.equal(error.endpointId, events.id);
  assert.equal(error.apiError.code, 'fluidcast_session_not_found');
});

test('data that is not JSON is a decode error', async () => {
  const runtime = fakeRuntime(() => sse('data: not json\n\n'));

  const error = await runtime.run(readAll.pipe(Effect.flip));

  assert.ok(error instanceof RuntimeDecodeError);
  assert.equal(error.endpointId, events.id);
});

test('an unreachable runtime is a transport error', async () => {
  const runtime = fakeRuntime(() => Promise.reject(new Error('network down')));

  const error = await runtime.run(readAll.pipe(Effect.flip));

  assert.ok(error instanceof RuntimeTransportError);
  assert.equal(error.endpointId, events.id);
});

test('a body that breaks mid-stream is a transport error carrying the platform cause', async () => {
  const broken = new Error('socket hang up');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: 1\n\n'));
      controller.error(broken);
    },
  });
  const runtime = fakeRuntime(() => sse(body));

  const error = await runtime.run(readAll.pipe(Effect.flip));

  assert.ok(error instanceof RuntimeTransportError);
  assert.equal(error.cause, broken);
});

test('stopping the stream aborts the request', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: 1\n\n'));
      // Never closes: only the subscriber can end it.
    },
  });
  const runtime = fakeRuntime(() => sse(body));

  const first = await runtime.run(
    RuntimeClient.use((client) =>
      Stream.runHead(client.requestEventStream(events, { fluidcastSessionId: 'x' })),
    ),
  );

  assert.equal(first._tag, 'Some');
  assert.equal(runtime.seen[0]?.signal?.aborted, true);
});
