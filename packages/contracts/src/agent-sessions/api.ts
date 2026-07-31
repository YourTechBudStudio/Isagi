import { Schema } from 'effect';

import { apiInfrastructureErrorSchema } from '../api/responses.js';
import type { ApiEndpoint } from '../api/types.js';
import { agentSessionActivityOutputSchema } from './types.js';

export const agentSessionActivityUnavailableErrorSchema = Schema.Struct({
  code: Schema.Literal('agent_session_activity_unavailable'),
  status: Schema.Literal(500),
  message: Schema.String,
  requestId: Schema.String,
});

export const agentSessionActivityApiErrorSchema = Schema.Union(
  agentSessionActivityUnavailableErrorSchema,
  apiInfrastructureErrorSchema,
);

export const agentSessionsEndpoints = {
  activity: {
    id: 'agent-sessions.activity',
    method: 'GET',
    path: '/agent-sessions/activity',
    output: agentSessionActivityOutputSchema,
    errors: agentSessionActivityApiErrorSchema,
  },
} as const satisfies {
  readonly activity: ApiEndpoint<
    undefined,
    typeof agentSessionActivityOutputSchema,
    typeof agentSessionActivityApiErrorSchema
  >;
};
