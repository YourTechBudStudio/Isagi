import { Schema } from 'effect';

import {
  runtimeDatabaseFailedErrorSchema,
  sessionLaunchRejectedErrorSchema,
} from '../api/errors.js';
import { apiInfrastructureErrorSchema } from '../api/responses.js';
import type { ApiEndpoint } from '../api/types.js';
import { agentSessionRouteParamsSchema } from '../surfaces/types.js';
import {
  agentSessionActivityOutputSchema,
  fluidcastSessionUnreadableReasonSchema,
  fluidcastStartFailedReasonSchema,
  setAgentSessionInteractionModeInputSchema,
  setAgentSessionInteractionModeOutputSchema,
} from './types.js';

const errorEnvelopeFields = { message: Schema.String, requestId: Schema.String } as const;

export const agentSessionActivityUnavailableErrorSchema = Schema.Struct({
  code: Schema.Literal('agent_session_activity_unavailable'),
  status: Schema.Literal(500),
  message: Schema.String,
  requestId: Schema.String,
});

export const agentSessionActivityApiErrorSchema = Schema.Union([
  agentSessionActivityUnavailableErrorSchema,
  apiInfrastructureErrorSchema,
]);

/** The agent does not exist, or no pane holds it any more. */
export const agentSessionNotFoundErrorSchema = Schema.Struct({
  code: Schema.Literal('agent_session_not_found'),
  status: Schema.Literal(404),
  ...errorEnvelopeFields,
});

/** The agent's worktree or project is being deleted. */
export const agentSessionDeletingErrorSchema = Schema.Struct({
  code: Schema.Literal('agent_session_deleting'),
  status: Schema.Literal(409),
  ...errorEnvelopeFields,
});

/** The agent's harness metadata cannot identify its native session, so it is not replaced. */
export const agentSessionMetadataUnusableErrorSchema = Schema.Struct({
  code: Schema.Literal('agent_session_metadata_unusable'),
  status: Schema.Literal(409),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: Schema.Literals(['harness_metadata_missing', 'harness_metadata_invalid']),
  }),
});

/** Fluidcast is off or misconfigured, or the agent's harness has no SDK worker. */
export const fluidcastUnavailableErrorSchema = Schema.Struct({
  code: Schema.Literal('fluidcast_unavailable'),
  status: Schema.Literal(409),
  ...errorEnvelopeFields,
  data: Schema.Struct({
    reason: Schema.Literals(['disabled', 'invalid_config', 'harness_unsupported']),
  }),
});

/** The agent's native session could not be attached; the terminal was stopped and nothing replaced it. */
export const fluidcastSessionUnreadableErrorSchema = Schema.Struct({
  code: Schema.Literal('fluidcast_session_unreadable'),
  status: Schema.Literal(422),
  ...errorEnvelopeFields,
  data: Schema.Struct({ reason: fluidcastSessionUnreadableReasonSchema }),
});

/** The Fluidcast session could not be built; the terminal was stopped and nothing replaced it. */
export const fluidcastStartFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('fluidcast_start_failed'),
  status: Schema.Literal(500),
  ...errorEnvelopeFields,
  data: Schema.Struct({ reason: fluidcastStartFailedReasonSchema }),
});

/** The switch's `from` no longer names the agent's controller; nothing changed. */
export const agentInteractionChangedErrorSchema = Schema.Struct({
  code: Schema.Literal('agent_interaction_changed'),
  status: Schema.Literal(409),
  ...errorEnvelopeFields,
});

/** The terminal stop reported an error, so Fluidcast was not started; the message carries the diagnostic. */
export const agentTerminalStopFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('agent_terminal_stop_failed'),
  status: Schema.Literal(500),
  ...errorEnvelopeFields,
});

export const agentInteractionModeApiErrorSchema = Schema.Union([
  apiInfrastructureErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  agentSessionNotFoundErrorSchema,
  agentSessionDeletingErrorSchema,
  agentSessionMetadataUnusableErrorSchema,
  sessionLaunchRejectedErrorSchema,
  fluidcastUnavailableErrorSchema,
  fluidcastSessionUnreadableErrorSchema,
  fluidcastStartFailedErrorSchema,
  agentInteractionChangedErrorSchema,
  agentTerminalStopFailedErrorSchema,
]);

export const agentSessionsEndpoints = {
  activity: {
    id: 'agent-sessions.activity',
    method: 'GET',
    path: '/agent-sessions/activity',
    output: agentSessionActivityOutputSchema,
    errors: agentSessionActivityApiErrorSchema,
  },
  /** Switches the agent between its terminal and a Fluidcast session; idempotent per mode. */
  setInteractionMode: {
    id: 'agent-sessions.set-interaction-mode',
    method: 'PUT',
    path: '/agent-sessions/:agentSessionId/interaction-mode',
    params: agentSessionRouteParamsSchema,
    body: setAgentSessionInteractionModeInputSchema,
    output: setAgentSessionInteractionModeOutputSchema,
    errors: agentInteractionModeApiErrorSchema,
  },
} as const satisfies {
  readonly activity: ApiEndpoint<
    undefined,
    typeof agentSessionActivityOutputSchema,
    typeof agentSessionActivityApiErrorSchema
  >;
  readonly setInteractionMode: ApiEndpoint<
    typeof setAgentSessionInteractionModeInputSchema,
    typeof setAgentSessionInteractionModeOutputSchema,
    typeof agentInteractionModeApiErrorSchema,
    typeof agentSessionRouteParamsSchema
  >;
};

export type AgentInteractionModeApiError = typeof agentInteractionModeApiErrorSchema.Type;
