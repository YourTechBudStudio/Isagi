import { Schema } from 'effect';

import { commandStatusSchema } from '../commands/types.js';
import {
  agentSessionStatusReasonSchema,
  sessionDiagnosticCodeSchema,
  sessionStatusSchema,
  terminalSessionStatusReasonSchema,
} from '../surfaces/types.js';
import { workflowRunSummarySchema } from '../workflows/types.js';
import { durableSessionIdentitySchema } from '../workspace/types.js';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const attentionStateSchema = Schema.Literal('idle', 'working', 'waiting', 'error');
export const terminalAttentionStateSchema = Schema.Literal('idle', 'working', 'error');

export const agentAttentionSourceIdentitySchema = Schema.Struct({
  kind: Schema.Literal('agent_session'),
  id: positiveIntegerSchema,
});

export const terminalAttentionSourceIdentitySchema = Schema.Struct({
  kind: Schema.Literal('terminal_session'),
  id: positiveIntegerSchema,
});

export const attentionSourceIdentitySchema = Schema.Union(
  agentAttentionSourceIdentitySchema,
  terminalAttentionSourceIdentitySchema,
);

const attentionSourceBaseFields = {
  worktreeId: positiveIntegerSchema,
  surfaceId: positiveIntegerSchema,
  paneId: positiveIntegerSchema,
} as const;

export const attentionSourceSchema = Schema.Union(
  Schema.Struct({
    ...attentionSourceBaseFields,
    source: agentAttentionSourceIdentitySchema,
    attention: attentionStateSchema,
  }),
  Schema.Struct({
    ...attentionSourceBaseFields,
    source: terminalAttentionSourceIdentitySchema,
    attention: terminalAttentionStateSchema,
  }),
);

export const runtimeEventTypeSchema = Schema.Literal(
  'agent_session_changed',
  'terminal_session_changed',
  'command_changed',
  'surface_changed',
  'attention_snapshot',
  'attention_source_changed',
  'attention_source_removed',
  'workflow_run_snapshot',
  'workflow_run_changed',
  'workflow_run_cleared',
  'durable_session_deleted',
);

export const runtimeEventInputTypeSchema = Schema.Literal(
  'attention_snapshot_requested',
  'workflow_run_snapshot_requested',
);

export const runtimeEventBaseSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: runtimeEventTypeSchema,
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
});

export const runtimeEventInputMessageSchema = Schema.Struct({
  type: runtimeEventInputTypeSchema,
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

export const commandChangedEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('command_changed'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Struct({
    worktreeId: positiveIntegerSchema,
    commandName: Schema.String.pipe(Schema.minLength(1)),
    // The command's status after the change, so clients can flip the command's
    // attention dot immediately instead of waiting on a catalog refetch.
    status: commandStatusSchema,
  }),
});

const surfaceChangedBasePayloadFields = {
  worktreeId: positiveIntegerSchema,
  surfaceId: positiveIntegerSchema,
} as const;

export const surfaceChangedEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('surface_changed'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Union(
    Schema.Struct({
      ...surfaceChangedBasePayloadFields,
      change: Schema.Literal('created', 'renamed', 'layout_changed', 'session_changed'),
    }),
    Schema.Struct({
      ...surfaceChangedBasePayloadFields,
      change: Schema.Literal('pane_deleted', 'deleted'),
      deletedPaneIds: Schema.Array(positiveIntegerSchema),
    }),
  ),
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

export const durableSessionDeletedEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('durable_session_deleted'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: durableSessionIdentitySchema,
});

export const workflowRunSnapshotEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('workflow_run_snapshot'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Struct({
    summaries: Schema.Array(workflowRunSummarySchema),
  }),
});

export const workflowRunChangedEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('workflow_run_changed'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: workflowRunSummarySchema,
});

export const workflowRunClearedEventSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  type: Schema.Literal('workflow_run_cleared'),
  occurredAt: Schema.String.pipe(Schema.minLength(1)),
  payload: Schema.Struct({
    runId: positiveIntegerSchema,
    rootRunId: positiveIntegerSchema,
    surfaceId: Schema.NullOr(positiveIntegerSchema),
  }),
});

export const runtimeEventSchema = Schema.Union(
  agentSessionChangedEventSchema,
  terminalSessionChangedEventSchema,
  commandChangedEventSchema,
  surfaceChangedEventSchema,
  attentionSnapshotEventSchema,
  attentionSourceChangedEventSchema,
  attentionSourceRemovedEventSchema,
  workflowRunSnapshotEventSchema,
  workflowRunChangedEventSchema,
  workflowRunClearedEventSchema,
  durableSessionDeletedEventSchema,
);

export type AttentionState = Schema.Schema.Type<typeof attentionStateSchema>;
export type TerminalAttentionState = Schema.Schema.Type<typeof terminalAttentionStateSchema>;
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
export type CommandChangedEvent = Schema.Schema.Type<typeof commandChangedEventSchema>;
export type SurfaceChangedEvent = Schema.Schema.Type<typeof surfaceChangedEventSchema>;
export type AttentionSnapshotEvent = Schema.Schema.Type<typeof attentionSnapshotEventSchema>;
export type AttentionSourceChangedEvent = Schema.Schema.Type<
  typeof attentionSourceChangedEventSchema
>;
export type AttentionSourceRemovedEvent = Schema.Schema.Type<
  typeof attentionSourceRemovedEventSchema
>;
export type WorkflowRunSnapshotEvent = Schema.Schema.Type<typeof workflowRunSnapshotEventSchema>;
export type WorkflowRunChangedEvent = Schema.Schema.Type<typeof workflowRunChangedEventSchema>;
export type WorkflowRunClearedEvent = Schema.Schema.Type<typeof workflowRunClearedEventSchema>;
export type RuntimeEvent = Schema.Schema.Type<typeof runtimeEventSchema>;
export type DurableSessionDeletedEvent = Schema.Schema.Type<
  typeof durableSessionDeletedEventSchema
>;
