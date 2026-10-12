import assert from 'node:assert/strict';
import test from 'node:test';

import { Data, Effect, Layer, ManagedRuntime, References } from 'effect';
import { TestClock } from 'effect/testing';
import Fastify from 'fastify';

import { apiEndpoints, type ApiError, type HealthOutput } from '@isagi/contracts';

import { makeLogCapture } from '../../../test/test-support.js';
import { DatabaseError } from '../persistence/index.js';
import { registerApiEndpoint } from './endpoint.js';
import { routeRuntimeOf, serviceFreeRouteRuntime } from './testing.js';

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

class NotARepository extends Data.TaggedError('NotARepository')<{ readonly path: string }> {}

test('API endpoint sends schema-backed success envelopes with request ids', async () => {
  const fastify = Fastify({ logger: false });
  registerApiEndpoint(fastify, serviceFreeRouteRuntime, apiEndpoints.health, () =>
    Effect.succeed(health),
  );

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
  registerApiEndpoint(fastify, serviceFreeRouteRuntime, apiEndpoints.projects.add, (request) =>
    Effect.fail(new NotARepository({ path: request.body.path })).pipe(
      Effect.catchTag('NotARepository', (error) =>
        request.reject({
          code: 'project_path_rejected',
          status: 400,
          message: `Not a Git repository: ${error.path}`,
          data: { reason: 'not_git_repository', path: error.path },
        }),
      ),
    ),
  );

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

test('API endpoint maps a declared infrastructure error to its contract envelope', async () => {
  const fastify = Fastify({ logger: false });
  registerApiEndpoint(fastify, serviceFreeRouteRuntime, apiEndpoints.projects.add, () =>
    Effect.fail(new DatabaseError({ operation: 'insert_project', cause: new Error('locked') })),
  );

  try {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { path: '/repo' },
    });
    const payload = response.json() as { error?: ApiError };

    assert.equal(response.statusCode, 500);
    assert.deepEqual(Object.keys(payload.error ?? {}), [
      'code',
      'status',
      'message',
      'requestId',
      'data',
    ]);
    assert.equal(payload.error?.code, 'runtime_database_failed');
    assert.equal(payload.error?.message, 'Database operation failed: insert_project');
    assert.deepEqual(payload.error?.data, { operation: 'insert_project' });
  } finally {
    await fastify.close();
  }
});

test('API endpoint decodes route params before running handlers', async () => {
  const fastify = Fastify({ logger: false });
  let decodedProjectId: number | null = null;
  registerApiEndpoint(fastify, serviceFreeRouteRuntime, apiEndpoints.projects.delete, (request) =>
    Effect.sync(() => {
      decodedProjectId = request.params.projectId;
      return { projectId: request.params.projectId, deleted: true };
    }),
  );

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

/** A handler that signals when it starts and when its fiber is interrupted, and otherwise never finishes. */
function interruptibleHandler() {
  let resolveStarted!: () => void;
  let resolveInterrupted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const interrupted = new Promise<void>((resolve) => {
    resolveInterrupted = resolve;
  });
  const handle = () =>
    Effect.sync(() => resolveStarted()).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => resolveInterrupted())),
    );
  return { started, interrupted, handle };
}

function within(promise: Promise<unknown>, message: string) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(message)), 1_000)),
  ]);
}

test('API endpoint interrupts handlers when the client disconnects', async () => {
  const fastify = Fastify({ logger: false });
  const handler = interruptibleHandler();
  registerApiEndpoint(fastify, serviceFreeRouteRuntime, apiEndpoints.health, handler.handle);

  try {
    const url = await fastify.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const request = fetch(`${url}/api/v1/health`, { signal: controller.signal }).catch(() => {});

    await handler.started;
    controller.abort();
    await within(handler.interrupted, 'Timed out waiting for request interruption');
    fastify.server.closeAllConnections();
    await request;
  } finally {
    await fastify.close();
  }
});

