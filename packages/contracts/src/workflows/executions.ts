import { Schema } from 'effect';

import {
  nonEmptyString,
  nonNegativeInteger,
  positiveInteger,
  workflowCapabilitySchema,
  workflowAttemptStatusSchema,
  workflowEndCertaintySchema,
  workflowExecutionStatusSchema,
  workflowFrameStatusSchema,
  workflowInvocationKindSchema,
  workflowNodeKindSchema,
  workflowOperationStageSchema,
  workflowOperationStateSchema,
  workflowOperationTargetSchema,
  workflowOutcomeKindSchema,
  workflowPayloadRefSchema,
  workflowPayloadSlotSchema,
  workflowQuestionSpecSchema,
  workflowRecoveryModeSchema,
  workflowSegmentFailureSchema,
  workflowSegmentKindSchema,
  workflowStopReportSchema,
  workflowUserInputAnswersSchema,
  workflowWaitIdSchema,
  workflowWaitKindSchema,
  workflowWaitStatusSchema,
} from './primitives.js';

/**
 * The retained execution record.
 *
 * Four identities stay distinct on the wire and are never conflated: a **definition address** (a
 * graph key plus a node id), a **frame** (one invocation of a graph), an **execution** (one visit to
 * a node inside a frame), and an **attempt** (one try at a segment). A definition node is therefore
 * never mistaken for an iteration, and one graph reused twice does not merge its two frames.
 */

/** One try at one segment. */
export const workflowAttemptSchema = Schema.Struct({
  attemptId: positiveInteger,
  frameId: positiveInteger,
  /** Null for the two frame-owned segment kinds: graph entry and output evaluation. */
  executionId: Schema.NullOr(positiveInteger),
  segmentKind: workflowSegmentKindSchema,
  /** The node, edge, or outcome id this segment ran against, when it has one. */
  segmentRef: Schema.NullOr(nonEmptyString),
  /** 1-based within its segment. */
  attemptIndex: positiveInteger,
  /** The pin this attempt itself ran under. */
  artifactHash: nonEmptyString,
  status: workflowAttemptStatusSchema,
  invocationKind: workflowInvocationKindSchema,
  startedAt: nonEmptyString,
  endedAt: Schema.NullOr(nonEmptyString),
  endCertainty: workflowEndCertaintySchema,
  failure: Schema.NullOr(workflowSegmentFailureSchema),
  inputRef: workflowPayloadSlotSchema,
  /** The saved producer result a repair would reuse, and the pin that produced it. */
  producerOutputRef: workflowPayloadSlotSchema,
  producerArtifactHash: Schema.NullOr(nonEmptyString),
  recoveryMode: workflowRecoveryModeSchema,
});

/** A durable external operation, identified independently of the attempt that dispatched it. */
export const workflowOperationSchema = Schema.Struct({
  operationKey: nonEmptyString,
  frameId: positiveInteger,
  /**
   * An operation is only ever created inside a node callback, and intent records its execution,
   * originating attempt, normalized request and fingerprint *before* the effect crosses the
   * boundary. These are creation-time facts, not lifecycle facts: an operation missing any of them
   * could not participate in prefix matching, nor show the inspector what was actually sent.
   */
  executionId: positiveInteger,
  /** The attempt that recorded the intent. Operations outlive it, so this is provenance. */
  attemptId: positiveInteger,
  capability: workflowCapabilitySchema,
  /** Position of this call within its execution's call sequence. Prefix matching runs on this. */
  callIndex: nonNegativeInteger,
  state: workflowOperationStateSchema,
  stage: Schema.NullOr(workflowOperationStageSchema),
  requestRef: workflowPayloadRefSchema,
  /** The fingerprint that detects a changed request on re-entry. */
  requestHash: nonEmptyString,
  receiptRef: workflowPayloadSlotSchema,
  resultRef: workflowPayloadSlotSchema,
  target: workflowOperationTargetSchema,
  stop: workflowStopReportSchema,
  /** Why delivery could not be established. Present exactly when the state is `uncertain`. */
  uncertaintyDetail: Schema.NullOr(Schema.String),
  /** Evidence that arrived after settlement. Retained; it never revives a settled operation. */
  lateEvidenceRef: workflowPayloadSlotSchema,
  createdAt: nonEmptyString,
  dispatchedAt: Schema.NullOr(nonEmptyString),
  settledAt: Schema.NullOr(nonEmptyString),
});

