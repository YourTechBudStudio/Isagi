import { Schema } from 'effect';

import { commandStatusSchema } from '../commands/types.js';
import { sessionStatusSchema } from '../processes/types.js';
import { positiveInteger } from '../scalars.js';
import {
  agentSessionStatusReasonSchema,
  sessionDiagnosticCodeSchema,
  terminalSessionStatusReasonSchema,
} from '../surfaces/types.js';
import { workflowEventSchema, workflowRunSummarySchema } from '../workflows/types.js';
import { durableSessionIdentitySchema } from '../workspace/types.js';

export const attentionStateSchema = Schema.Literals(['idle', 'working', 'waiting', 'error']);
export const terminalAttentionStateSchema = Schema.Literals(['idle', 'working', 'error']);

export const agentAttentionSourceIdentitySchema = Schema.Struct({
  kind: Schema.Literal('agent_session'),
  id: positiveInteger,
});

export const terminalAttentionSourceIdentitySchema = Schema.Struct({
  kind: Schema.Literal('terminal_session'),
  id: positiveInteger,
});

export const attentionSourceIdentitySchema = Schema.Union([
  agentAttentionSourceIdentitySchema,
  terminalAttentionSourceIdentitySchema,
]);

const attentionSourceBaseFields = {
  worktreeId: positiveInteger,
  surfaceId: positiveInteger,
  paneId: positiveInteger,
} as const;

export const attentionSourceSchema = Schema.Union([
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
]);

export const runtimeEventTypeSchema = Schema.Literals([
  'agent_session_changed',
  'terminal_session_changed',
  'command_changed',
  'surface_changed',
  'attention_snapshot',
  'attention_source_changed',
  'attention_source_removed',
  'workflow_run_snapshot',
  'workflow_run_changed',
  'workflow_run_event',
  'durable_session_deleted',
  'editor_context_changed',
]);

export const runtimeEventInputTypeSchema = Schema.Literals([
  'attention_snapshot_requested',
  'workflow_run_snapshot_requested',
]);

export const runtimeEventBaseSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: runtimeEventTypeSchema,
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
});

export const runtimeEventInputMessageSchema = Schema.Struct({
  type: runtimeEventInputTypeSchema,
});

const changedSessionProjectionSchema = Schema.Struct({
  worktreeId: positiveInteger,
  surfaceId: positiveInteger,
  paneId: positiveInteger,
  status: sessionStatusSchema,
  diagnosticCode: Schema.NullOr(sessionDiagnosticCodeSchema),
});

export const agentSessionChangedEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('agent_session_changed'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: Schema.Struct({
    agentSessionId: positiveInteger,
    statusReason: Schema.NullOr(agentSessionStatusReasonSchema),
    ...changedSessionProjectionSchema.fields,
  }),
});

export const terminalSessionChangedEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('terminal_session_changed'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: Schema.Struct({
    terminalSessionId: positiveInteger,
    statusReason: Schema.NullOr(terminalSessionStatusReasonSchema),
    ...changedSessionProjectionSchema.fields,
  }),
});

export const commandChangedEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('command_changed'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: Schema.Struct({
    worktreeId: positiveInteger,
    commandName: Schema.String.check(Schema.isMinLength(1)),
    // The command's status after the change, so clients can flip the command's
    // attention dot immediately instead of waiting on a catalog refetch.
    status: commandStatusSchema,
  }),
});

const surfaceChangedBasePayloadFields = {
  worktreeId: positiveInteger,
  surfaceId: positiveInteger,
} as const;

export const surfaceChangedEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('surface_changed'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: Schema.Union([
    Schema.Struct({
      ...surfaceChangedBasePayloadFields,
      change: Schema.Literals(['created', 'renamed', 'layout_changed', 'session_changed']),
    }),
    Schema.Struct({
      ...surfaceChangedBasePayloadFields,
      change: Schema.Literals(['pane_deleted', 'deleted']),
      deletedPaneIds: Schema.Array(positiveInteger),
    }),
  ]),
});

export const attentionSnapshotEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('attention_snapshot'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: Schema.Struct({
    sources: Schema.Array(attentionSourceSchema),
  }),
});

