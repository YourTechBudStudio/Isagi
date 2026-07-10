import { workflowInputKinds, workflowWaitKinds } from '@yourtechbudstudio/isagi-workflow-sdk';
import type {
  WorkflowCommandManifest,
  WorkflowLogLevel,
  WorkflowQuestionOption,
  WorkflowQuestionSpec,
  WorkflowUiFeedback,
  WorkflowVariables,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Schema } from 'effect';

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
  'workflow_run_not_found',
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
  runId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  includeChildren: Schema.Boolean,
  events: Schema.Array(workflowEventSchema),
});

export const workflowRunStatusSchema = Schema.Literal(
  'ready',
  'running',
  'waiting',
  'done',
  'failed',
);

export const workflowWaitKindSchema = Schema.Literal(...workflowWaitKinds);

export const workflowBlockingWaitSchema = Schema.Struct({
  kind: workflowWaitKindSchema,
  runId: Schema.Number.pipe(Schema.int(), Schema.positive()),
});

export const workflowRunSummarySchema = Schema.Struct({
  runId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  rootRunId: Schema.Number.pipe(Schema.int(), Schema.positive()),
  parentRunId: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.positive())),
  workflowKey: Schema.String.pipe(Schema.minLength(1)),
  title: Schema.String.pipe(Schema.minLength(1)),
  status: workflowRunStatusSchema,
  paused: Schema.Boolean,
  waitKind: Schema.NullOr(workflowWaitKindSchema),
  blockingWait: Schema.NullOr(workflowBlockingWaitSchema),
  worktreeId: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.positive())),
  surfaceId: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.positive())),
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
const booleanStringSchema = Schema.Union(Schema.Boolean, Schema.Literal('true', 'false'));
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

export const workflowLoadFailureReasonSchema = Schema.Literal(
  'missing_build',
  'invalid_manifest',
  'unsupported_manifest',
  'unsupported_contract',
  'invalid_package',
  'stale_source',
  'artifact_tampered',
  'artifact_load_failed',
  'invalid_export',
  'pinned_artifact_unavailable',
);

export const workflowDescriptorResultSchema = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    workflowKey: Schema.String.pipe(Schema.minLength(1)),
    manifest: workflowCommandManifestSchema,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    workflowKey: Schema.String.pipe(Schema.minLength(1)),
    reason: workflowLoadFailureReasonSchema,
    diagnostic: Schema.optional(Schema.String),
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

export const workflowRunRouteParamsSchema = Schema.Struct({
  runId: positiveIntegerSchema,
});

export const listWorkflowRunsQuerySchema = Schema.Struct({
  surfaceId: Schema.optional(positiveIntegerSchema),
  worktreeId: Schema.optional(positiveIntegerSchema),
  status: Schema.optional(workflowRunStatusSchema),
  rootOnly: Schema.optional(booleanStringSchema),
});

export const workflowEventsQuerySchema = Schema.Struct({
  includeChildren: Schema.optional(booleanStringSchema),
});

export const advanceWorkflowInputSchema = Schema.Struct({
  answers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

export const listWorkflowRunsOutputSchema = Schema.Struct({
  runs: Schema.Array(workflowRunSummarySchema),
});

export const getWorkflowRunOutputSchema = Schema.Struct({
  run: workflowRunSummarySchema,
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
export type WorkflowRunStatus = typeof workflowRunStatusSchema.Type;
export type WorkflowBlockingWait = typeof workflowBlockingWaitSchema.Type;
export type WorkflowRunSummary = typeof workflowRunSummarySchema.Type;
export type WorkflowStartContext = typeof workflowStartContextSchema.Type;
export type WorkflowLoadFailureReason = typeof workflowLoadFailureReasonSchema.Type;
export type WorkflowDescriptorResult = typeof workflowDescriptorResultSchema.Type;
export type ListWorkflowDescriptorsInput = typeof listWorkflowDescriptorsInputSchema.Type;
export type ListWorkflowDescriptorsOutput = typeof listWorkflowDescriptorsOutputSchema.Type;
export type StartWorkflowInput = typeof startWorkflowInputSchema.Type;
export type StartWorkflowOutput = typeof startWorkflowOutputSchema.Type;
export type WorkflowRunRouteParams = typeof workflowRunRouteParamsSchema.Type;
export type ListWorkflowRunsQuery = typeof listWorkflowRunsQuerySchema.Type;
export type WorkflowEventsQuery = typeof workflowEventsQuerySchema.Type;
export type AdvanceWorkflowInput = typeof advanceWorkflowInputSchema.Type;
export type ListWorkflowRunsOutput = typeof listWorkflowRunsOutputSchema.Type;
export type GetWorkflowRunOutput = typeof getWorkflowRunOutputSchema.Type;
export type WorkflowRunControlOutput = typeof workflowRunControlOutputSchema.Type;