/** The wait a node visit armed, and what was delivered to it. */
export const workflowExecutionWaitSchema = Schema.Struct({
  waitId: workflowWaitIdSchema,
  kind: workflowWaitKindSchema,
  status: workflowWaitStatusSchema,
  label: Schema.NullOr(Schema.String),
  questions: Schema.NullOr(Schema.Array(workflowQuestionSpecSchema)),
  answers: Schema.NullOr(workflowUserInputAnswersSchema),
  armedAt: Schema.NullOr(nonEmptyString),
  deliveredAt: Schema.NullOr(nonEmptyString),
});

/** The routing segment of a node visit: its decision, its timing, and its own failure. */
export const workflowExecutionRoutingSchema = Schema.Struct({
  edgeId: Schema.NullOr(nonEmptyString),
  attemptIndex: Schema.NullOr(positiveInteger),
  chosen: Schema.NullOr(nonEmptyString),
  updateRef: workflowPayloadSlotSchema,
  startedAt: Schema.NullOr(nonEmptyString),
  endedAt: Schema.NullOr(nonEmptyString),
  failure: Schema.NullOr(workflowSegmentFailureSchema),
});

/** The attempt the client shows, plus enough prior evidence to explain a repair. */
export const workflowLatestAttemptSchema = Schema.Struct({
  attemptId: positiveInteger,
  attemptIndex: positiveInteger,
  artifactHash: nonEmptyString,
  status: workflowAttemptStatusSchema,
  invocationKind: workflowInvocationKindSchema,
  failure: Schema.NullOr(workflowSegmentFailureSchema),
  recoveryMode: workflowRecoveryModeSchema,
  producerArtifactHash: Schema.NullOr(nonEmptyString),
});

/**
 * A failure an earlier attempt of this segment recorded, retained even once a later attempt
 * succeeded, so a repaired step still explains what went wrong and what fixed it.
 */
export const workflowPriorFailureSchema = Schema.Struct({
  attemptId: positiveInteger,
  attemptIndex: positiveInteger,
  segmentKind: workflowSegmentKindSchema,
  artifactHash: nonEmptyString,
  failure: workflowSegmentFailureSchema,
  repairedByAttemptIndex: Schema.NullOr(positiveInteger),
  repairedByArtifactHash: Schema.NullOr(nonEmptyString),
});

export const workflowOperationSummarySchema = Schema.Struct({
  count: nonNegativeInteger,
  unresolved: nonNegativeInteger,
  /** The capabilities this execution actually called. Recorded facts, never inferred from source. */
  capabilities: Schema.Array(workflowCapabilitySchema),
});

/**
 * The immutable fact a completed frame published: which outcome, with what value, produced by which
 * pin. Its timing lives on the segment that evaluated it — a repaired publication commits under a
 * new attempt while the value and its producing pin keep naming where they came from, so carrying
 * one moment on two records would let them disagree.
 */
export const workflowFrameOutputSchema = Schema.Struct({
  outcomeId: nonEmptyString,
  outcomeKind: workflowOutcomeKindSchema,
  outcomeReason: Schema.NullOr(Schema.String),
  producedRef: workflowPayloadSlotSchema,
  /** The pin that produced the value, which can differ from the pin that retried the publication. */
  producerArtifactHash: Schema.NullOr(nonEmptyString),
});

/**
 * A segment a *frame* owns rather than a node visit: entering the graph, and evaluating its output.
 *
 * Both run author code, both can fail, and neither has a node execution to hang from — a failed
 * initialization and an output evaluation that threw before any outcome existed are the two states
 * a frame can be stuck in with nothing else to show for it. Without this the dock would have to
 * fetch attempts to say anything about either, which is exactly what these records exist to avoid.
 *
 * `null` on a frame means the segment was never attempted; a present record whose `latestAttempt`
 * carries a failure means it was attempted and failed. The two are deliberately distinguishable.
 */
