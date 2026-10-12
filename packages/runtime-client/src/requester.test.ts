import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Fiber, Layer } from 'effect';

import {
  apiEndpoints,
  type ApiEndpointError,
  type ApiError,
  type ApiInfrastructureError,
  type WorkspaceSnapshot,
  workflowContentEndpoints,
} from '@isagi/contracts';

import {
  RuntimeApiError,
  RuntimeClient,
  RuntimeDecodeError,
  RuntimeHttpClient,
  RuntimeTransportError,
} from './index.js';
import { fakeRuntime, json, runtimeUrl } from './test-support.js';

const workspace = { projects: [] } satisfies WorkspaceSnapshot;
const workspaceEnvelope = { data: workspace, meta: { requestId: 'req' } };
const getWorkspace = RuntimeClient.use((client) => client.request(apiEndpoints.workspace.get));

test('the requester decodes success envelopes', async () => {
  const runtime = fakeRuntime(() => json({ data: workspace, meta: { requestId: 'req-success' } }));

  const snapshot = await runtime.run(getWorkspace);

  assert.deepEqual(snapshot, workspace);
  assert.equal(runtime.seen[0]?.url, `${runtimeUrl}/api/v1/workspace`);
  assert.equal(runtime.seen[0]?.method, 'GET');
});

test('the requester interpolates path params', async () => {
  const runtime = fakeRuntime(() =>
    json({ data: { projectId: 42, deleted: true }, meta: { requestId: 'req' } }),
  );

  const output = await runtime.run(
    RuntimeClient.use((client) => client.request(apiEndpoints.projects.delete, { projectId: 42 })),
  );

  assert.equal(runtime.seen[0]?.url, `${runtimeUrl}/api/v1/projects/42`);
  assert.equal(runtime.seen[0]?.method, 'DELETE');
  assert.deepEqual(output, { projectId: 42, deleted: true });
});

test('the requester repeats an array query parameter instead of joining it', async () => {
  const runtime = fakeRuntime(() =>
    json({ data: { items: [], nextCursor: null }, meta: { requestId: 'req' } }),
  );

  await runtime.run(
    RuntimeClient.use((client) =>
      client.request(apiEndpoints.workflows.listRuns, {
        workflowKey: ['a,b', 'c'] as never,
        cursor: undefined,
      }),
    ),
  );

  const url = new URL(runtime.seen[0]?.url ?? '');
  assert.deepEqual(url.searchParams.getAll('workflowKey'), ['a,b', 'c']);
  assert.equal(url.searchParams.has('cursor'), false);
});

test('the requester encodes query values exactly as URLSearchParams does', async () => {
  const runtime = fakeRuntime(() =>
    json({ data: { items: [], nextCursor: null }, meta: { requestId: 'req' } }),
  );

  await runtime.run(
    RuntimeClient.use((client) =>
      client.request(apiEndpoints.workflows.listRuns, {
        workflowKey: ['a,b', 'c d+é/?&='] as never,
        cursor: undefined,
      }),
    ),
  );

  const expected = new URL(`${runtimeUrl}/api/v1/workflows/runs`);
  expected.searchParams.append('workflowKey', 'a,b');
  expected.searchParams.append('workflowKey', 'c d+é/?&=');
  assert.equal(runtime.seen[0]?.url, expected.toString());
});

test('a GET carries no headers the requester did not set', async () => {
  const runtime = fakeRuntime(() => json(workspaceEnvelope));

  await runtime.run(getWorkspace);

  assert.deepEqual(runtime.seen[0]?.headers, {});
  assert.equal(runtime.seen[0]?.body, undefined);
});

test('a body request sends the JSON text with exactly a JSON content type', async () => {
  const body = { path: '/repo/a b', name: undefined };
  const runtime = fakeRuntime(() =>
    json(
      { error: { code: 'api_unhandled_error', status: 500, message: 'x', requestId: 'r' } },
      500,
    ),
  );

  await runtime.run(
    RuntimeClient.use((client) => client.request(apiEndpoints.projects.add, body as never)).pipe(
      Effect.flip,
    ),
  );

  assert.equal(runtime.seen[0]?.method, 'POST');
  assert.equal(runtime.seen[0]?.body, JSON.stringify(body));
  assert.deepEqual(runtime.seen[0]?.headers, { 'content-type': 'application/json' });
});

