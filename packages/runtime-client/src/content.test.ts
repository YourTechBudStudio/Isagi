import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Stream } from 'effect';

import { workflowContentEndpoints } from '@isagi/contracts';

import {
  contentEndpointUrl,
  RuntimeApiError,
  RuntimeClient,
  RuntimeDecodeError,
  RuntimeTransportError,
  type RuntimeContent,
} from './index.js';
import { fakeRuntime, json, runtimeUrl } from './test-support.js';

const requestFile = RuntimeClient.use((client) =>
  client.requestContent(
    workflowContentEndpoints.getCheckpointFile,
    { checkpointId: 7 },
    { path: 'plan.md' },
  ),
);

test('a content URL interpolates its params and carries the route query', () => {
  const endpoint = workflowContentEndpoints.getCheckpointFile;
  assert.equal(
    contentEndpointUrl(runtimeUrl, endpoint, { checkpointId: 7 }, { path: 'notes/a b.md' }),
    `${runtimeUrl}/api/v1/workflows/checkpoints/7/file?path=notes%2Fa+b.md`,
  );
});

test('a content request fetches the same URL contentEndpointUrl builds', async () => {
  const runtime = fakeRuntime(() => new Response('x', { status: 200 }));
  const endpoint = workflowContentEndpoints.getCheckpointFile;

  await runtime.run(
    RuntimeClient.use((client) =>
      client.requestContent(endpoint, { checkpointId: 7 }, { path: 'notes/a b.md' }),
    ),
  );

  assert.equal(
    runtime.seen[0]?.url,
    contentEndpointUrl(runtimeUrl, endpoint, { checkpointId: 7 }, { path: 'notes/a b.md' }),
  );
  assert.equal(runtime.seen[0]?.method, 'GET');
  assert.deepEqual(runtime.seen[0]?.headers, {});
});

test('a successful content request hands back its content type and bytes, read whole', async () => {
  const runtime = fakeRuntime(
    () => new Response('plan v2', { status: 200, headers: { 'content-type': 'text/markdown' } }),
  );

  const [contentType, text] = await runtime.run(
    Effect.gen(function* () {
      const content = yield* requestFile;
      const buffer = yield* content.arrayBuffer;
      return [content.contentType, new TextDecoder().decode(buffer)] as const;
    }),
  );

  assert.equal(contentType, 'text/markdown');
  assert.equal(text, 'plan v2');
  assert.equal(
    runtime.seen[0]?.url,
    `${runtimeUrl}/api/v1/workflows/checkpoints/7/file?path=plan.md`,
  );
});

test('a successful content request can stream its bytes', async () => {
  const runtime = fakeRuntime(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

  const bytes = await runtime.run(
    requestFile.pipe(
      Effect.flatMap((content) => Stream.runCollect(content.stream)),
      Effect.map((chunks) => [...chunks].flatMap((chunk) => [...chunk])),
    ),
  );

  assert.deepEqual(bytes, [1, 2, 3]);
});

test('a content body that breaks mid-read is a transport error carrying the platform cause', async () => {
  const broken = new Error('socket hang up');
  const runtime = fakeRuntime(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.error(broken);
          },
        }),
        { status: 200 },
      ),
  );

  const error = await runtime.run(
    requestFile.pipe(
      Effect.flatMap((content: RuntimeContent) => Stream.runDrain(content.stream)),
      Effect.flip,
    ),
  );

  assert.ok(error instanceof RuntimeTransportError);
  assert.equal(error.endpointId, workflowContentEndpoints.getCheckpointFile.id);
  assert.equal(error.cause, broken);
});

for (const reason of [
  'workflow_checkpoint_content_unavailable',
  'workflow_checkpoint_file_not_found',
] as const) {
  test(`${reason} comes back as the structured rejection naming the file`, async () => {
    const data = { reason, checkpointId: 7, path: 'plan.md' };
    const runtime = fakeRuntime(() =>
      json(
        {
          error: { code: 'workflow_rejected', status: 400, message: 'gone', requestId: 'r', data },
        },
        400,
      ),
    );

    const error = await runtime.run(requestFile.pipe(Effect.flip));

    assert.ok(error instanceof RuntimeApiError);
    assert.equal(error.endpointId, workflowContentEndpoints.getCheckpointFile.id);
    assert.equal(error.apiError.code, 'workflow_rejected');
    assert.deepEqual(apiErrorData(error), data);
  });
}

test('an infrastructure error envelope on a content route decodes through the base arm', async () => {
  const runtime = fakeRuntime(() =>
    json(
      {
        error: {
          code: 'api_route_not_found',
          status: 404,
          message: 'Route not found',
          requestId: 'r',
          data: { method: 'GET', url: '/x' },
        },
      },
      404,
    ),
  );

  const error = await runtime.run(requestFile.pipe(Effect.flip));

  assert.ok(error instanceof RuntimeApiError);
  assert.equal(error.apiError.code, 'api_route_not_found');
});

test('a non-OK content response without an envelope is a decode error', async () => {
  const runtime = fakeRuntime(() => new Response('<html>bad gateway</html>', { status: 502 }));

  const error = await runtime.run(requestFile.pipe(Effect.flip));

  assert.ok(error instanceof RuntimeDecodeError);
});

test('an unreachable content route is a transport error', async () => {
  const runtime = fakeRuntime(() => Promise.reject(new Error('network down')));

  const error = await runtime.run(requestFile.pipe(Effect.flip));

  assert.ok(error instanceof RuntimeTransportError);
});

function apiErrorData(error: RuntimeApiError): unknown {
  return 'data' in error.apiError ? error.apiError.data : undefined;
}
