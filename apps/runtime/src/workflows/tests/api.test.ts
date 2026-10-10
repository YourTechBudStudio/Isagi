import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { withApiServer } from '../../platform/http/testing.js';
import { DatabaseError } from '../../platform/persistence/index.js';
import { ProjectConfigError } from '../../projects/index.js';
import { registerWorkflowsRoutes } from '../api.js';
import { WorkflowEngine } from '../engine/service.js';
import { WorkflowEngineError } from '../errors.js';

/**
 * The workflow routes' error mapping, over a faked engine: each endpoint answers a refusal in the
 * workflow vocabulary, lets platform failures through as themselves, and reports a failure underneath
 * a launch the way the workspace reports it everywhere else.
 */

function withWorkflowsApi(
  engine: Partial<WorkflowEngine['Service']>,
  run: (
    request: (method: 'GET' | 'POST', url: string, body?: object) => Promise<Reply>,
  ) => Promise<void>,
) {
  return withApiServer(Layer.mock(WorkflowEngine)(engine), registerWorkflowsRoutes, (fastify) =>
    run(async (method, url, body) => {
      const response = await fastify.inject({
        method,
        url: `/api/v1${url}`,
        ...(body === undefined ? {} : { payload: body }),
      });
      return { status: response.statusCode, body: response.json() };
    }),
  );
}

interface Reply {
  readonly status: number;
  readonly body: { readonly error?: Record<string, unknown> } & Record<string, unknown>;
}

test('a control the run refuses is a workflow rejection carrying the refused control', async () => {
  await withWorkflowsApi(
    {
      pause: (runId) =>
        Effect.fail(
          new WorkflowEngineError({
            code: 'workflow_control_unavailable',
            message: `Run ${runId} is completed, so it cannot pause.`,
            workflowRunId: runId,
            control: 'pause',
          }),
        ),
    },
    async (request) => {
      const reply = await request('POST', '/workflows/runs/7/pause');
      assert.equal(reply.status, 409);
      assert.equal(reply.body.error?.code, 'workflow_rejected');
      assert.equal(reply.body.error?.message, 'Run 7 is completed, so it cannot pause.');
      assert.deepEqual(reply.body.error?.data, {
        workflowRunId: 7,
        control: 'pause',
        reason: 'workflow_control_unavailable',
      });
    },
  );
});

test('a checkpoint export refused for its destination names the path and the issue', async () => {
  await withWorkflowsApi(
    {
      exportCheckpoint: (checkpointId, destinationPath) =>
        Effect.fail(
          new WorkflowEngineError({
            code: 'workflow_checkpoint_destination_rejected',
            message: `${destinationPath} is not empty.`,
            checkpointId,
            destination: { path: destinationPath, issue: 'not_empty' },
          }),
        ),
    },
    async (request) => {
      const reply = await request('POST', '/workflows/checkpoints/3/export', {
        destinationPath: '/tmp/taken',
      });
      assert.equal(reply.status, 400);
      assert.deepEqual(reply.body.error?.data, {
        checkpointId: 3,
        reason: 'workflow_checkpoint_destination_rejected',
        destinationPath: '/tmp/taken',
        destinationIssue: 'not_empty',
      });
    },
  );
});

test('a launch whose project configuration is invalid reads as the workspace reports it', async () => {
  await withWorkflowsApi(
    {
      launch: () =>
        Effect.fail(
          new ProjectConfigError({
            code: 'setup_config_invalid',
            message: 'isagi.yaml is not valid.',
            path: '/repo/isagi.yaml',
            projectId: 2,
          }),
        ),
    },
    async (request) => {
      const reply = await request('POST', '/workflows/runs', {
        workflowKey: 'review',
        origin: { worktreeId: 1, surfaceId: 1 },
      });
      assert.equal(reply.status, 400);
      assert.equal(reply.body.error?.code, 'worktree_setup_rejected');
      assert.deepEqual(reply.body.error?.data, { reason: 'setup_config_invalid', projectId: 2 });
    },
  );
});

test('a database failure under a read passes through as the infrastructure failure it is', async () => {
  await withWorkflowsApi(
    {
      getRun: () =>
        Effect.fail(new DatabaseError({ operation: 'workflow_get_run', cause: new Error('disk') })),
    },
    async (request) => {
      const reply = await request('GET', '/workflows/runs/4');
      assert.equal(reply.status, 500);
      assert.equal(reply.body.error?.code, 'runtime_database_failed');
      assert.deepEqual(reply.body.error?.data, { operation: 'workflow_get_run' });
    },
  );
});
