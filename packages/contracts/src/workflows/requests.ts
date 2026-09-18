import { Schema } from 'effect';

import {
  workflowAttemptSchema,
  workflowExecutionSchema,
  workflowFrameSchema,
  workflowOperationSchema,
} from './executions.js';
import {
  nonEmptyString,
  nonNegativeInteger,
  positiveInteger,
  workflowCommandManifestSchema,
  workflowInputsSchema,
  workflowOperationStateSchema,
  workflowPlacementRequestSchema,
  workflowSegmentKindSchema,
  workflowUserInputAnswersSchema,
  workflowWaitIdSchema,
} from './primitives.js';
import {
  workflowRunSummarySchema,
  workflowRunTransitionDeltaSchema,
  workflowRunStatusSchema,
} from './runs.js';
import {
  workflowStructureDescriptorSchema,
  workflowStructureDiagnosticSchema,
  workflowVersionSchema,
} from './structure.js';

/** Route inputs, queries and outputs. */

const booleanStringSchema = Schema.Union(Schema.Boolean, Schema.Literal('true', 'false'));

/** Opaque and bound to its run, filters and snapshot boundary. Clients never construct one. */
const cursorSchema = nonEmptyString;

/**
 * Every list route pages the same way: default 100, hard maximum 500. The maximum is part of the
 * schema rather than prose, so an over-large request is rejected at the boundary instead of being
 * silently clamped or honoured.
 */
export const workflowListPageLimitMaximum = 500;

const paginationQuerySchema = Schema.Struct({
  limit: Schema.optional(
    Schema.Number.pipe(
      Schema.int(),
      Schema.positive(),
      Schema.lessThanOrEqualTo(workflowListPageLimitMaximum),
    ),
  ),
  cursor: Schema.optional(cursorSchema),
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
  'pinned_artifact_unavailable',
  'invalid_structure',
  'structure_mismatch',
  'unsupported_capability',
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
    /** Replaces the old single free-text diagnostic: structural problems are addressable records. */
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
   * override bypasses *selection*, never validation: it is checked against live rows exactly as a
   * hook's answer is.
   */
  placement: Schema.optional(workflowPlacementRequestSchema),
});

export const startWorkflowOutputSchema = Schema.Struct({
  runId: positiveInteger,
  workflowKey: nonEmptyString,
});

export const workflowRunRouteParamsSchema = Schema.Struct({ runId: positiveInteger });

export const workflowPayloadRouteParamsSchema = Schema.Struct({
  runId: positiveInteger,
  payloadRef: nonEmptyString,
});

export const workflowAttemptRouteParamsSchema = Schema.Struct({
  runId: positiveInteger,
  attemptId: positiveInteger,
});

export const workflowFrameRouteParamsSchema = Schema.Struct({
  runId: positiveInteger,
  frameId: positiveInteger,
});

/** Global and workflow-key listing survives environment deletion; that is an API requirement. */
export const listWorkflowRunsQuerySchema = Schema.extend(
  paginationQuerySchema,
  Schema.Struct({
    workflowKey: Schema.optional(nonEmptyString),
    status: Schema.optional(workflowRunStatusSchema),
    attachedWorktreeId: Schema.optional(positiveInteger),
    attachedSurfaceId: Schema.optional(positiveInteger),
    includeDismissed: Schema.optional(booleanStringSchema),
  }),
);

export const listWorkflowRunsOutputSchema = Schema.Struct({
  items: Schema.Array(workflowRunSummarySchema),
  nextCursor: Schema.NullOr(cursorSchema),
});

export const getWorkflowRunOutputSchema = Schema.Struct({ run: workflowRunSummarySchema });

export const workflowStructureQuerySchema = Schema.Struct({
  /** Omitted returns the run's current pin. Retained in the API; the web client never sends it. */
  artifactHash: Schema.optional(nonEmptyString),
});

export const getWorkflowStructureOutputSchema = Schema.Struct({
  artifactHash: nonEmptyString,
  workflowKey: nonEmptyString,
  sdkVersion: nonEmptyString,
  verifierVersion: nonEmptyString,
  pinOrdinal: positiveInteger,
  adoptedAt: nonEmptyString,
  descriptor: workflowStructureDescriptorSchema,
});

export const listWorkflowVersionsQuerySchema = paginationQuerySchema;

export const listWorkflowVersionsOutputSchema = Schema.Struct({
  items: Schema.Array(workflowVersionSchema),
  nextCursor: Schema.NullOr(cursorSchema),
});

export const listWorkflowFramesQuerySchema = Schema.extend(
  paginationQuerySchema,
  Schema.Struct({ parentExecutionId: Schema.optional(positiveInteger) }),
);

