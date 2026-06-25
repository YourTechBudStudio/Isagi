import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Either } from 'effect';
import Fastify from 'fastify';

import { registerWorkflowApi } from './api.js';
import { WorkflowEngineError } from './types.js';
import { WorkflowEngine } from './workflow-engine.service.js';
import type {
  WorkflowEngineService,
  WorkflowStartContextInput,
} from './workflow-engine.service.js';

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
                  message: 'Could not load workflow.',
                },
              ];
            }),
        } as never),
      ),
  } as never);

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/list',
    payload: { context: { worktreeId: 7, surfaceId: 42, paneId: 99 } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(listContext, { worktreeId: 7, surfaceId: 42, paneId: 99 });
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
          message: 'Could not load workflow.',
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
    url: '/api/v1/workflows/start',
    payload: {
      workflowKey: 'ship-it',
      variables: { version: '1.2.3' },
      context: { worktreeId: 7, surfaceId: 42, paneId: null },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(startInput, {
    workflowKey: 'ship-it',
    variables: { version: '1.2.3' },
    context: { worktreeId: 7, surfaceId: 42, paneId: null },
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

test('retry route returns the surface-scoped control response', async () => {
  const fastify = Fastify({ logger: false });
  let retrySurfaceId: number | null = null;

  registerWorkflowApi(fastify, {
    runPromise: async <A>(effect: Effect.Effect<A, unknown, WorkflowEngineService>) =>
      Effect.runPromise(
        Effect.provideService(effect, WorkflowEngine, {
          retry: (input: { readonly surfaceId: number }) =>
            Effect.sync(() => {
              retrySurfaceId = input.surfaceId;
              return { id: 9, status: 'ready' };
            }),
        } as never),
      ),
  } as never);

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/surfaces/42/retry',
    payload: {},
  });

  assert.equal(response.statusCode, 200);
  assert.equal(retrySurfaceId, 42);
  const body = JSON.parse(response.body) as {
    readonly data: { readonly surfaceId: number };
    readonly meta: { readonly requestId: string };
  };
  assert.deepEqual(body, {
    data: { surfaceId: 42 },
    meta: { requestId: body.meta.requestId },
  });
});
