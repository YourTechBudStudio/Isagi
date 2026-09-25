import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { apiEndpoints, type ApiError, type WorkspaceSnapshot } from '@isagi/contracts';

import {
  createEndpointRequester,
  RuntimeApiError,
  RuntimeDecodeError,
  RuntimeTransportError,
} from './index.js';

const runtimeUrl = 'http://runtime.test';
const workspace = { projects: [] } satisfies WorkspaceSnapshot;
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('the requester decodes success envelopes', async () => {
  globalThis.fetch = mockFetch(
    new Response(JSON.stringify({ data: workspace, meta: { requestId: 'req-success' } }), {
      status: 200,
    }),
  );

  const snapshot = await Effect.runPromise(
    createEndpointRequester(runtimeUrl)(apiEndpoints.workspace.get),
  );

  assert.deepEqual(snapshot, workspace);
});

test('the requester interpolates path params', async () => {
  let requestedUrl = '';
  globalThis.fetch = ((input) => {
    requestedUrl = String(input);
    return Promise.resolve(
      new Response(
        JSON.stringify({ data: { projectId: 42, deleted: true }, meta: { requestId: 'req' } }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const output = await Effect.runPromise(
    createEndpointRequester(runtimeUrl)(apiEndpoints.projects.delete, { projectId: 42 }),
  );

  assert.equal(requestedUrl, 'http://runtime.test/api/v1/projects/42');
  assert.deepEqual(output, { projectId: 42, deleted: true });
});

test('the requester repeats an array query parameter instead of joining it', async () => {
  let requestedUrl = '';
  globalThis.fetch = ((input) => {
    requestedUrl = String(input);
    return Promise.resolve(
      new Response(
        JSON.stringify({ data: { items: [], nextCursor: null }, meta: { requestId: 'req' } }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  await Effect.runPromise(
    createEndpointRequester(runtimeUrl)(
      apiEndpoints.workflows.listEvidence,
      { runId: 7 },
      { label: ['a,b', 'c'], cursor: undefined },
    ),
  );

  const url = new URL(requestedUrl);
  assert.deepEqual(url.searchParams.getAll('label'), ['a,b', 'c']);
  assert.equal(url.searchParams.has('cursor'), false);
});

test('the requester decodes endpoint API errors before base API errors', async () => {
  const apiError = {
    code: 'project_path_rejected',
    status: 400,
    message: 'Not a Git repository: /repo/nope',
    requestId: 'req-api-error',
    data: { reason: 'not_git_repository', path: '/repo/nope' },
  } satisfies ApiError;
  globalThis.fetch = mockFetch(new Response(JSON.stringify({ error: apiError }), { status: 400 }));

  const error = await Effect.runPromise(
    Effect.flip(
      createEndpointRequester(runtimeUrl)(apiEndpoints.projects.add, { path: '/repo/nope' }),
    ),
  );

  assert.ok(error instanceof RuntimeApiError);
  assert.equal(error.apiError.code, 'project_path_rejected');
  assert.equal(error.apiError.requestId, 'req-api-error');
});

test('the requester classifies invalid success envelopes as decode errors', async () => {
  globalThis.fetch = mockFetch(
    new Response(JSON.stringify({ data: { invalid: true }, meta: { requestId: 'req-invalid' } }), {
      status: 200,
    }),
  );

  const error = await Effect.runPromise(
    Effect.flip(createEndpointRequester(runtimeUrl)(apiEndpoints.workspace.get)),
  );

  assert.ok(error instanceof RuntimeDecodeError);
  assert.equal(error.endpointId, apiEndpoints.workspace.get.id);
});

test('the requester passes Effect interruption to fetch', async () => {
  let resolveStarted!: () => void;
  let resolveAborted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });

  globalThis.fetch = ((_input, init) =>
    new Promise<Response>((resolve) => {
      resolveStarted();
      init?.signal?.addEventListener(
        'abort',
        () => {
          resolveAborted();
          resolve(
            new Response(JSON.stringify({ data: workspace, meta: { requestId: 'req-aborted' } }), {
              status: 200,
            }),
          );
        },
        { once: true },
      );
    })) as typeof fetch;

  const controller = new AbortController();
  const request = Effect.runPromise(
    createEndpointRequester(runtimeUrl)(apiEndpoints.workspace.get),
    {
      signal: controller.signal,
    },
  ).catch(() => {});

  await started;
  controller.abort();
  await aborted;
  await request;
});

test('the requester classifies fetch failures as transport errors', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('network down'))) as typeof fetch;

  const error = await Effect.runPromise(
    Effect.flip(createEndpointRequester(runtimeUrl)(apiEndpoints.workspace.get)),
  );

  assert.ok(error instanceof RuntimeTransportError);
});

function mockFetch(response: Response) {
  return (() => Promise.resolve(response.clone())) as typeof fetch;
}
