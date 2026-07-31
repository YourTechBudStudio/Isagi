import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import { DatabaseError } from '../persistence/index.js';
import { registerAgentSessionsApi } from './api.js';
import {
  AgentSessionAttentionProjection,
  type AgentSessionAttentionProjectionService,
} from './attention-projection.service.js';

function service(workingAgentCount: Effect.Effect<number, DatabaseError>) {
  return {
    agentSessionAttention: () => Effect.succeed('idle' as const),
    terminalSessionAttention: () => 'idle' as const,
    listAttentionSources: Effect.succeed([]),
    workingAgentCount,
  } satisfies AgentSessionAttentionProjectionService;
}

test('agent session activity returns the schema-backed working count', async () => {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.succeed(AgentSessionAttentionProjection, service(Effect.succeed(2))),
  );
  try {
    registerAgentSessionsApi(fastify, runtime as never);
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/v1/agent-sessions/activity',
    });
    const payload = response.json();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(payload.data, { workingAgentCount: 2 });
    assert.equal(typeof payload.meta.requestId, 'string');
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('agent session activity maps projection failures without leaking their cause', async () => {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.succeed(
      AgentSessionAttentionProjection,
      service(
        Effect.fail(
          new DatabaseError({
            operation: 'working_agent_count',
            cause: new Error('secret database path /private/runtime.sqlite'),
          }),
        ),
      ),
    ),
  );
  const originalError = console.error;
  console.error = () => undefined;
  try {
    registerAgentSessionsApi(fastify, runtime as never);
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/v1/agent-sessions/activity',
    });
    const payload = response.json();
    assert.equal(response.statusCode, 500);
    assert.equal(payload.error.code, 'agent_session_activity_unavailable');
    assert.equal(payload.error.message, 'Agent session activity could not be read.');
    assert.equal(JSON.stringify(payload).includes('/private/runtime.sqlite'), false);
  } finally {
    console.error = originalError;
    await fastify.close();
    await runtime.dispose();
  }
});
