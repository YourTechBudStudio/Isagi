import { Schema } from 'effect';

import { workflowInputKinds } from '@isagi/workflow-sdk';
import type {
  WorkflowCommandManifest,
  WorkflowLogLevel,
  WorkflowQuestionOption,
  WorkflowQuestionSpec,
  WorkflowUiFeedback,
  WorkflowVariables,
} from '@isagi/workflow-sdk';

export const workflowInputKindSchema = Schema.Literal(...workflowInputKinds);

export const workflowQuestionOptionSchema: Schema.Schema<WorkflowQuestionOption> = Schema.Struct({
  value: Schema.String,
  label: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
});

export const workflowQuestionSpecSchema: Schema.Schema<WorkflowQuestionSpec> = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('text'),
    key: Schema.String,
    label: Schema.String,
    placeholder: Schema.optional(Schema.String),
    default: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('select'),
    key: Schema.String,
    label: Schema.String,
    options: Schema.Array(workflowQuestionOptionSchema),
    default: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('multi-select'),
    key: Schema.String,
    label: Schema.String,
    options: Schema.Array(workflowQuestionOptionSchema),
    default: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal('confirm'),
    key: Schema.String,
    label: Schema.String,
    default: Schema.optional(Schema.Boolean),
  }),
);

export const workflowCommandManifestSchema: Schema.Schema<WorkflowCommandManifest> = Schema.Struct({
  title: Schema.String.pipe(Schema.minLength(1)),
  description: Schema.optional(Schema.String),
  inputs: Schema.optional(Schema.Array(workflowQuestionSpecSchema)),
});

export const workflowUiFeedbackSchema: Schema.Schema<WorkflowUiFeedback> = Schema.Struct({
  kind: Schema.optional(Schema.Literal('info', 'warning', 'error')),
  phase: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

export const workflowLogLevelSchema: Schema.Schema<WorkflowLogLevel> = Schema.Literal(
  'debug',
  'info',
  'warning',
  'error',
);

export const workflowLifecycleEventSchema = Schema.Literal(
  'started',
  'suspended',
  'resumed',
  'done',
  'failed',
);

const workflowEventBaseSchema = Schema.Struct({
  ts: Schema.String,
  runId: Schema.Number.pipe(Schema.int(), Schema.positive()),
});

export const workflowLogEventSchema = Schema.extend(
  workflowEventBaseSchema,
  Schema.Struct({
    type: Schema.Literal('log'),
    level: workflowLogLevelSchema,
    message: Schema.String,
  }),
);

export const workflowUiFeedbackEventSchema = Schema.extend(
  workflowEventBaseSchema,
  Schema.extend(Schema.Struct({ type: Schema.Literal('ui_feedback') }), workflowUiFeedbackSchema),
);

export const workflowLifecycleEventEnvelopeSchema = Schema.extend(
  workflowEventBaseSchema,
  Schema.Struct({
    type: Schema.Literal('lifecycle'),
    event: workflowLifecycleEventSchema,
  }),
);

export const workflowEventSchema = Schema.Union(
  workflowLogEventSchema,
  workflowUiFeedbackEventSchema,
  workflowLifecycleEventEnvelopeSchema,
);

export const workflowEventsRequestedMessageSchema = Schema.Struct({
  type: Schema.Literal('workflow_events_requested'),
});

export const workflowEventsSnapshotMessageSchema = Schema.Struct({
  type: Schema.Literal('workflow_events_snapshot'),
  events: Schema.Array(workflowEventSchema),
});

export const workflowEventAppendedMessageSchema = Schema.Struct({
  type: Schema.Literal('workflow_event_appended'),
  event: workflowEventSchema,
});

export const workflowEventsStreamErrorCodeSchema = Schema.Literal(
  'invalid_message',
  'workflow_events_unavailable',
  'workflow_surface_not_found',
  'unknown',
);

export const workflowEventsStreamErrorMessageSchema = Schema.Struct({
  type: Schema.Literal('error'),
  code: workflowEventsStreamErrorCodeSchema,
  message: Schema.optional(Schema.String),
});

export const workflowEventsStreamInputMessageSchema = workflowEventsRequestedMessageSchema;

export const workflowEventsStreamOutputMessageSchema = Schema.Union(
  workflowEventsSnapshotMessageSchema,
  workflowEventAppendedMessageSchema,
  workflowEventsStreamErrorMessageSchema,
);

export const workflowEventsReplayOutputSchema = Schema.Struct({
  surfaceId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  events: Schema.Array(workflowEventSchema),
});

export const workflowSurfaceStatusSchema = Schema.Literal(
  'driving',
  'waiting_user',
  'paused',
  'failed',
  'done',
);

export const workflowSurfaceSummarySchema = Schema.Struct({
  surfaceId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  rootRunId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  status: workflowSurfaceStatusSchema,
  title: Schema.String.pipe(Schema.minLength(1)),
  uiFeedback: Schema.optional(workflowUiFeedbackSchema),
  prompt: Schema.optional(
    Schema.Struct({
      runId: Schema.Number.pipe(Schema.int(), Schema.positive()),
      questions: Schema.Array(workflowQuestionSpecSchema),
    }),
  ),
  error: Schema.optional(Schema.String),
});

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());
const workflowVariablesSchema: Schema.Schema<WorkflowVariables> = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

export const workflowStartContextSchema = Schema.Struct({
  worktreeId: positiveIntegerSchema,
  surfaceId: positiveIntegerSchema,
  paneId: Schema.optional(Schema.NullOr(positiveIntegerSchema)),
  agentSessionId: Schema.optional(Schema.NullOr(positiveIntegerSchema)),
});

export const workflowDescriptorResultSchema = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    workflowKey: Schema.String.pipe(Schema.minLength(1)),
    manifest: workflowCommandManifestSchema,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    workflowKey: Schema.String.pipe(Schema.minLength(1)),
    message: Schema.String,
  }),
);

