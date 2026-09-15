import { workflowInputKinds, workflowWaitKinds } from '@yourtechbudstudio/isagi-workflow-sdk';
import type {
  WorkflowCommandManifest,
  WorkflowQuestionOption,
  WorkflowQuestionSpec,
  WorkflowUiFeedback,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Schema } from 'effect';

/** Shared scalars and value shapes for the workflow wire surface. */

export const positiveInteger = Schema.Number.pipe(Schema.int(), Schema.positive());
export const nonNegativeInteger = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
export const nonEmptyString = Schema.String.pipe(Schema.minLength(1));

export const workflowInputKindSchema = Schema.Literal(...workflowInputKinds);
export const workflowWaitKindSchema = Schema.Literal(...workflowWaitKinds);

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
  title: nonEmptyString,
  description: Schema.optional(Schema.String),
  inputs: Schema.optional(Schema.Array(workflowQuestionSpecSchema)),
});

export const workflowUiFeedbackSchema: Schema.Schema<WorkflowUiFeedback> = Schema.Struct({
  kind: Schema.optional(Schema.Literal('info', 'warning', 'error')),
  phase: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

export const workflowLogLevelSchema = Schema.Literal('debug', 'info', 'warning', 'error');

export const workflowUserInputAnswersSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Union(Schema.String, Schema.Array(Schema.String), Schema.Boolean),
});

export const workflowInputsSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

/**
 * A reference to a recorded value.
 *
 * Small values travel inline; larger ones are fetched on demand through the payload route. Either
 * way the reference is opaque: clients never receive a filesystem path, so the physical store can
 * be replaced without changing this contract. `byteSize` lets a client show a size before fetching.
 *
 * A payload *slot* is nullable, and `null` there means the step never produced the value. A step
 * that produced JSON `null` records `{ inline: null }`. The two are deliberately distinguishable.
 */
const workflowSizedPayloadRefSchema = Schema.Struct({
  payloadRef: nonEmptyString,
  byteSize: nonNegativeInteger,
  mediaType: nonEmptyString,
});

/**
 * `inline` may legitimately hold JSON `null`, so presence is checked explicitly: a bare
 * `inline: Schema.Unknown` would also be satisfied by an object that has no `inline` key at all,
 * which would let a sized reference decode as an inline value.
 */
const workflowInlinePayloadRefSchema = Schema.Struct({ inline: Schema.Unknown }).pipe(
  Schema.filter(
    (value) => Object.hasOwn(value, 'inline') || 'an inline payload must carry an "inline" key',
  ),
);

export const workflowPayloadRefSchema = Schema.Union(
  workflowSizedPayloadRefSchema,
  workflowInlinePayloadRefSchema,
);

export const workflowPayloadSlotSchema = Schema.NullOr(workflowPayloadRefSchema);

/**
 * Where a run was launched from, and where its work is placed. Descriptive and retained: it may
 * name a worktree, surface, or pane the person has since deleted, which is exactly why retained
 * history does not hang off those rows.
 */
export const workflowPlacementSchema = Schema.Struct({
  worktreeId: Schema.NullOr(positiveInteger),
  worktreePath: Schema.NullOr(nonEmptyString),
  surfaceId: Schema.NullOr(positiveInteger),
  paneId: Schema.NullOr(positiveInteger),
  agentSessionId: Schema.NullOr(positiveInteger),
  available: Schema.Boolean,
});

export const workflowNodeKindSchema = Schema.Literal('operation', 'subgraph', 'checkpoint');

export const workflowOutcomeKindSchema = Schema.Literal('success', 'failure');

/** Where a run is parked between segments. Each value names the next segment the engine would run. */
export const workflowPositionKindSchema = Schema.Literal(
  'graph_entry',
  'node_callback',
  'awaiting_wait',
  'routing',
  'graph_output',
  'child_output_mapping',
  'terminal',
);

/** A wait is a durable row, so its identity is that row's id rather than an opaque string. */
export const workflowWaitIdSchema = positiveInteger;

/**
 * The segment kinds an attempt can belong to. `awaiting_wait` is a position, never an attempt, and
 * the mapping segment is named `output_mapping` here — `child_output_mapping` is the *position*
 * kind for the same boundary. The two enums are deliberately distinct and must not be merged.
 */