test('trace propagation stays off inside an outer span', async () => {
  const runtime = fakeRuntime(() => json(workspaceEnvelope));

  await runtime.run(getWorkspace.pipe(Effect.withSpan('outer')));

  assert.deepEqual(runtime.seen[0]?.headers, {});
});

test('the requester decodes endpoint API errors before base API errors', async () => {
  const apiError = {
    code: 'project_path_rejected',
    status: 400,
    message: 'Not a Git repository: /repo/nope',
    requestId: 'req-api-error',
    data: { reason: 'not_git_repository', path: '/repo/nope' },
  } satisfies ApiError;
  const runtime = fakeRuntime(() => json({ error: apiError }, 400));

  const error = await runtime.run(
    RuntimeClient.use((client) =>
      client.request(apiEndpoints.projects.add, { path: '/repo/nope' }),
    ).pipe(Effect.flip),
  );

  assert.ok(error instanceof RuntimeApiError);
  assert.equal(error.endpointId, apiEndpoints.projects.add.id);
  assert.equal(error.apiError.code, 'project_path_rejected');
  assert.equal(error.apiError.requestId, 'req-api-error');
  assert.equal(error.message, apiError.message);
});

test('catchTag narrows an API error to the endpoint codes plus infrastructure codes', async () => {
  const runtime = fakeRuntime(() =>
    json(
      {
        error: {
          code: 'project_path_rejected',
          status: 400,
          message: 'no',
          requestId: 'r',
          data: { reason: 'not_git_repository', path: '/x' },
        },
      },
      400,
    ),
  );

  const code = await runtime.run(
    RuntimeClient.use((client) => client.request(apiEndpoints.projects.add, { path: '/x' })).pipe(
      Effect.map(() => 'succeeded'),
      Effect.catchTag('RuntimeApiError', (failure) => {
        // Compile-time: a plain `string` code would not be assignable here.
        const narrowed:
          | ApiEndpointError<typeof apiEndpoints.projects.add>['code']
          | ApiInfrastructureError['code'] = failure.apiError.code;
        return Effect.succeed(narrowed);
      }),
    ),
  );

  assert.equal(code, 'project_path_rejected');
});

test('an infrastructure error envelope decodes through the base arm', async () => {
  const runtime = fakeRuntime(() =>
    json(
      { error: { code: 'api_unhandled_error', status: 500, message: 'x', requestId: 'r' } },
      500,
    ),
  );

  const error = await runtime.run(getWorkspace.pipe(Effect.flip));

  assert.ok(error instanceof RuntimeApiError);
  assert.equal(error.apiError.code, 'api_unhandled_error');
});

test('the requester classifies invalid success envelopes as decode errors', async () => {
  const runtime = fakeRuntime(() =>
    json({ data: { invalid: true }, meta: { requestId: 'req-invalid' } }),
  );

  const error = await runtime.run(getWorkspace.pipe(Effect.flip));

  assert.ok(error instanceof RuntimeDecodeError);
  assert.equal(error._tag, 'RuntimeDecodeError');
  assert.equal(error.endpointId, apiEndpoints.workspace.get.id);
  assert.equal(
    error.message,
    `Runtime response for ${apiEndpoints.workspace.get.id} did not match the API contract.`,
  );
});

test('a non-JSON response body is a decode error', async () => {
  const runtime = fakeRuntime(() => new Response('<html>bad gateway</html>', { status: 502 }));

  const error = await runtime.run(getWorkspace.pipe(Effect.flip));

  assert.ok(error instanceof RuntimeDecodeError);
});

test('the requester passes Effect interruption to fetch', async () => {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const runtime = fakeRuntime(
    (seen) =>
      new Promise<Response>((resolve) => {
        started.resolve();
        seen.signal?.addEventListener(
          'abort',
          () => {
            aborted.resolve();
            resolve(json(workspaceEnvelope));
          },
          { once: true },
        );
      }),
  );

  await runtime.run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(getWorkspace);
      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(fiber);
      yield* Effect.promise(() => aborted.promise);
    }),
  );
});

