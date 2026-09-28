import { Schema } from 'effect';

import {
  workflowErrorSchema,
  workflowExecutionSummarySchema,
  workflowGraphInvocationSchema,
  workflowOutcomeSchema,
  workflowWaitSchema,
} from './executions.js';
import { pagedSchema, paginationQueryFields, queryTextSchema } from './pagination.js';
import {
  nonEmptyString,
  positiveInteger,
  workflowCommandManifestSchema,
  workflowInputsSchema,
  workflowNodeKindSchema,
  workflowPlacementRequestSchema,
  workflowPlacementSourceSchema,
  workflowUiFeedbackSchema,
  workflowUserInputAnswersSchema,
} from './primitives.js';
import { workflowStructureDiagnosticSchema } from './structure.js';

/**
 * Runs: one launch of a workflow.
 *
 * `waiting` means the run is parked on a wait (an agent turn, a headless job, or the user).
 * `paused` means nothing new starts until Resume. `failed` means an execution failed and Retry is
 * available.
 */
export const workflowRunStatusSchema = Schema.Literal(
  'preparing',
  'running',
  'waiting',
  'paused',
  'completed',
  'failed',
  'cancelled',
);

/** Which controls the runtime will accept right now, derived from the run's status. */
export const workflowRunControlsSchema = Schema.Struct({
  pause: Schema.Boolean,
  resume: Schema.Boolean,
  retry: Schema.Boolean,
  cancel: Schema.Boolean,
  dismiss: Schema.Boolean,
});

/**
 * Where a run was launched from. Retained as launched, so it may name a worktree, surface, pane or
 * agent session that has since been deleted.
 */
export const workflowRunOriginSchema = Schema.Struct({
  worktreeId: positiveInteger,
  worktreePath: nonEmptyString,
  surfaceId: positiveInteger,
  paneId: Schema.NullOr(positiveInteger),
  agentSessionId: Schema.NullOr(positiveInteger),
});

/**
 * The node a run is parked on or running: its deepest unfinished execution. `wait` is set while the
 * run is waiting; a `user_continue` or `user_input` wait is answered through `advance`.
 */
export const workflowRunCurrentSchema = Schema.Struct({
  executionId: positiveInteger,
  invocationId: positiveInteger,
  graphKey: nonEmptyString,
  nodeId: nonEmptyString,
  nodeKind: workflowNodeKindSchema,
  label: Schema.NullOr(Schema.String),
  wait: Schema.NullOr(workflowWaitSchema),
});

export const workflowRunSummarySchema = Schema.Struct({
  runId: positiveInteger,
  /** The project this run belongs to, recorded at launch and never changed. */
  projectId: positiveInteger,
  workflowKey: nonEmptyString,
  title: nonEmptyString,
  /** The verified build the run uses now. Resume and Retry move it to the latest build. */
  artifactHash: nonEmptyString,
  status: workflowRunStatusSchema,
  origin: workflowRunOriginSchema,
  /**
   * What placement was asked for, who decided it, and the commit a `create` worktree's `fromRef`
   * resolved to at launch. Preparation and its Retry create the worktree from `baseCommit`, never
   * from the ref again, so a ref that moves after launch cannot change where the run starts.
   */
  placement: Schema.Struct({
    source: workflowPlacementSourceSchema,
    request: workflowPlacementRequestSchema,
    /** Set exactly when the worktree choice is `create`. */
    baseCommit: Schema.NullOr(nonEmptyString),
  }).pipe(
    Schema.filter((placement) =>
      placement.request.worktree.kind === 'create'
        ? placement.baseCommit !== null ||
          'a create worktree placement must record the commit its ref resolved to'
        : placement.baseCommit === null ||
          `a ${placement.request.worktree.kind} worktree placement has no base commit`,
    ),
  ),
  /** Where the run executes. Null until preparation has chosen or created the worktree. */
  worktreeId: Schema.NullOr(positiveInteger),
  worktreePath: Schema.NullOr(nonEmptyString),
  setupDone: Schema.Boolean,
  /** The surface the run is attached to. Null before preparation attaches it and once dismissed. */
  surfaceId: Schema.NullOr(positiveInteger),
  current: Schema.NullOr(workflowRunCurrentSchema),
  /** The latest `ui_feedback` event's value. */
  uiFeedback: Schema.NullOr(workflowUiFeedbackSchema),
  error: Schema.NullOr(workflowErrorSchema),
  outcome: Schema.NullOr(workflowOutcomeSchema),
  controls: workflowRunControlsSchema,
  createdAt: nonEmptyString,
  updatedAt: nonEmptyString,
  endedAt: Schema.NullOr(nonEmptyString),
});