export const workflowSegmentKindSchema = Schema.Literal(
  'graph_entry',
  'node_callback',
  'routing',
  'graph_output',
  'output_mapping',
);

/** One try at one segment. `superseded` is how a claim that lost a race is retained, not discarded. */
export const workflowAttemptStatusSchema = Schema.Literal(
  'running',
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
  'superseded',
);

/** One invocation of a graph. A frame does not fail; the run does. */
export const workflowFrameStatusSchema = Schema.Literal('initializing', 'active', 'completed');

/** One visit to a node, through its callback, wait, router and child-output mapping. */
export const workflowExecutionStatusSchema = Schema.Literal(
  'running',
  'awaiting',
  'routing',
  'mapping',
  'completed',
  'failed',
);

/** A wait's lifecycle. A superseded wait is retained; its late event routes nothing. */
export const workflowWaitStatusSchema = Schema.Literal(
  'armed',
  'delivered',
  'consumed',
  'superseded',
);

/**
 * The closed set of segment failure codes.
 *
 * This is what keeps the difference between "the agent reported a failed turn" and "the callback
 * threw" a stable public contract: the first is data inside a delivered event, the second is one of
 * these codes. `label_failed` is deliberately absent — a failed display-name capture is a
 * diagnostic, never a segment failure.
 */
export const workflowFailureCodeSchema = Schema.Literal(
  'parameter_mapping_failed',
  'graph_init_failed',
  'node_callback_failed',
  'reduction_failed',
  'reducer_failed',
  'unknown_state_field',
  'implicit_clear_rejected',
  'invalid_update_shape',
  'unserializable_state',
  'async_pure_callback',
  'undeclared_destination',
  'edge_choose_failed',
  'output_evaluation_failed',
  'output_mapping_failed',
  'operation_prefix_unresolved',
  'operation_prefix_unconsumed',
  'operation_request_changed',
  'operation_uncertain',
  'operation_context_closed',
  'unsupported_node_kind',
  'payload_unavailable',
);

export const workflowSegmentFailureSchema = Schema.Struct({
  code: workflowFailureCodeSchema,
  message: Schema.String,
  detail: workflowPayloadSlotSchema,
});

/**
 * Whether an interval's end was actually observed. An interval whose owner was interrupted keeps an
 * unknown end, which the inspector renders as unknown rather than as a computed duration.
 */
export const workflowEndCertaintySchema = Schema.Literal('observed', 'unknown');

export const workflowInvocationKindSchema = Schema.Literal('initial', 'resumed', 'retry');

/**
 * What a Retry would actually do with this segment's saved operand: reuse the producer's saved
 * result, or run the producer again. Derived by the runtime, so the inspector never guesses.
 */
export const workflowRecoveryModeSchema = Schema.Literal('reuse_producer_output', 'rerun_producer');

/**
 * The capabilities the runtime journals as durable operations — the four that cross an external
 * boundary and therefore need an intent, a receipt and recovery. Reading conversation history,
 * logging and UI feedback are scoped reads and diagnostics, not journaled effects, and author-owned
 * IO is neither journaled nor invented.
 */
export const workflowCapabilitySchema = Schema.Literal(
  'spawn_agent_session',
  'send_agent_prompt',
  'close_pane',
  'run_headless_agent',
);

/**
 * An external operation's settlement.
 *
 * `uncertain` is the honest answer when delivery cannot be established, and it is not overridable
 * by Retry or by an operator assertion. `abandoned` means the effect provably never left;
 * `interrupted` means it left and the runtime lost the process capturing it.
 */
export const workflowOperationStateSchema = Schema.Literal(
  'intended',
  'dispatched',
  'completed',
  'failed',
  'interrupted',
  'uncertain',
  'abandoned',
);

/**
 * How far a capability that crosses an external boundary actually got. Every value naming a boundary
 * is written **before** that boundary is crossed, which is what makes a resource-only receipt
 * distinguishable from a submitted prompt. Recovery classifies from this, never from a process
 * status or a backend reference, neither of which proves a spawn or a stop.
 */