test('the requester classifies fetch failures as transport errors', async () => {
  const networkDown = new Error('network down');
  const runtime = fakeRuntime(() => Promise.reject(networkDown));

  const error = await runtime.run(getWorkspace.pipe(Effect.flip));

  assert.ok(error instanceof RuntimeTransportError);
  assert.equal(error.endpointId, apiEndpoints.workspace.get.id);
  assert.equal(error.cause, networkDown);
  assert.equal(error.message, `Could not reach runtime endpoint ${apiEndpoints.workspace.get.id}.`);
});

test('a malformed runtime URL fails as a transport error and sends nothing', async () => {
  const runtime = fakeRuntime(() => json(workspaceEnvelope));

  const [plain, content] = await runtime.run(
    Effect.gen(function* () {
      const client = yield* RuntimeClient.make('not a url');
      const plainFailure = yield* client.request(apiEndpoints.workspace.get).pipe(Effect.flip);
      const contentFailure = yield* client
        .requestContent(
          workflowContentEndpoints.getCheckpointFile,
          { checkpointId: 2 },
          { path: 'a.txt' },
        )
        .pipe(Effect.flip);
      return [plainFailure, contentFailure] as const;
    }),
  );

  assert.ok(plain instanceof RuntimeTransportError);
  assert.equal(plain.endpointId, apiEndpoints.workspace.get.id);
  assert.ok(content instanceof RuntimeTransportError);
  assert.deepEqual(runtime.seen, []);
});

test('a body JSON cannot encode fails as a transport error and sends nothing', async () => {
  const runtime = fakeRuntime(() => json(workspaceEnvelope));

  const error = await runtime.run(
    RuntimeClient.use((client) =>
      client.request(apiEndpoints.projects.add, { path: '/repo', size: 1n } as never),
    ).pipe(Effect.flip),
  );

  assert.ok(error instanceof RuntimeTransportError);
  assert.equal(error.endpointId, apiEndpoints.projects.add.id);
  assert.ok(error.cause instanceof TypeError);
  assert.deepEqual(runtime.seen, []);
});

test('a failed request rejects Effect.runPromise with the tagged error itself', async () => {
  const layer = RuntimeClient.layer(runtimeUrl).pipe(Layer.provide(RuntimeHttpClient));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
  try {
    await assert.rejects(Effect.runPromise(getWorkspace.pipe(Effect.provide(layer))), (error) => {
      assert.ok(error instanceof RuntimeTransportError);
      assert.equal(error._tag, 'RuntimeTransportError');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RuntimeHttpClient resolves globalThis.fetch per request', async () => {
  const layer = RuntimeClient.layer(runtimeUrl).pipe(Layer.provide(RuntimeHttpClient));
  const originalFetch = globalThis.fetch;
  const seen: { readonly fetch: string; readonly headers: Record<string, string> }[] = [];
  const answering =
    (name: string): typeof fetch =>
    (_input, init) => {
      seen.push({ fetch: name, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return Promise.resolve(json(workspaceEnvelope));
    };
  try {
    globalThis.fetch = answering('first');
    await Effect.runPromise(
      Effect.scoped(getWorkspace.pipe(Effect.withSpan('outer'), Effect.provide(layer))),
    );
    globalThis.fetch = answering('second');
    await Effect.runPromise(Effect.scoped(getWorkspace.pipe(Effect.provide(layer))));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(seen, [
    { fetch: 'first', headers: {} },
    { fetch: 'second', headers: {} },
  ]);
});

test('RuntimeClient.make builds a client for a URL known only at run time', async () => {
  const runtime = fakeRuntime(() => json(workspaceEnvelope));

  await runtime.run(
    Effect.gen(function* () {
      const client = yield* RuntimeClient.make('http://elsewhere.test:4100');
      assert.equal(client.runtimeUrl, 'http://elsewhere.test:4100');
      return yield* client.request(apiEndpoints.workspace.get);
    }),
  );

  assert.equal(runtime.seen[0]?.url, 'http://elsewhere.test:4100/api/v1/workspace');
});