export const listWorkflowFramesOutputSchema = Schema.Struct({
  items: Schema.Array(workflowFrameSchema),
  nextCursor: Schema.NullOr(cursorSchema),
});

export const listFrameExecutionsQuerySchema = Schema.extend(
  paginationQuerySchema,
  Schema.Struct({ nodeId: Schema.optional(nonEmptyString) }),
);

/**
 * An ordinary page. The recovery envelope below belongs to the run-scoped listing, which is the one
 * a client rebuilds a whole waterfall from; a per-frame page has no `sinceRevision` to answer and
 * must not imply it carries run-wide coverage.
 */
export const listFrameExecutionsOutputSchema = Schema.Struct({
  items: Schema.Array(workflowExecutionSchema),
  nextCursor: Schema.NullOr(cursorSchema),
});

/**
 * The boundary a paginated recovery read was taken against.
 *
 * `highWaterRevision` is frozen for the whole batch, and `coverageRevision` is the revision the
 * client may actually claim once it has consumed every page — never a cursor that acknowledges
 * revisions the client has not seen. `snapshotToken` lets executions and events recovery compose at
 * the same boundary.
 */
export const workflowRecoveryBoundarySchema = Schema.Struct({
  highWaterRevision: nonNegativeInteger,
  coverageRevision: nonNegativeInteger,
  snapshotToken: nonEmptyString,
  complete: Schema.Boolean,
}).pipe(
  // Acknowledging a revision the client was never given is the exact failure this boundary exists
  // to prevent, so the shape cannot express it.
  Schema.filter(
    (boundary) =>
      boundary.coverageRevision <= boundary.highWaterRevision ||
      `coverage ${boundary.coverageRevision} claims more than the frozen high-water revision ${boundary.highWaterRevision}`,
  ),
  Schema.filter(
    (boundary) =>
      !boundary.complete ||
      boundary.coverageRevision === boundary.highWaterRevision ||
      `a completed recovery must cover its high-water revision ${boundary.highWaterRevision}, not ${boundary.coverageRevision}`,
  ),
);

export const listRunExecutionsQuerySchema = Schema.extend(
  paginationQuerySchema,
  Schema.Struct({
    /** Restricts the result to rows created or changed after this revision. */
    sinceRevision: Schema.optional(nonNegativeInteger),
    snapshotToken: Schema.optional(nonEmptyString),
  }),
);

/**
 * Executions across every frame, in stable `(startedAt, executionId)` order.
 *
 * A row is "changed" when any projected fact changed — an operation receipt or settlement, the
 * latest attempt, a wait, a label, a child output, a routing fact — not only when an execution was
 * created. `changes` carries the complete operation, frame and summary records those revisions
 * touched, so a gap fill restores operation cards without an unbounded refetch of the whole run.
 */
export const listRunExecutionsOutputSchema = Schema.Struct({
  items: Schema.Array(workflowExecutionSchema),
  nextCursor: Schema.NullOr(cursorSchema),
  boundary: workflowRecoveryBoundarySchema,
  changes: Schema.Struct({
    frames: Schema.Array(workflowFrameSchema),
    operations: Schema.Array(workflowOperationSchema),
    summary: Schema.optional(workflowRunSummarySchema),
  }),
});

export const listWorkflowAttemptsQuerySchema = Schema.extend(
  paginationQuerySchema,
  Schema.Struct({
    frameId: Schema.optional(positiveInteger),
    executionId: Schema.optional(positiveInteger),
    segmentKind: Schema.optional(workflowSegmentKindSchema),
  }),
);

export const listWorkflowAttemptsOutputSchema = Schema.Struct({
  items: Schema.Array(workflowAttemptSchema),
  nextCursor: Schema.NullOr(cursorSchema),
});

export const getWorkflowAttemptOutputSchema = Schema.Struct({ attempt: workflowAttemptSchema });

export const listWorkflowOperationsQuerySchema = Schema.extend(
  paginationQuerySchema,
  Schema.Struct({
    executionId: Schema.optional(positiveInteger),
    state: Schema.optional(workflowOperationStateSchema),
  }),
);

export const listWorkflowOperationsOutputSchema = Schema.Struct({
  items: Schema.Array(workflowOperationSchema),
  nextCursor: Schema.NullOr(cursorSchema),
});

export const listWorkflowEventsQuerySchema = Schema.extend(
  paginationQuerySchema,
  Schema.Struct({
    sinceRevision: Schema.optional(nonNegativeInteger),
    snapshotToken: Schema.optional(nonEmptyString),
  }),
);

/**
 * History as complete deltas.
 *
 * Reconnecting through this route restores pause bands and pin adoption as well as execution
 * changes, and an operation-only change is recoverable even when no new node ran.
 */
