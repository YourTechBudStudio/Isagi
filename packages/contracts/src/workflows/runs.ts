import { Schema } from 'effect';

import {
  workflowExecutionSchema,
  workflowFrameSchema,
  workflowOperationSchema,
  workflowTransitionSchema,
} from './executions.js';
import {
  nonEmptyString,
  nonNegativeInteger,
  positiveInteger,
  workflowFailureCodeSchema,
  workflowNodeKindSchema,
  workflowOutcomeKindSchema,
  workflowPlacementSchema,
  workflowPayloadSlotSchema,
  workflowQuestionSpecSchema,
  workflowSegmentKindSchema,
  workflowUiFeedbackSchema,
  workflowWaitIdSchema,
  workflowWaitKindSchema,
} from './primitives.js';

export const workflowRunStatusSchema = Schema.Literal(
  'ready',
  'running',
  'waiting',
  'blocked',
  'failed',
  'done',
  'cancelled',
);

/**
 * The next segment the engine would run. The snapshot chooses what runs next; history explains what
 * ran.
 *
 * A discriminated union rather than one struct of nullable fields: each kind requires exactly the
 * identities that kind needs, so an impossible position — a `routing` position with no execution or
 * edge, say — cannot be represented, let alone transmitted.
 */
export const workflowRunPositionSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('graph_entry'), frameId: positiveInteger }),
  Schema.Struct({
    kind: Schema.Literal('node_callback'),
    frameId: positiveInteger,
    executionId: positiveInteger,
  }),
  Schema.Struct({
    kind: Schema.Literal('awaiting_wait'),
    frameId: positiveInteger,
    executionId: positiveInteger,
    waitId: workflowWaitIdSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('routing'),
    frameId: positiveInteger,
    executionId: positiveInteger,
    edgeId: nonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal('graph_output'),
    frameId: positiveInteger,
    outcomeId: nonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal('child_output_mapping'),
    frameId: positiveInteger,
    executionId: positiveInteger,
    childFrameId: positiveInteger,
  }),
  Schema.Struct({ kind: Schema.Literal('terminal') }),
);

export const workflowOperationRefSchema = Schema.Struct({
  operationKey: nonEmptyString,
  frameId: positiveInteger,
  /** Required here for the same reason it is required on the operation itself: an operation is only
   *  ever created inside a node callback, so a reference that cannot name one describes a row the
   *  durable model has no way to produce. */
  executionId: positiveInteger,
});

/**
 * Best-effort stopping, reported honestly.
 *
 * Cancel stops successors and new effects; it cannot guarantee that an external process died. The
 * counts say exactly how much of the stop was confirmed.
 */
