import { Schema } from 'effect';

import {
  agentSessionStatusReasonSchema,
  sessionDiagnosticCodeSchema,
  sessionStatusSchema,
  terminalSessionStatusReasonSchema,
} from '../surfaces/types.js';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const runtimeEventTypeSchema = Schema.Literal(
  'agent_session_changed',
  'terminal_session_changed',
);

export const runtimeEventBaseSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: runtimeEventTypeSchema,
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
});

const changedSessionProjectionSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
  surfaceId: positiveIntegerSchema,
  paneId: positiveIntegerSchema,
  status: sessionStatusSchema,
  diagnosticCode: Schema.NullOr(sessionDiagnosticCodeSchema),
});

export const agentSessionChangedEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('agent_session_changed'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Struct({
    agentSessionId: positiveIntegerSchema,
    statusReason: Schema.NullOr(agentSessionStatusReasonSchema),
    ...changedSessionProjectionSchema.fields,
  }),
});

export const terminalSessionChangedEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('terminal_session_changed'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Struct({
    terminalSessionId: positiveIntegerSchema,
    statusReason: Schema.NullOr(terminalSessionStatusReasonSchema),
    ...changedSessionProjectionSchema.fields,
  }),
});

export const runtimeEventSchema = Schema.Union(
  agentSessionChangedEventSchema,
  terminalSessionChangedEventSchema,
);

export type RuntimeEventType = Schema.Schema.Type<typeof runtimeEventTypeSchema>;
export type RuntimeEventBase = Schema.Schema.Type<typeof runtimeEventBaseSchema>;
export type AgentSessionChangedEvent = Schema.Schema.Type<typeof agentSessionChangedEventSchema>;
export type TerminalSessionChangedEvent = Schema.Schema.Type<
  typeof terminalSessionChangedEventSchema
>;
export type RuntimeEvent = Schema.Schema.Type<typeof runtimeEventSchema>;