export const listWorkflowEventsOutputSchema = Schema.Struct({
  items: Schema.Array(workflowRunTransitionDeltaSchema),
  nextCursor: Schema.NullOr(cursorSchema),
  boundary: workflowRecoveryBoundarySchema,
});

export const getWorkflowPayloadOutputSchema = Schema.Struct({
  payloadRef: nonEmptyString,
  mediaType: nonEmptyString,
  byteSize: nonNegativeInteger,
  value: Schema.Unknown,
});

export const advanceWorkflowInputSchema = Schema.Struct({
  /** A wait is addressed by its own identity, so a stale submission cannot satisfy a newer wait. */
  waitId: workflowWaitIdSchema,
  answers: Schema.optional(workflowUserInputAnswersSchema),
});

/**
 * A control's result stays narrow: what was accepted and where the run is now. It is not an
 * alternate snapshot authority — the read routes and the delta stream are.
 */
export const workflowRunControlOutputSchema = Schema.Struct({
  runId: positiveInteger,
  accepted: Schema.Boolean,
  status: workflowRunStatusSchema,
  revision: positiveInteger,
  /** Populated when a control was refused because the pinned structure no longer fits the position. */
  diagnostics: Schema.Array(workflowStructureDiagnosticSchema),
});

export type WorkflowLaunchOrigin = typeof workflowLaunchOriginSchema.Type;
export type WorkflowLoadFailureReason = typeof workflowLoadFailureReasonSchema.Type;
export type WorkflowDescriptorResult = typeof workflowDescriptorResultSchema.Type;
export type ListWorkflowDescriptorsInput = typeof listWorkflowDescriptorsInputSchema.Type;
export type ListWorkflowDescriptorsOutput = typeof listWorkflowDescriptorsOutputSchema.Type;
export type StartWorkflowInput = typeof startWorkflowInputSchema.Type;
export type StartWorkflowOutput = typeof startWorkflowOutputSchema.Type;
export type WorkflowRunRouteParams = typeof workflowRunRouteParamsSchema.Type;
export type WorkflowPayloadRouteParams = typeof workflowPayloadRouteParamsSchema.Type;
export type WorkflowAttemptRouteParams = typeof workflowAttemptRouteParamsSchema.Type;
export type WorkflowFrameRouteParams = typeof workflowFrameRouteParamsSchema.Type;
export type ListWorkflowRunsQuery = typeof listWorkflowRunsQuerySchema.Type;
export type ListWorkflowRunsOutput = typeof listWorkflowRunsOutputSchema.Type;
export type GetWorkflowRunOutput = typeof getWorkflowRunOutputSchema.Type;
export type WorkflowStructureQuery = typeof workflowStructureQuerySchema.Type;
export type GetWorkflowStructureOutput = typeof getWorkflowStructureOutputSchema.Type;
export type ListWorkflowVersionsQuery = typeof listWorkflowVersionsQuerySchema.Type;
export type ListWorkflowVersionsOutput = typeof listWorkflowVersionsOutputSchema.Type;
export type ListWorkflowFramesQuery = typeof listWorkflowFramesQuerySchema.Type;
export type ListWorkflowFramesOutput = typeof listWorkflowFramesOutputSchema.Type;
export type ListFrameExecutionsQuery = typeof listFrameExecutionsQuerySchema.Type;
export type ListFrameExecutionsOutput = typeof listFrameExecutionsOutputSchema.Type;
export type WorkflowRecoveryBoundary = typeof workflowRecoveryBoundarySchema.Type;
export type ListRunExecutionsQuery = typeof listRunExecutionsQuerySchema.Type;
export type ListRunExecutionsOutput = typeof listRunExecutionsOutputSchema.Type;
export type ListWorkflowAttemptsQuery = typeof listWorkflowAttemptsQuerySchema.Type;
export type ListWorkflowAttemptsOutput = typeof listWorkflowAttemptsOutputSchema.Type;
export type GetWorkflowAttemptOutput = typeof getWorkflowAttemptOutputSchema.Type;
export type ListWorkflowOperationsQuery = typeof listWorkflowOperationsQuerySchema.Type;
export type ListWorkflowOperationsOutput = typeof listWorkflowOperationsOutputSchema.Type;
export type ListWorkflowEventsQuery = typeof listWorkflowEventsQuerySchema.Type;
export type ListWorkflowEventsOutput = typeof listWorkflowEventsOutputSchema.Type;
export type GetWorkflowPayloadOutput = typeof getWorkflowPayloadOutputSchema.Type;
export type AdvanceWorkflowInput = typeof advanceWorkflowInputSchema.Type;
export type WorkflowRunControlOutput = typeof workflowRunControlOutputSchema.Type;
