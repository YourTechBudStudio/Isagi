import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { describeOperationalCause } from '../../platform/diagnostics/index.js';
import { registerApiEndpoint, type RouteRuntime } from '../../platform/http/index.js';
import { AgentSessionAttentionProjection } from './attention.js';

export function registerAgentSessionsApi(
  fastify: FastifyInstance,
  runtime: RouteRuntime<AgentSessionAttentionProjection>,
) {
  registerApiEndpoint(fastify, runtime, apiEndpoints.agentSessions.activity, (request) =>
    AgentSessionAttentionProjection.use((projection) => projection.workingAgentCount).pipe(
      Effect.map((workingAgentCount) => ({ workingAgentCount })),
      // The client gets a fixed message; the runtime log names the failed operation.
      Effect.catchTag('DatabaseError', (error) =>
        Effect.logError('Agent session activity read failed').pipe(
          Effect.annotateLogs({ cause: describeOperationalCause(error) }),
          Effect.andThen(
            request.reject({
              code: 'agent_session_activity_unavailable',
              status: 500,
              message: 'Agent session activity could not be read.',
            }),
          ),
        ),
      ),
    ),
  );
}
