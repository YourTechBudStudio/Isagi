import { Schema } from 'effect';

export const agentSessionActivityOutputSchema = Schema.Struct({
  workingAgentCount: Schema.NonNegativeInt,
});

export type AgentSessionActivityOutput = typeof agentSessionActivityOutputSchema.Type;