export const attentionSourceChangedEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('attention_source_changed'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: attentionSourceSchema,
});

export const attentionSourceRemovedEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('attention_source_removed'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: Schema.Struct({
    source: attentionSourceIdentitySchema,
  }),
});

export const durableSessionDeletedEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('durable_session_deleted'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: durableSessionIdentitySchema,
});

/**
 * Identity and placement only. The event says "this editor changed, and here is
 * where it lives"; the client re-reads the authoritative projection out of
 * surface detail, exactly as it already does for the session-changed events,
 * whose status it likewise ignores. A status-bearing payload would force the
 * projection layer to depend on the editor service's in-memory state, or add a
 * second publisher, to carry fields no consumer reads.
 */
export const editorContextChangedEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('editor_context_changed'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: Schema.Struct({
    editorContextId: positiveInteger,
    worktreeId: positiveInteger,
    surfaceId: positiveInteger,
    paneId: positiveInteger,
  }),
});

export const workflowRunSnapshotEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('workflow_run_snapshot'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: Schema.Struct({
    summaries: Schema.Array(workflowRunSummarySchema),
  }),
});

/** A run's summary changed, including when a dismissed run detached from its surface. */
export const workflowRunChangedEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('workflow_run_changed'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: workflowRunSummarySchema,
});

/**
 * One row appended to a run's event log, pushed as it is written. A client appends it to the trace
 * and refetches the run or execution it names. The event list route is the source of truth for
 * anything missed while disconnected.
 */
export const workflowRunEventSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  type: Schema.Literal('workflow_run_event'),
  occurredAt: Schema.String.check(Schema.isMinLength(1)),
  payload: workflowEventSchema,
});

export const runtimeEventSchema = Schema.Union([
  agentSessionChangedEventSchema,
  terminalSessionChangedEventSchema,
  commandChangedEventSchema,
  surfaceChangedEventSchema,
  attentionSnapshotEventSchema,
  attentionSourceChangedEventSchema,
  attentionSourceRemovedEventSchema,
  workflowRunSnapshotEventSchema,
  workflowRunChangedEventSchema,
  workflowRunEventSchema,
  durableSessionDeletedEventSchema,
  editorContextChangedEventSchema,
]);

export type AttentionState = typeof attentionStateSchema.Type;
export type TerminalAttentionState = typeof terminalAttentionStateSchema.Type;
export type AttentionSourceIdentity = typeof attentionSourceIdentitySchema.Type;
export type AttentionSource = typeof attentionSourceSchema.Type;
export type RuntimeEventInputType = typeof runtimeEventInputTypeSchema.Type;
export type RuntimeEventInputMessage = typeof runtimeEventInputMessageSchema.Type;
export type RuntimeEventType = typeof runtimeEventTypeSchema.Type;
export type RuntimeEventBase = typeof runtimeEventBaseSchema.Type;
export type AgentSessionChangedEvent = typeof agentSessionChangedEventSchema.Type;
export type TerminalSessionChangedEvent = typeof terminalSessionChangedEventSchema.Type;
export type CommandChangedEvent = typeof commandChangedEventSchema.Type;
export type SurfaceChangedEvent = typeof surfaceChangedEventSchema.Type;
export type AttentionSnapshotEvent = typeof attentionSnapshotEventSchema.Type;
export type AttentionSourceChangedEvent = typeof attentionSourceChangedEventSchema.Type;
export type AttentionSourceRemovedEvent = typeof attentionSourceRemovedEventSchema.Type;
export type WorkflowRunSnapshotEvent = typeof workflowRunSnapshotEventSchema.Type;
export type WorkflowRunChangedEvent = typeof workflowRunChangedEventSchema.Type;
export type WorkflowRunEvent = typeof workflowRunEventSchema.Type;
export type RuntimeEvent = typeof runtimeEventSchema.Type;
export type DurableSessionDeletedEvent = typeof durableSessionDeletedEventSchema.Type;
export type EditorContextChangedEvent = typeof editorContextChangedEventSchema.Type;
