import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';
import Fastify from 'fastify';

import { apiEndpoints, type ApiError, type HealthOutput } from '@isagi/contracts';

import { registerApiEndpoint } from './endpoint.js';

const health = {
  context: {
    arch: 'x64',
    node: '22.22.3',
    pid: 1,
    platform: 'linux',
  },
  name: 'isagi-runtime',
  ok: true,
  timestamp: '2026-06-05T00:00:00.000Z',
  version: '0.0.1',
} satisfies HealthOutput;

test('API endpoint sends schema-backed success envelopes with request ids', async () => {
  const fastify = Fastify({ logger: false });
  registerApiEndpoint(fastify, apiEndpoints.health, {
    handle: () => Effect.succeed(health),
    run: Effect.runPromise,
  });

  try {
    const response = await fastify.inject({ method: 'GET', url: '/api/v1/health' });
    const payload = response.json() as { data?: unknown; meta?: { requestId?: unknown } };

    assert.equal(response.statusCode, 200);
    assert.deepEqual(payload.data, health);
    assert.equal(typeof payload.meta?.requestId, 'string');
  } finally {
    await fastify.close();
  }
});

test('API endpoint sends mapped domain errors through the endpoint error contract', async () => {
  const fastify = Fastify({ logger: false });
  registerApiEndpoint(fastify, apiEndpoints.projects.add, {
    handle: () => Effect.fail(new Error('not a repository')),
    mapError: (_error, context): ApiError => ({
      code: 'project_path_rejected',
      status: 400,
      message: 'Not a Git repository: /repo/nope',
      requestId: context.requestId,
      data: { reason: 'not_git_repository', path: '/repo/nope' },
    }),
    run: Effect.runPromise,
  });

  try {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { path: '/repo/nope' },
    });
    const payload = response.json() as { error?: ApiError };

    assert.equal(response.statusCode, 400);
    assert.equal(payload.error?.code, 'project_path_rejected');
    assert.equal(typeof payload.error?.requestId, 'string');
    assert.deepEqual(payload.error?.data, {
      reason: 'not_git_repository',
      path: '/repo/nope',
    });
  } finally {
    await fastify.close();
  }
});

test('API endpoint decodes route params before running handlers', async () => {
  const fastify = Fastify({ logger: false });
  let decodedProjectId: number | null = null;
  registerApiEndpoint(fastify, apiEndpoints.projects.delete, {
    handle: (_input, _context, params) =>
      Effect.sync(() => {
        decodedProjectId = params.projectId;
        return { projectId: params.projectId, deleted: true };
      }),
    run: Effect.runPromise,
  });

  try {
    const response = await fastify.inject({ method: 'DELETE', url: '/api/v1/projects/42' });
    const payload = response.json() as { data?: unknown };

    assert.equal(response.statusCode, 200);
    assert.equal(decodedProjectId, 42);
    assert.deepEqual(payload.data, { projectId: 42, deleted: true });
  } finally {
    await fastify.close();
  }
});

test('API endpoint interrupts handlers when the client disconnects', async () => {
  const fastify = Fastify({ logger: false });
  let resolveStarted!: () => void;
  let resolveInterrupted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const interrupted = new Promise<void>((resolve) => {
    resolveInterrupted = resolve;
  });

  registerApiEndpoint(fastify, apiEndpoints.health, {
    handle: () => Effect.succeed(health),
    run: <A>(
      _effect: Effect.Effect<A, unknown, never>,
      options?: { readonly signal?: AbortSignal | undefined },
    ) =>
      new Promise<A>((resolve) => {
        resolveStarted();
        options?.signal?.addEventListener(
          'abort',
          () => {
            resolveInterrupted();
            resolve(health as A);
          },
          { once: true },
        );
      }),
  });

  try {
    const url = await fastify.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const request = fetch(`${url}/api/v1/health`, { signal: controller.signal }).catch(() => {});

    await started;
    controller.abort();
    await Promise.race([
      interrupted,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for request interruption')), 1_000),
      ),
    ]);
    fastify.server.closeAllConnections();
    await request;
  } finally {
    await fastify.close();
  }
});

test('API endpoint interrupts handlers when the server times out the request', async () => {
  const fastify = Fastify({ logger: false });
  fastify.server.setTimeout(25);
  let resolveStarted!: () => void;
  let resolveInterrupted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const interrupted = new Promise<void>((resolve) => {
    resolveInterrupted = resolve;
  });

  registerApiEndpoint(fastify, apiEndpoints.health, {
    handle: () => Effect.succeed(health),
    run: <A>(
      _effect: Effect.Effect<A, unknown, never>,
      options?: { readonly signal?: AbortSignal | undefined },
    ) =>
      new Promise<A>((resolve) => {
        resolveStarted();
        options?.signal?.addEventListener(
          'abort',
          () => {
            resolveInterrupted();
            resolve(health as A);
          },
          { once: true },
        );
      }),
  });

  try {
    const url = await fastify.listen({ host: '127.0.0.1', port: 0 });
    const request = fetch(`${url}/api/v1/health`).catch(() => {});

    await started;
    await Promise.race([
      interrupted,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for request timeout')), 1_000),
      ),
    ]);
    fastify.server.closeAllConnections();
    await request;
  } finally {
    await fastify.close();
  }
});

test('API endpoint returns explicit request decoding errors before running handlers', async () => {
  const fastify = Fastify({ logger: false });
  let handlerRan = false;
  registerApiEndpoint(fastify, apiEndpoints.workspace.setActiveContext, {
    handle: () =>
      Effect.sync(() => {
        handlerRan = true;
        return health as never;
      }),
    run: Effect.runPromise,
  });

  try {
    const response = await fastify.inject({
      method: 'PUT',
      url: '/api/v1/workspace/active-context',
      payload: { worktreeId: 0 },
    });
    const payload = response.json() as { error?: ApiError };

    assert.equal(response.statusCode, 400);
    assert.equal(payload.error?.code, 'api_request_decoding_failed');
    assert.equal(handlerRan, false);
  } finally {
    await fastify.close();
  }
});
