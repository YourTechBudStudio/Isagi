import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { makeLogCapture } from '../../../test/test-support.js';
import { withApiServer } from '../../platform/http/testing.js';
import { DatabaseError } from '../../platform/persistence/index.js';
import { registerAgentSessionsApi } from './api.js';
import { AgentSessionAttentionProjection } from './attention.js';

function projection(workingAgentCount: Effect.Effect<number, DatabaseError>) {
  return Layer.mock(AgentSessionAttentionProjection)({
    terminalSessionAttention: () => assert.fail('terminalSessionAttention is not used'),
    workingAgentCount,
  });
}

test('agent session activity returns the schema-backed working count', () =>
  withApiServer(projection(Effect.succeed(2)), registerAgentSessionsApi, async (fastify) => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/v1/agent-sessions/activity',
    });
    const payload = response.json();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(payload.data, { workingAgentCount: 2 });
    assert.equal(typeof payload.meta.requestId, 'string');
  }));

test('agent session activity maps projection failures without leaking their cause', () => {
  const logs = makeLogCapture();
  return withApiServer(
    Layer.mergeAll(
      projection(
        Effect.fail(
          new DatabaseError({
            operation: 'working_agent_count',
            cause: new Error('secret database path /private/runtime.sqlite'),
          }),
        ),
      ),
      logs.layer,
    ),
    registerAgentSessionsApi,
    async (fastify) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/v1/agent-sessions/activity',
      });
      const payload = response.json();
      assert.equal(response.statusCode, 500);
      assert.equal(payload.error.code, 'agent_session_activity_unavailable');
      assert.equal(payload.error.message, 'Agent session activity could not be read.');
      assert.equal(JSON.stringify(payload).includes('/private/runtime.sqlite'), false);

      const failures = logs.lines.filter(
        (line) => line.message === 'Agent session activity read failed',
      );
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.level, 'Error');
      assert.equal(failures[0]?.annotations.endpointId, 'agent-sessions.activity');
      assert.match(String(failures[0]?.annotations.cause), /working_agent_count/);
      assert.equal(JSON.stringify(failures).includes('/private/runtime.sqlite'), false);
    },
  );
});
