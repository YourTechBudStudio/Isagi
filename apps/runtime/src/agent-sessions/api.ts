import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { registerApiEndpoint } from '../lib/api/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { AgentSessionAttentionProjection } from './attention-projection.service.js';

export function registerAgentSessionsApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  registerApiEndpoint(fastify, apiEndpoints.agentSessions.activity, {
    handle: () =>
      Effect.gen(function* () {
        const projection = yield* AgentSessionAttentionProjection;
        return { workingAgentCount: yield* projection.workingAgentCount };
      }),
    mapError: (error, context) => {
      console.error('[runtime] Agent session activity read failed', {
        endpointId: context.endpointId,
        requestId: context.requestId,
        cause: error,
      });
      return {
        code: 'agent_session_activity_unavailable',
        status: 500,
        message: 'Agent session activity could not be read.',
        requestId: context.requestId,
      };
    },
    run: (effect, options) => runtime.runPromise(effect, options),
  });
}
