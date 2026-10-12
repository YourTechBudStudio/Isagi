import { Schema } from 'effect';

export const agentSessionActivityOutputSchema = Schema.Struct({
  workingAgentCount: Schema.Natural,
});

export type AgentSessionActivityOutput = typeof agentSessionActivityOutputSchema.Type;