export const workflowFrameSegmentSchema = Schema.Struct({
  segmentKind: Schema.Literal('graph_entry', 'graph_output'),
  /** The outcome an output evaluation is for. Null for graph entry, which has no reference. */
  segmentRef: Schema.NullOr(nonEmptyString),
  attemptCount: positiveInteger,
  startedAt: nonEmptyString,
  endedAt: Schema.NullOr(nonEmptyString),
  endCertainty: workflowEndCertaintySchema,
  /** A segment started under one pin and repaired under another reads as first → latest. */
  firstArtifactHash: nonEmptyString,
  latestArtifactHash: nonEmptyString,
  latestAttempt: workflowLatestAttemptSchema,
  /** Retained even once a later attempt succeeded, so a repaired frame still explains itself. */
  priorFailures: Schema.Array(workflowPriorFailureSchema),
});

/** One invocation of a graph. */
export const workflowFrameSchema = Schema.Struct({
  frameId: positiveInteger,
  /** Null for the root frame. */
  parentExecutionId: Schema.NullOr(positiveInteger),
  parentFrameId: Schema.NullOr(positiveInteger),
  graphKey: nonEmptyString,
  entryArtifactHash: nonEmptyString,
  depth: nonNegativeInteger,
  status: workflowFrameStatusSchema,
  displayName: Schema.NullOr(Schema.String),
  labelDiagnostic: Schema.NullOr(Schema.String),
  /** The frame's own initialization segment. Null until it has been attempted at all. */
  entry: Schema.NullOr(workflowFrameSegmentSchema),
  /**
   * The segment that evaluates this frame's output, which exists before any output does — a
   * failed evaluation has one of these and no `output` at all.
   */
  outputEvaluation: Schema.NullOr(workflowFrameSegmentSchema),
  output: Schema.NullOr(workflowFrameOutputSchema),
  enteredAt: nonEmptyString,
  completedAt: Schema.NullOr(nonEmptyString),
  parametersRef: workflowPayloadSlotSchema,
  stateRef: workflowPayloadSlotSchema,
  executionCount: nonNegativeInteger,
});

/**
 * One visit to one node. Everything a waterfall row and the dock need is here, so drawing history
 * never requires a second request per row.
 */
export const workflowExecutionSchema = Schema.Struct({
  executionId: positiveInteger,
  frameId: positiveInteger,
  parentExecutionId: Schema.NullOr(positiveInteger),
  graphKey: nonEmptyString,
  depth: nonNegativeInteger,
  nodeId: nonEmptyString,
  nodeKind: workflowNodeKindSchema,
  /**
   * Which visit to this node within this frame, counted from zero: it is the number of prior
   * executions of this node id in this frame, so a node's first visit is 0. Two visits never share
   * an identity.
   */
  visitIndex: nonNegativeInteger,
  status: workflowExecutionStatusSchema,
  displayName: Schema.NullOr(Schema.String),
  /** Set only when label capture failed. The segment still ran. */
  labelDiagnostic: Schema.NullOr(Schema.String),
  childFrameId: Schema.NullOr(positiveInteger),
  /** Returned inline on a subgraph execution so a spanning bar needs no second fetch. */
  childFrame: Schema.NullOr(workflowFrameSchema),
  startedAt: nonEmptyString,
  endedAt: Schema.NullOr(nonEmptyString),
  endCertainty: workflowEndCertaintySchema,
  callbackStartedAt: Schema.NullOr(nonEmptyString),
  callbackEndedAt: Schema.NullOr(nonEmptyString),
  waitArmedAt: Schema.NullOr(nonEmptyString),
  waitDeliveredAt: Schema.NullOr(nonEmptyString),
  /**
   * Zero until this visit's first segment attempt exists. A node execution is published when the
   * run is positioned at it — graph entry creates the row and dispatches it, and entering a
   * subgraph creates one with no attempt at all because no author callback runs.
   */
  attemptCount: nonNegativeInteger,
  /** A visit that started under one pin and was repaired under another reads as first → latest. */
  firstArtifactHash: nonEmptyString,
  latestArtifactHash: nonEmptyString,
  /** Null for a freshly dispatched visit that has not yet attempted a segment. */
  latestAttempt: Schema.NullOr(workflowLatestAttemptSchema),
  priorFailures: Schema.Array(workflowPriorFailureSchema),
  routing: Schema.NullOr(workflowExecutionRoutingSchema),
  wait: Schema.NullOr(workflowExecutionWaitSchema),
  operationSummary: workflowOperationSummarySchema,
  /** The payload slots the dock offers. A null slot means the step never produced that value. */
  stateInRef: workflowPayloadSlotSchema,
  candidateRef: workflowPayloadSlotSchema,
  updateRef: workflowPayloadSlotSchema,
  stateOutRef: workflowPayloadSlotSchema,
});