export const listWorkflowDescriptorsInputSchema = Schema.Struct({
  context: workflowStartContextSchema,
});

export const listWorkflowDescriptorsOutputSchema = Schema.Struct({
  workflows: Schema.Array(workflowDescriptorResultSchema),
});

export const startWorkflowInputSchema = Schema.Struct({
  workflowKey: Schema.String.pipe(Schema.minLength(1)),
  variables: Schema.optional(workflowVariablesSchema),
  context: workflowStartContextSchema,
});

export const startWorkflowOutputSchema = Schema.Struct({
  workflowRunId: positiveIntegerSchema,
  workflowKey: Schema.String.pipe(Schema.minLength(1)),
});

export const workflowSurfaceRouteParamsSchema = Schema.Struct({
  surfaceId: positiveIntegerSchema,
});

export const workflowRunRouteParamsSchema = Schema.Struct({
  runId: positiveIntegerSchema,
});

export const setWorkflowPausedInputSchema = Schema.Struct({
  paused: Schema.Boolean,
});

export const advanceWorkflowInputSchema = Schema.Struct({
  answers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

export const workflowSurfaceControlOutputSchema = Schema.Struct({
  surfaceId: positiveIntegerSchema,
});

export const workflowRunControlOutputSchema = Schema.Struct({
  runId: positiveIntegerSchema,
  status: Schema.Literal('waiting', 'ready', 'running', 'done', 'failed'),
});

export type WorkflowInputKind = typeof workflowInputKindSchema.Type;
export type WorkflowCommandManifestDto = typeof workflowCommandManifestSchema.Type;
export type WorkflowQuestionOptionDto = typeof workflowQuestionOptionSchema.Type;
export type WorkflowQuestionSpecDto = typeof workflowQuestionSpecSchema.Type;
export type WorkflowUiFeedbackDto = typeof workflowUiFeedbackSchema.Type;
export type WorkflowLogLevelDto = typeof workflowLogLevelSchema.Type;
export type WorkflowLifecycleEvent = typeof workflowLifecycleEventSchema.Type;
export type WorkflowEvent = typeof workflowEventSchema.Type;
export type WorkflowEventsStreamInputMessage = typeof workflowEventsStreamInputMessageSchema.Type;
export type WorkflowEventsStreamOutputMessage = typeof workflowEventsStreamOutputMessageSchema.Type;
export type WorkflowEventsStreamErrorCode = typeof workflowEventsStreamErrorCodeSchema.Type;
export type WorkflowEventsReplayOutput = typeof workflowEventsReplayOutputSchema.Type;
export type WorkflowSurfaceStatus = typeof workflowSurfaceStatusSchema.Type;
export type WorkflowSurfaceSummary = typeof workflowSurfaceSummarySchema.Type;
export type WorkflowStartContext = typeof workflowStartContextSchema.Type;
export type WorkflowDescriptorResult = typeof workflowDescriptorResultSchema.Type;
export type ListWorkflowDescriptorsInput = typeof listWorkflowDescriptorsInputSchema.Type;
export type ListWorkflowDescriptorsOutput = typeof listWorkflowDescriptorsOutputSchema.Type;
export type StartWorkflowInput = typeof startWorkflowInputSchema.Type;
export type StartWorkflowOutput = typeof startWorkflowOutputSchema.Type;
export type WorkflowSurfaceRouteParams = typeof workflowSurfaceRouteParamsSchema.Type;
export type WorkflowRunRouteParams = typeof workflowRunRouteParamsSchema.Type;
export type SetWorkflowPausedInput = typeof setWorkflowPausedInputSchema.Type;
export type AdvanceWorkflowInput = typeof advanceWorkflowInputSchema.Type;
export type WorkflowSurfaceControlOutput = typeof workflowSurfaceControlOutputSchema.Type;
export type WorkflowRunControlOutput = typeof workflowRunControlOutputSchema.Type;