test('API endpoint interrupts handlers when the server times out the request', async () => {
  const fastify = Fastify({ logger: false });
  fastify.server.setTimeout(25);
  const handler = interruptibleHandler();
  registerApiEndpoint(fastify, serviceFreeRouteRuntime, apiEndpoints.health, handler.handle);

  try {
    const url = await fastify.listen({ host: '127.0.0.1', port: 0 });
    const request = fetch(`${url}/api/v1/health`).catch(() => {});

    await handler.started;
    await within(handler.interrupted, 'Timed out waiting for request timeout');
    fastify.server.closeAllConnections();
    await request;
  } finally {
    await fastify.close();
  }
});

test('API endpoint returns explicit request decoding errors before running handlers', async () => {
  const fastify = Fastify({ logger: false });
  let handlerRan = false;
  registerApiEndpoint(
    fastify,
    serviceFreeRouteRuntime,
    apiEndpoints.workspace.setActiveContext,
    () =>
      Effect.sync(() => {
        handlerRan = true;
        return health as never;
      }),
  );

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

test('API endpoint answers a defect with api_unhandled_error and logs it with the request ids', async () => {
  const capture = makeLogCapture();
  const runtime = ManagedRuntime.make(capture.layer);
  const fastify = Fastify({ logger: false });
  registerApiEndpoint(fastify, routeRuntimeOf(runtime), apiEndpoints.health, () =>
    Effect.die(new Error('handler blew up')),
  );

  try {
    const response = await fastify.inject({ method: 'GET', url: '/api/v1/health' });
    const payload = response.json() as { error?: ApiError };

    assert.equal(response.statusCode, 500);
    assert.equal(payload.error?.code, 'api_unhandled_error');
    assert.equal(payload.error?.message, 'handler blew up');
    assert.deepEqual(payload.error?.data, { endpointId: 'health.get' });

    const logged = capture.lines.find((line) => line.message === 'Unhandled API handler failure');
    assert.ok(logged, 'the defect is logged');
    assert.equal(logged.level, 'Error');
    assert.equal(logged.annotations.endpointId, 'health.get');
    assert.equal(logged.annotations.requestId, payload.error?.requestId);
    assert.match(logged.cause ?? '', /handler blew up/);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('API endpoint reports output that does not match its contract as a response encoding failure', async () => {
  const fastify = Fastify({ logger: false });
  registerApiEndpoint(fastify, serviceFreeRouteRuntime, apiEndpoints.health, () =>
    Effect.succeed({ ...health, ok: false } as never),
  );

  try {
    const response = await fastify.inject({ method: 'GET', url: '/api/v1/health' });
    const payload = response.json() as { error?: ApiError };

    assert.equal(response.statusCode, 500);
    assert.equal(payload.error?.code, 'api_response_encoding_failed');
  } finally {
    await fastify.close();
  }
});

test('API endpoint reports a slow request at Debug while it runs and when it completes', async () => {
  const capture = makeLogCapture();
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      capture.layer,
      Layer.succeed(References.MinimumLogLevel, 'Debug'),
      TestClock.layer(),
    ),
  );
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const fastify = Fastify({ logger: false });
  registerApiEndpoint(fastify, routeRuntimeOf(runtime), apiEndpoints.health, () =>
    Effect.sync(() => resolveStarted()).pipe(
      Effect.andThen(Effect.sleep('2 seconds')),
      Effect.as(health),
    ),
  );

  try {
    const response = fastify.inject({ method: 'GET', url: '/api/v1/health' });
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.runPromise(TestClock.adjust('2 seconds'));
    assert.equal((await response).statusCode, 200);

    const stillRunning = capture.lines.find((line) => line.message === 'api.request_still_running');
    const completed = capture.lines.find((line) => line.message === 'api.request_completed');
    assert.ok(stillRunning, 'the request is reported while it is still running');
    assert.equal(stillRunning.level, 'Debug');
    assert.equal(stillRunning.annotations.endpointId, 'health.get');
    assert.ok(completed, 'the slow completion is reported');
    assert.equal(completed.level, 'Debug');
    assert.equal(completed.annotations.outcome, 'succeeded');
    assert.equal(completed.annotations.elapsedMs, 2_000);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});
