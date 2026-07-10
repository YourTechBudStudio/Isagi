import assert from 'node:assert/strict';
import test from 'node:test';

import websocket from '@fastify/websocket';
import { Effect, Either, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import type { WorkflowEvent, WorkflowRunSummary } from '@isagi/contracts';

import { InternalRuntimeEventBus, InternalRuntimeEventBusLive } from '../runtime-events/index.js';
import { registerWorkflowApi } from './api.js';
import { WorkflowEventLedger } from './event-ledger.service.js';
import { WorkflowEngineError } from './types.js';
import { WorkflowEngine } from './workflow-engine.service.js';
import type {
  WorkflowEngineService,
  WorkflowStartContextInput,
} from './workflow-engine.service.js';
import { WorkflowRunProjection } from './workflow-run-projection.service.js';

test('list route returns workflow descriptors from the engine', async () => {
  const fastify = Fastify({ logger: false });
  let listContext: WorkflowStartContextInput | null = null;

  registerWorkflowApi(fastify, {
    runPromise: async <A>(effect: Effect.Effect<A, unknown, WorkflowEngineService>) =>
      Effect.runPromise(
        Effect.provideService(effect, WorkflowEngine, {
          listWorkflowDescriptors: (input: { readonly context: WorkflowStartContextInput }) =>
            Effect.sync(() => {
              listContext = input.context;
              return [
                {
                  ok: true as const,
                  workflowKey: 'ship-it',
                  manifest: {
                    title: 'Ship it',
                    description: 'Runs the release checklist.',
                    inputs: [{ kind: 'text' as const, key: 'version', label: 'Version' }],
                  },
                },
                {
                  ok: false as const,
                  workflowKey: 'broken',
                  reason: 'artifact_load_failed' as const,
                  diagnostic: 'Could not load workflow.',
                },
              ];
            }),
        } as never),
      ),
  } as never);

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/descriptors',
    payload: { context: { worktreeId: 7, surfaceId: 42, paneId: 99, agentSessionId: 100 } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(listContext, { worktreeId: 7, surfaceId: 42, paneId: 99, agentSessionId: 100 });
  const body = JSON.parse(response.body) as {
    readonly data: { readonly workflows: readonly unknown[] };
    readonly meta: { readonly requestId: string };
  };
  assert.deepEqual(body, {
    data: {
      workflows: [
        {
          ok: true,
          workflowKey: 'ship-it',
          manifest: {
            title: 'Ship it',
            description: 'Runs the release checklist.',
            inputs: [{ kind: 'text', key: 'version', label: 'Version' }],
          },
        },
        {
          ok: false,
          workflowKey: 'broken',
          reason: 'artifact_load_failed',
          diagnostic: 'Could not load workflow.',
        },
      ],
    },
    meta: { requestId: body.meta.requestId },
  });
});

test('start route starts a workflow with launch context and variables', async () => {
  const fastify = Fastify({ logger: false });
  let startInput: unknown = null;

  registerWorkflowApi(fastify, {
    runPromise: async <A>(effect: Effect.Effect<A, unknown, WorkflowEngineService>) =>
      Effect.runPromise(
        Effect.provideService(effect, WorkflowEngine, {
          startWorkflow: (input: unknown) =>
            Effect.sync(() => {
              startInput = input;
              return { id: 123, workflowKey: 'ship-it' };
            }),
        } as never),
      ),
  } as never);

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/runs',
    payload: {
      workflowKey: 'ship-it',
      variables: { version: '1.2.3' },
      context: { worktreeId: 7, surfaceId: 42, paneId: null, agentSessionId: null },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(startInput, {
    workflowKey: 'ship-it',
    variables: { version: '1.2.3' },
    context: { worktreeId: 7, surfaceId: 42, paneId: null, agentSessionId: null },
  });
  const body = JSON.parse(response.body) as {
    readonly data: { readonly workflowRunId: number; readonly workflowKey: string };
    readonly meta: { readonly requestId: string };
  };
  assert.deepEqual(body, {
    data: { workflowRunId: 123, workflowKey: 'ship-it' },
    meta: { requestId: body.meta.requestId },
  });
});

test('workflow API maps wrapped workflow engine errors to contract errors', async () => {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(fastify, {
    runPromise: async () => {
      return Either.left(
        new WorkflowEngineError({
          code: 'workflow_user_input_invalid',
          message: 'Invalid workflow input.',
          workflowRunId: 1,
        }),
      );
    },
  } as never);

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/runs/1/advance',
    payload: { answers: { risk: 'medium' } },
  });

  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body) as {
    readonly error: { readonly requestId: string };
  };
  assert.deepEqual(body, {
    error: {
      code: 'workflow_rejected',
      status: 400,
      message: 'Invalid workflow input.',
      requestId: body.error.requestId,
      data: { reason: 'workflow_user_input_invalid', workflowRunId: 1 },
    },
  });
});