/**
 * One committed history transition.
 *
 * Every durable transition gets its own revision, including diagnostics, receipt-stage updates,
 * pause boundaries and pin adoption. A transaction that writes several of them allocates
 * consecutive revisions and publishes all of them only after it commits.
 */
export const workflowTransitionKindSchema = Schema.Literal(
  'run_started',
  // Preparation's two durable facts. One allocation was made and recorded (detail: `{ step,
  // receipt }`), and preparation committed (detail: `{ destination }`). Their detail stays in the
  // opaque payload slot every non-diagnostic transition uses: nothing decodes it, because the run
  // summary's `preparation` object is what the inspector renders, and the trace needs only labels.
  'environment_step_recorded',
  'environment_prepared',
  'graph_entered',
  'node_dispatched',
  'wait_armed',
  'wait_delivered',
  // A producer's result reached its durable slot before anything tried to reduce it. It is its own
  // transition because it is its own durable change: a client recovering by revision has to learn
  // that a segment now carries a reusable operand — which is what decides whether a Retry re-runs
  // the producer — and an attempt row read out of band is not revision-based recovery. It is
  // emphatically not a successful reduction and not segment completion.
  'producer_output_captured',
  'state_reduced',
  'routed',
  'child_output_published',
  'output_mapped',
  'graph_completed',
  'run_completed',
  'segment_failed',
  'run_blocked',
  'operation_recorded',
  'operation_settled',
  'stop_recorded',
  'log',
  'ui_feedback',
  // The inspector amendment replaces the design's single `control_applied` for pause boundaries and
  // its `version_adopted` with these explicit kinds, because a live waterfall needs the pause band
  // and a pin change as first-class facts. The mapping is exact: pause boundaries and pin adoption
  // use these three; `control_applied` is retained for the controls that have no dedicated kind —
  // resume, cancel and dismiss — and `version_adopted` is gone entirely.
  'pause_opened',
  'pause_closed',
  'retry_pin_adopted',
  'control_applied',
);

export const workflowTransitionSchema = Schema.Struct({
  revision: positiveInteger,
  recordedAt: nonEmptyString,
  kind: workflowTransitionKindSchema,
  frameId: Schema.NullOr(positiveInteger),
  executionId: Schema.NullOr(positiveInteger),
  attemptId: Schema.NullOr(positiveInteger),
  operationKey: Schema.NullOr(nonEmptyString),
  waitId: Schema.NullOr(workflowWaitIdSchema),
  artifactHash: Schema.NullOr(nonEmptyString),
  detailRef: workflowPayloadSlotSchema,
  stateRef: workflowPayloadSlotSchema,
});

export type WorkflowAttemptDto = typeof workflowAttemptSchema.Type;
export type WorkflowOperationDto = typeof workflowOperationSchema.Type;
export type WorkflowFrameDto = typeof workflowFrameSchema.Type;
export type WorkflowFrameOutputDto = typeof workflowFrameOutputSchema.Type;
export type WorkflowFrameSegmentDto = typeof workflowFrameSegmentSchema.Type;
export type WorkflowExecutionDto = typeof workflowExecutionSchema.Type;
export type WorkflowExecutionWaitDto = typeof workflowExecutionWaitSchema.Type;
export type WorkflowExecutionRoutingDto = typeof workflowExecutionRoutingSchema.Type;
export type WorkflowLatestAttemptDto = typeof workflowLatestAttemptSchema.Type;
export type WorkflowPriorFailureDto = typeof workflowPriorFailureSchema.Type;
export type WorkflowOperationSummaryDto = typeof workflowOperationSummarySchema.Type;
export type WorkflowTransitionKind = typeof workflowTransitionKindSchema.Type;
export type WorkflowTransitionDto = typeof workflowTransitionSchema.Type;
