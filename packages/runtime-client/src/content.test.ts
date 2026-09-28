import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { workflowContentEndpoints } from '@isagi/contracts';

import {
  contentEndpointUrl,
  requestContent,
  RuntimeApiError,
  RuntimeDecodeError,
  RuntimeTransportError,
} from './index.js';

const runtimeUrl = 'http://runtime.test';
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('a content URL interpolates its params and carries the route query', () => {
  const endpoint = workflowContentEndpoints.getCheckpointFile;
  assert.equal(
    contentEndpointUrl(runtimeUrl, endpoint, { checkpointId: 7 }, { path: 'notes/a b.md' }),
    `${runtimeUrl}/api/v1/workflows/checkpoints/7/file?path=notes%2Fa+b.md`,
  );
});

test('a successful content request hands back the response with its body unread', async () => {
  let seen = '';
  globalThis.fetch = ((input) => {
    seen = String(input);
    return Promise.resolve(new Response('plan v2', { status: 200 }));
  }) as typeof fetch;

  const response = await Effect.runPromise(
    requestContent(
      runtimeUrl,
      workflowContentEndpoints.getCheckpointFile,
      { checkpointId: 7 },
      { path: 'plan.md' },
    ) as Effect.Effect<Response, never>,
  );

  assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), 'plan v2');
  assert.equal(seen, `${runtimeUrl}/api/v1/workflows/checkpoints/7/file?path=plan.md`);
});

for (const reason of [
  'workflow_checkpoint_content_unavailable',
  'workflow_checkpoint_file_not_found',
] as const) {
  test(`${reason} comes back as the structured rejection naming the file`, async () => {
    const data = { reason, checkpointId: 7, path: 'plan.md' };
    globalThis.fetch = rejecting(data);

    const error = await Effect.runPromise(Effect.flip(requestFile()));

    assert.ok(error instanceof RuntimeApiError);
    assert.equal(error.apiError.code, 'workflow_rejected');
    assert.deepEqual(apiErrorData(error), data);
  });
}

test('an infrastructure error envelope on a content route decodes through the base arm', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'api_route_not_found',
            status: 404,
            message: 'Route not found',
            requestId: 'r',
            data: { method: 'GET', url: '/x' },
          },
        }),
        { status: 404 },
      ),
    )) as typeof fetch;

  const error = await Effect.runPromise(Effect.flip(requestFile()));

  assert.ok(error instanceof RuntimeApiError);
  assert.equal(error.apiError.code, 'api_route_not_found');
});

test('a non-OK content response without an envelope is a decode error', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))) as typeof fetch;

  const error = await Effect.runPromise(Effect.flip(requestFile()));

  assert.ok(error instanceof RuntimeDecodeError);
});

test('an unreachable content route is a transport error', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('network down'))) as typeof fetch;

  const error = await Effect.runPromise(Effect.flip(requestFile()));

  assert.ok(error instanceof RuntimeTransportError);
});

function requestFile() {
  return requestContent(
    runtimeUrl,
    workflowContentEndpoints.getCheckpointFile,
    { checkpointId: 7 },
    { path: 'plan.md' },
  );
}

function rejecting(data: Record<string, unknown>) {
  return (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: { code: 'workflow_rejected', status: 400, message: 'gone', requestId: 'r', data },
        }),
        { status: 400 },
      ),
    )) as typeof fetch;
}

function apiErrorData(error: RuntimeApiError): unknown {
  return 'data' in error.apiError ? error.apiError.data : undefined;
}