test('workflow API preserves the contracted load reason for web-owned copy', async () => {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(fastify, {
    runPromise: async () =>
      Either.left(
        new WorkflowEngineError({
          code: 'workflow_load_failed',
          message: 'Workflow source differs from the verified build.',
          workflowKey: 'stale',
          workflowLoadFailureReason: 'stale_source',
        }),
      ),
  } as never);

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/runs',
    payload: {
      workflowKey: 'stale',
      context: { worktreeId: 7, surfaceId: 42 },
    },
  });

  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body) as {
    readonly error: { readonly requestId: string };
  };
  assert.deepEqual(body, {
    error: {
      code: 'workflow_rejected',
      status: 400,
      message: 'Workflow source differs from the verified build.',
      requestId: body.error.requestId,
      data: {
        reason: 'workflow_load_failed',
        workflowKey: 'stale',
        workflowLoadFailureReason: 'stale_source',
      },
    },
  });
});

test('retry route returns the run-scoped control response', async () => {
  const fastify = Fastify({ logger: false });
  let retryRunId: number | null = null;

  registerWorkflowApi(fastify, {
    runPromise: async <A>(effect: Effect.Effect<A, unknown, WorkflowEngineService>) =>
      Effect.runPromise(
        Effect.provideService(effect, WorkflowEngine, {
          retry: (input: { readonly runId: number }) =>
            Effect.sync(() => {
              retryRunId = input.runId;
              return { runId: 42, status: 'ready' };
            }),
        } as never),
      ),
  } as never);

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/runs/42/retry',
    payload: {},
  });

  assert.equal(response.statusCode, 200);
  assert.equal(retryRunId, 42);
  const body = JSON.parse(response.body) as {
    readonly data: { readonly runId: number; readonly status: string };
    readonly meta: { readonly requestId: string };
  };
  assert.deepEqual(body, {
    data: { runId: 42, status: 'ready' },
    meta: { requestId: body.meta.requestId },
  });
});

