import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause, Runtime } from 'effect';
import Fastify from 'fastify';

import { registerWorkflowDevApi } from './api.js';
import { WorkflowEngineError } from './types.js';

test('workflow dev API maps wrapped workflow engine errors to 400', async () => {
  const fastify = Fastify({ logger: false });
  registerWorkflowDevApi(fastify, {
    runPromise: async () => {
      throw Runtime.makeFiberFailure(
        Cause.fail(
          new WorkflowEngineError({
            code: 'workflow_user_input_invalid',
            message: 'Invalid workflow input.',
            workflowRunId: 1,
          }),
        ),
      );
    },
  } as never);

  const response = await fastify.inject({
    method: 'POST',
    url: '/internal/dev/workflows/submit-user-input',
    payload: { workflowRunId: 1, answers: { risk: 'medium' } },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), {
    code: 'workflow_user_input_invalid',
    error: 'Invalid workflow input.',
  });
});