/**
 * A run with its whole tree: every graph invocation and every execution, as flat lists linked by
 * `parentExecutionId`, `invocationId` and `childInvocationId`. Both lists are in id order.
 */
export const workflowRunDetailSchema = Schema.Struct({
  run: workflowRunSummarySchema,
  inputs: workflowInputsSchema,
  invocations: Schema.Array(workflowGraphInvocationSchema),
  executions: Schema.Array(workflowExecutionSummarySchema),
});

export const workflowLaunchOriginSchema = Schema.Struct({
  worktreeId: positiveInteger,
  surfaceId: positiveInteger,
  paneId: Schema.optional(Schema.NullOr(positiveInteger)),
  agentSessionId: Schema.optional(Schema.NullOr(positiveInteger)),
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
  'invalid_structure',
  'structure_mismatch',
);

export const workflowDescriptorResultSchema = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    workflowKey: nonEmptyString,
    manifest: workflowCommandManifestSchema,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    workflowKey: nonEmptyString,
    reason: workflowLoadFailureReasonSchema,
    diagnostics: Schema.Array(workflowStructureDiagnosticSchema),
  }),
);

export const listWorkflowDescriptorsInputSchema = Schema.Struct({
  origin: workflowLaunchOriginSchema,
});

export const listWorkflowDescriptorsOutputSchema = Schema.Struct({
  workflows: Schema.Array(workflowDescriptorResultSchema),
});

export const startWorkflowInputSchema = Schema.Struct({
  workflowKey: nonEmptyString,
  inputs: Schema.optional(workflowInputsSchema),
  origin: workflowLaunchOriginSchema,
  /**
   * An explicit destination, which takes precedence over the workflow's own `environment` hook.
   * Absent means the hook decides, and absent hook means the current worktree and surface. An
   * override bypasses selection, never validation.
   */
  placement: Schema.optional(workflowPlacementRequestSchema),
});

export const startWorkflowOutputSchema = Schema.Struct({
  runId: positiveInteger,
  workflowKey: nonEmptyString,
});

export const workflowRunRouteParamsSchema = Schema.Struct({ runId: positiveInteger });

export const listWorkflowRunsQuerySchema = Schema.Struct({
  ...paginationQueryFields,
  workflowKey: Schema.optional(queryTextSchema),
  status: Schema.optional(workflowRunStatusSchema),
  projectId: Schema.optional(positiveInteger),
});

export const listWorkflowRunsOutputSchema = pagedSchema(workflowRunSummarySchema);

export const getWorkflowRunOutputSchema = workflowRunDetailSchema;

/**
 * Answers the user wait the run is parked on. The execution is named so a stale answer cannot
 * satisfy a newer wait. `answers` is required for `user_input` and refused for `user_continue`.
 */
export const advanceWorkflowInputSchema = Schema.Struct({
  executionId: positiveInteger,
  answers: Schema.optional(workflowUserInputAnswersSchema),
});

/** Every control returns the run as it stands after the control was applied. */
export const workflowRunControlOutputSchema = Schema.Struct({ run: workflowRunSummarySchema });

export type WorkflowRunStatus = typeof workflowRunStatusSchema.Type;
export type WorkflowRunControls = typeof workflowRunControlsSchema.Type;
export type WorkflowRunOrigin = typeof workflowRunOriginSchema.Type;
export type WorkflowRunCurrent = typeof workflowRunCurrentSchema.Type;
export type WorkflowRunSummary = typeof workflowRunSummarySchema.Type;
export type WorkflowRunDetail = typeof workflowRunDetailSchema.Type;
export type WorkflowLaunchOrigin = typeof workflowLaunchOriginSchema.Type;
export type WorkflowLoadFailureReason = typeof workflowLoadFailureReasonSchema.Type;
export type WorkflowDescriptorResult = typeof workflowDescriptorResultSchema.Type;
export type ListWorkflowDescriptorsInput = typeof listWorkflowDescriptorsInputSchema.Type;
export type ListWorkflowDescriptorsOutput = typeof listWorkflowDescriptorsOutputSchema.Type;
export type StartWorkflowInput = typeof startWorkflowInputSchema.Type;
export type StartWorkflowOutput = typeof startWorkflowOutputSchema.Type;
export type WorkflowRunRouteParams = typeof workflowRunRouteParamsSchema.Type;
export type ListWorkflowRunsQuery = typeof listWorkflowRunsQuerySchema.Type;
export type ListWorkflowRunsOutput = typeof listWorkflowRunsOutputSchema.Type;
export type GetWorkflowRunOutput = typeof getWorkflowRunOutputSchema.Type;
export type AdvanceWorkflowInput = typeof advanceWorkflowInputSchema.Type;
export type WorkflowRunControlOutput = typeof workflowRunControlOutputSchema.Type;