export const workflowStopSummarySchema = Schema.Struct({
  requested: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  confirmed: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  failed: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  unsupported: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  pending: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

/**
 * Which controls the runtime will actually accept right now.
 *
 * Availability is decided by the runtime and rechecked at mutation time, so the bar and the
 * inspector cannot drift from the real preconditions.
 */
export const workflowRunControlsSchema = Schema.Struct({
  pause: Schema.Boolean,
  resume: Schema.Boolean,
  retry: Schema.Boolean,
  cancel: Schema.Boolean,
  dismiss: Schema.Boolean,
  advance: Schema.Boolean,
});

export const workflowRunSummarySchema = Schema.Struct({
  runId: positiveInteger,
  workflowKey: nonEmptyString,
  title: nonEmptyString,
  rootGraphKey: nonEmptyString,
  status: workflowRunStatusSchema,
  paused: Schema.Boolean,
  /** The history revision this summary reflects. */
  revision: positiveInteger,
  artifactHash: nonEmptyString,
  /** 1-based position of the current pin in this run's adoption history. */
  pinOrdinal: positiveInteger,
  outcome: Schema.NullOr(
    Schema.Struct({
      outcomeId: nonEmptyString,
      kind: workflowOutcomeKindSchema,
      reason: Schema.NullOr(Schema.String),
      // The same sized reference every other recorded value uses: opaque, size-bearing, and never
      // a filesystem path.
      producedRef: workflowPayloadSlotSchema,
    }),
  ),
  position: workflowRunPositionSchema,
  activeNode: Schema.NullOr(
    Schema.Struct({
      frameId: positiveInteger,
      graphKey: nonEmptyString,
      nodeId: nonEmptyString,
      nodeKind: workflowNodeKindSchema,
      executionId: positiveInteger,
      /** Zero-based, like every other visit index. */
      visitIndex: nonNegativeInteger,
      displayName: Schema.NullOr(Schema.String),
    }),
  ),
  blockingWait: Schema.NullOr(
    Schema.Struct({
      waitId: workflowWaitIdSchema,
      kind: workflowWaitKindSchema,
      label: Schema.NullOr(Schema.String),
      frameId: positiveInteger,
      executionId: positiveInteger,
      questions: Schema.NullOr(Schema.Array(workflowQuestionSpecSchema)),
      armedAt: nonEmptyString,
    }),
  ),
  /** Set when an operation whose delivery cannot be established is holding the run. */
  blockedOperation: Schema.NullOr(workflowOperationRefSchema),
  failure: Schema.NullOr(
    Schema.Struct({
      code: workflowFailureCodeSchema,
      message: Schema.String,
      segmentKind: workflowSegmentKindSchema,
      attemptId: positiveInteger,
      frameId: positiveInteger,
      executionId: Schema.NullOr(positiveInteger),
    }),
  ),
  stopSummary: Schema.NullOr(workflowStopSummarySchema),
  uiFeedback: Schema.NullOr(workflowUiFeedbackSchema),
  /** The removable row that occupies a surface. Its deletion releases placement, not history. */
  attachment: Schema.NullOr(
    Schema.Struct({
      worktreeId: Schema.NullOr(positiveInteger),
      surfaceId: Schema.NullOr(positiveInteger),
    }),
  ),
  origin: workflowPlacementSchema,
  destination: workflowPlacementSchema,
  controls: workflowRunControlsSchema,
  createdAt: nonEmptyString,
  updatedAt: nonEmptyString,
  endedAt: Schema.NullOr(nonEmptyString),
});

/**
 * One committed transition together with every record it changed.
 *
 * The arrays carry complete records, never bare ids, so a client applies a delta without fetching.
 * They may be empty, and they may carry several records: one transaction can change a frame, an
 * execution and more than one operation at once. `summary` is attached when the transition changed
 * the run's status, position, pause state or failure.
 */
export const workflowRunTransitionDeltaSchema = Schema.Struct({
  runId: positiveInteger,
  revision: positiveInteger,
  transition: workflowTransitionSchema,
  changes: Schema.Struct({
    executions: Schema.Array(workflowExecutionSchema),
    frames: Schema.Array(workflowFrameSchema),
    operations: Schema.Array(workflowOperationSchema),
    summary: Schema.optional(workflowRunSummarySchema),
  }),
}).pipe(
  // The client applies a delta only when its revision is exactly one past the last one applied, so
  // a delta that disagrees with itself about which revision it is would desynchronise that rule
  // while decoding cleanly. The transition is the revision; the envelope repeats it for routing.
  Schema.filter(
    (delta) =>
      delta.revision === delta.transition.revision ||
      `a delta at revision ${delta.revision} carries a transition at revision ${delta.transition.revision}`,
  ),
  // An attached summary is the state this transition produced, not an earlier one.
  Schema.filter(
    (delta) =>
      delta.changes.summary === undefined ||
      delta.changes.summary.revision === delta.revision ||
      `a delta at revision ${delta.revision} carries a summary at revision ${delta.changes.summary.revision}`,
  ),
  // ...and it describes the run the delta is about. Routing uses the envelope's run id while the
  // summary is the authoritative state, so a disagreement would leave a client to invent precedence
  // between two identities, or update the wrong cached run. The summary is the only changed record
  // that carries a run id; executions, frames and operations are addressed within their run.
  Schema.filter(
    (delta) =>
      delta.changes.summary === undefined ||
      delta.changes.summary.runId === delta.runId ||
      `a delta for run ${delta.runId} carries a summary for run ${delta.changes.summary.runId}`,
  ),
);

export type WorkflowRunStatus = typeof workflowRunStatusSchema.Type;
export type WorkflowRunPosition = typeof workflowRunPositionSchema.Type;
export type WorkflowOperationRef = typeof workflowOperationRefSchema.Type;
export type WorkflowStopSummary = typeof workflowStopSummarySchema.Type;
export type WorkflowRunControls = typeof workflowRunControlsSchema.Type;
export type WorkflowRunSummary = typeof workflowRunSummarySchema.Type;
export type WorkflowRunTransitionDelta = typeof workflowRunTransitionDeltaSchema.Type;
