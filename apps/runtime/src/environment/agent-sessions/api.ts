import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { registerLegacyApiEndpoint, type RouteRuntime } from '../../platform/http/index.js';
import { AgentSessionAttentionProjection } from './attention.js';

export function registerAgentSessionsApi(
  fastify: FastifyInstance,
  runtime: RouteRuntime<AgentSessionAttentionProjection>,
) {
  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.agentSessions.activity, {
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
  });
}