test('workflow event replay rejects missing runs with a stable workflow reason', async () => {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(WorkflowRunProjection, {
        listSummaries: () => Effect.succeed([]),
        getSummary: () => Effect.succeed(null),
      }),
      Layer.succeed(WorkflowEventLedger, {
        append: () => Effect.die('append is not used by replay route test'),
        readRunEvents: () => Effect.die('missing runs must be rejected before ledger replay'),
        latestUiFeedbackForRunTree: () => Effect.succeed(undefined),
        deleteRunTreeLedgers: () => Effect.void,
        collectOrphans: Effect.void,
        sweepSurfaceDeletedRuns: Effect.void,
        pathForRun: () => '',
      }),
    ),
  );

  try {
    registerWorkflowApi(fastify, runtime as never);

    const response = await fastify.inject({
      method: 'GET',
      url: '/api/v1/workflows/runs/99/events',
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body) as {
      readonly error: { readonly requestId: string };
    };
    assert.deepEqual(body, {
      error: {
        code: 'workflow_rejected',
        status: 400,
        message: 'Workflow run 99 was not found.',
        requestId: body.error.requestId,
        data: { reason: 'workflow_run_not_found', workflowRunId: 99 },
      },
    });
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('workflow event stream includes child log events only when requested', async () => {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      InternalRuntimeEventBusLive,
      Layer.succeed(WorkflowRunProjection, {
        listSummaries: () => Effect.succeed([workflowSummaryFixture()]),
        getSummary: (runId: number) =>
          Effect.succeed(runId === 42 ? workflowSummaryFixture() : null),
      }),
      Layer.succeed(WorkflowEventLedger, {
        append: () => Effect.die('append is not used by stream route test'),
        readRunEvents: (input: { readonly includeChildren: boolean }) =>
          Effect.sleep('25 millis').pipe(
            Effect.as(input.includeChildren ? [rootLogEvent(), childLogEvent()] : [rootLogEvent()]),
          ),
        latestUiFeedbackForRunTree: () => Effect.succeed(undefined),
        deleteRunTreeLedgers: () => Effect.void,
        collectOrphans: Effect.void,
        sweepSurfaceDeletedRuns: Effect.void,
        pathForRun: () => '',
      }),
    ),
  );

  try {
    await fastify.register(websocket);
    registerWorkflowApi(fastify, runtime as never);
    await fastify.ready();

    const rootOnly = await fastify.injectWS('/api/v1/workflows/runs/42/events-stream');
    try {
      rootOnly.send(JSON.stringify({ type: 'workflow_events_requested' }));
      assert.deepEqual(await takeWorkflowStreamMessage(rootOnly), {
        type: 'workflow_events_snapshot',
        events: [rootLogEvent()],
      });
      await new Promise((resolve) => setImmediate(resolve));
      await runtime.runPromise(publishChildWorkflowLogEvent);
      await assertNoWorkflowStreamMessage(rootOnly);
    } finally {
      rootOnly.terminate();
    }

    const withChildren = await fastify.injectWS(
      '/api/v1/workflows/runs/42/events-stream?includeChildren=true',
    );
    try {
      withChildren.send(JSON.stringify({ type: 'workflow_events_requested' }));
      assert.deepEqual(await takeWorkflowStreamMessage(withChildren), {
        type: 'workflow_events_snapshot',
        events: [rootLogEvent(), childLogEvent()],
      });
      await new Promise((resolve) => setImmediate(resolve));
      await runtime.runPromise(publishChildWorkflowLogEvent);
      assert.deepEqual(await takeWorkflowStreamMessage(withChildren), {
        type: 'workflow_event_appended',
        event: childLogEvent(),
      });
    } finally {
      withChildren.terminate();
    }

    const missingRun = await fastify.injectWS('/api/v1/workflows/runs/99/events-stream');
    try {
      missingRun.send(JSON.stringify({ type: 'workflow_events_requested' }));
      assert.deepEqual(await takeWorkflowStreamMessage(missingRun), {
        type: 'error',
        code: 'workflow_run_not_found',
        message: 'Workflow run 99 was not found.',
      });
    } finally {
      missingRun.terminate();
    }
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

const publishChildWorkflowLogEvent = Effect.gen(function* () {
  const bus = yield* InternalRuntimeEventBus;
  yield* bus.publish({
    type: 'workflow_event_appended',
    surfaceId: 3,
    rootRunId: 42,
    runId: 43,
    event: childLogEvent(),
  });
});

function workflowSummaryFixture(): WorkflowRunSummary {
  return {
    runId: 42,
    rootRunId: 42,
    parentRunId: null,
    workflowKey: 'gate',
    title: 'Gate',
    status: 'running',
    paused: false,
    waitKind: null,
    blockingWait: null,
    worktreeId: 9,
    surfaceId: 3,
  };
}

function rootLogEvent(): WorkflowEvent {
  return {
    ts: '2026-06-12T00:00:00.000Z',
    runId: 42,
    type: 'log',
    level: 'info',
    message: 'root log',
  };
}

function childLogEvent(): WorkflowEvent {
  return {
    ts: '2026-06-12T00:00:01.000Z',
    runId: 43,
    type: 'log',
    level: 'info',
    message: 'child log',
  };
}

function takeWorkflowStreamMessage(ws: {
  once: (event: 'message', listener: (data: Buffer) => void) => void;
}) {
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for workflow stream message.')),
      1_000,
    );
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function assertNoWorkflowStreamMessage(ws: {
  once: (event: 'message', listener: (data: Buffer) => void) => void;
}) {
  const sentinel = Symbol('no-message');
  const result = await Promise.race([
    takeWorkflowStreamMessage(ws),
    new Promise<typeof sentinel>((resolve) => setTimeout(() => resolve(sentinel), 50)),
  ]);
  assert.equal(result, sentinel);
}
