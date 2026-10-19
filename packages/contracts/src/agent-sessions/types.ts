import { Schema } from 'effect';

import { nonNegativeInteger } from '../scalars.js';

export const agentSessionActivityOutputSchema = Schema.Struct({
  workingAgentCount: Schema.Natural,
});

export const agentSessionInteractionModeSchema = Schema.Literals(['terminal', 'fluidcast']);

export const fluidcastSessionUnreadableReasonSchema = Schema.Literals([
  'SessionNotFound',
  'SessionUnreadable',
]);

export const fluidcastStartFailedReasonSchema = Schema.Literals([
  'executable_not_found',
  'instrumentation_failed',
  'session_build_failed',
]);

/** Why a switch to Fluidcast that had begun cleanup did not end with a running Fluidcast session. */
export const fluidcastHandoffFailureSchema = Schema.Union([
  Schema.Struct({ code: Schema.Literal('terminal_stop_failed'), diagnostic: Schema.String }),
  Schema.Struct({
    code: Schema.Literal('fluidcast_session_unreadable'),
    reason: fluidcastSessionUnreadableReasonSchema,
  }),
  Schema.Struct({
    code: Schema.Literal('fluidcast_start_failed'),
    reason: fluidcastStartFailedReasonSchema,
  }),
  Schema.Struct({
    code: Schema.Literal('fluidcast_preparation_failed'),
    diagnostic: Schema.String,
  }),
]);

/**
 * The controller a switch request was made against, as the client's projection showed it. A
 * switch whose origin no longer names the agent's controller is refused with
 * `agent_interaction_changed`.
 */
export const agentSessionInteractionOriginSchema = Schema.Struct({
  generation: nonNegativeInteger,
  fluidcastSessionId: Schema.NullOr(Schema.String),
  processIncarnation: Schema.NullOr(Schema.String),
});

export const setAgentSessionInteractionModeInputSchema = Schema.Struct({
  mode: agentSessionInteractionModeSchema,
  from: agentSessionInteractionOriginSchema,
});

/** The agent's controller after the switch; `fluidcastSessionId` addresses the session's routes. */
export const setAgentSessionInteractionModeOutputSchema = Schema.Struct({
  mode: agentSessionInteractionModeSchema,
  fluidcastSessionId: Schema.NullOr(Schema.String),
});

export type AgentSessionActivityOutput = typeof agentSessionActivityOutputSchema.Type;
export type AgentSessionInteractionMode = typeof agentSessionInteractionModeSchema.Type;
export type FluidcastHandoffFailure = typeof fluidcastHandoffFailureSchema.Type;
export type AgentSessionInteractionOrigin = typeof agentSessionInteractionOriginSchema.Type;
export type SetAgentSessionInteractionModeInput =
  typeof setAgentSessionInteractionModeInputSchema.Type;
export type SetAgentSessionInteractionModeOutput =
  typeof setAgentSessionInteractionModeOutputSchema.Type;
