import { Schema } from 'effect';

import {
  agentSessionStatusReasonSchema,
  sessionDiagnosticCodeSchema,
  sessionStatusSchema,
  terminalSessionStatusReasonSchema,
} from '../surfaces/types.js';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const attentionStateSchema = Schema.Literal('idle', 'working', 'waiting', 'error');

export const attentionSourceIdentitySchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('agent_session'),
    id: positiveIntegerSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('terminal_session'),
    id: positiveIntegerSchema,
  }),
);

export const attentionSourceSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
  surfaceId: positiveIntegerSchema,
  paneId: positiveIntegerSchema,
  source: attentionSourceIdentitySchema,
  attention: attentionStateSchema,
});

export const runtimeEventTypeSchema = Schema.Literal(
  'agent_session_changed',
  'terminal_session_changed',
  'attention_snapshot',
  'attention_source_changed',
  'attention_source_removed',
);

export const runtimeEventInputTypeSchema = Schema.Literal('attention_snapshot_requested');

export const runtimeEventBaseSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: runtimeEventTypeSchema,
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
});

export const runtimeEventInputMessageSchema = Schema.Struct({
  type: Schema.Literal('attention_snapshot_requested'),
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

export const attentionSnapshotEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('attention_snapshot'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Struct({
    sources: Schema.Array(attentionSourceSchema),
  }),
});

export const attentionSourceChangedEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('attention_source_changed'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: attentionSourceSchema,
});

export const attentionSourceRemovedEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('attention_source_removed'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Struct({
    source: attentionSourceIdentitySchema,
  }),
});

export const runtimeEventSchema = Schema.Union(
  agentSessionChangedEventSchema,
  terminalSessionChangedEventSchema,
  attentionSnapshotEventSchema,
  attentionSourceChangedEventSchema,
  attentionSourceRemovedEventSchema,
);

export type AttentionState = Schema.Schema.Type<typeof attentionStateSchema>;
export type AttentionSourceIdentity = Schema.Schema.Type<typeof attentionSourceIdentitySchema>;
export type AttentionSource = Schema.Schema.Type<typeof attentionSourceSchema>;
export type RuntimeEventInputType = Schema.Schema.Type<typeof runtimeEventInputTypeSchema>;
export type RuntimeEventInputMessage = Schema.Schema.Type<typeof runtimeEventInputMessageSchema>;
export type RuntimeEventType = Schema.Schema.Type<typeof runtimeEventTypeSchema>;
export type RuntimeEventBase = Schema.Schema.Type<typeof runtimeEventBaseSchema>;
export type AgentSessionChangedEvent = Schema.Schema.Type<typeof agentSessionChangedEventSchema>;
export type TerminalSessionChangedEvent = Schema.Schema.Type<
  typeof terminalSessionChangedEventSchema
>;
export type AttentionSnapshotEvent = Schema.Schema.Type<typeof attentionSnapshotEventSchema>;
export type AttentionSourceChangedEvent = Schema.Schema.Type<
  typeof attentionSourceChangedEventSchema
>;
export type AttentionSourceRemovedEvent = Schema.Schema.Type<
  typeof attentionSourceRemovedEventSchema
>;
export type RuntimeEvent = Schema.Schema.Type<typeof runtimeEventSchema>;
