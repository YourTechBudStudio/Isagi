import { Schema } from 'effect';

export const agentSessionActivityOutputSchema = Schema.Struct({
  workingAgentCount: Schema.Natural,
});

export const agentSessionInteractionModeSchema = Schema.Literals(['terminal', 'fluidcast']);

export const setAgentSessionInteractionModeInputSchema = Schema.Struct({
  mode: agentSessionInteractionModeSchema,
});

/** The agent's controller after the switch; `fluidcastSessionId` addresses the session's routes. */
export const setAgentSessionInteractionModeOutputSchema = Schema.Struct({
  mode: agentSessionInteractionModeSchema,
  fluidcastSessionId: Schema.NullOr(Schema.String),
});

export type AgentSessionActivityOutput = typeof agentSessionActivityOutputSchema.Type;
export type AgentSessionInteractionMode = typeof agentSessionInteractionModeSchema.Type;
export type SetAgentSessionInteractionModeInput =
  typeof setAgentSessionInteractionModeInputSchema.Type;
export type SetAgentSessionInteractionModeOutput =
  typeof setAgentSessionInteractionModeOutputSchema.Type;