export const workflowOperationStageSchema = Schema.Literal(
  // run_headless_agent
  'allocated',
  'starting',
  'started',
  // Carries the owner's reported cause, which is what separates a preparation failure that never
  // reached a backend (settle `abandoned`, redispatch is safe) from a post-spawn failure where a
  // process may be live (settle `failed`, never redispatch under the same identity).
  'launch_failed',
  // spawn_agent_session
  'pane_created',
  'session_created',
  'seed_submitting',
  'seed_submitted',
  // send_agent_prompt
  'submitting',
  'submitted',
);

/** Stopping an external process is best effort, so its completeness is reported, never assumed. */
export const workflowStopStateSchema = Schema.Literal(
  'not_requested',
  'pending',
  'confirmed',
  'failed',
  'unsupported',
);

export const workflowStopReportSchema = Schema.Struct({
  state: workflowStopStateSchema,
  detail: Schema.NullOr(Schema.String),
  requestedAt: Schema.NullOr(Schema.String),
  settledAt: Schema.NullOr(Schema.String),
});

/** The raw identifiers an operation recorded. Friendly composed targets are a later story. */
export const workflowOperationTargetSchema = Schema.Struct({
  agentSessionId: Schema.NullOr(positiveInteger),
  paneId: Schema.NullOr(positiveInteger),
  ptyProcessId: Schema.NullOr(positiveInteger),
  turnId: Schema.NullOr(nonEmptyString),
});

export type WorkflowPayloadRef = typeof workflowPayloadRefSchema.Type;
export type WorkflowPayloadSlot = typeof workflowPayloadSlotSchema.Type;
export type WorkflowPlacement = typeof workflowPlacementSchema.Type;
export type WorkflowNodeKind = typeof workflowNodeKindSchema.Type;
export type WorkflowOutcomeKind = typeof workflowOutcomeKindSchema.Type;
export type WorkflowPositionKind = typeof workflowPositionKindSchema.Type;
export type WorkflowSegmentKind = typeof workflowSegmentKindSchema.Type;
export type WorkflowAttemptStatus = typeof workflowAttemptStatusSchema.Type;
export type WorkflowFrameStatus = typeof workflowFrameStatusSchema.Type;
export type WorkflowExecutionStatus = typeof workflowExecutionStatusSchema.Type;
export type WorkflowWaitStatus = typeof workflowWaitStatusSchema.Type;
export type WorkflowFailureCode = typeof workflowFailureCodeSchema.Type;
export type WorkflowSegmentFailure = typeof workflowSegmentFailureSchema.Type;
export type WorkflowEndCertainty = typeof workflowEndCertaintySchema.Type;
export type WorkflowInvocationKind = typeof workflowInvocationKindSchema.Type;
export type WorkflowRecoveryMode = typeof workflowRecoveryModeSchema.Type;
export type WorkflowCapability = typeof workflowCapabilitySchema.Type;
export type WorkflowOperationState = typeof workflowOperationStateSchema.Type;
export type WorkflowOperationStage = typeof workflowOperationStageSchema.Type;
export type WorkflowStopState = typeof workflowStopStateSchema.Type;
export type WorkflowStopReport = typeof workflowStopReportSchema.Type;
export type WorkflowOperationTarget = typeof workflowOperationTargetSchema.Type;
export type WorkflowCommandManifestDto = typeof workflowCommandManifestSchema.Type;
export type WorkflowQuestionOptionDto = typeof workflowQuestionOptionSchema.Type;
export type WorkflowQuestionSpecDto = typeof workflowQuestionSpecSchema.Type;
export type WorkflowUiFeedbackDto = typeof workflowUiFeedbackSchema.Type;
export type WorkflowLogLevelDto = typeof workflowLogLevelSchema.Type;
export type WorkflowInputKind = typeof workflowInputKindSchema.Type;
export type WorkflowWaitKind = typeof workflowWaitKindSchema.Type;
export type WorkflowWaitId = typeof workflowWaitIdSchema.Type;
export type WorkflowUserInputAnswers = typeof workflowUserInputAnswersSchema.Type;
