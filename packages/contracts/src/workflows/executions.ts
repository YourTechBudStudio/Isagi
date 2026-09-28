import { Schema } from 'effect';

import { workflowOperationSchema } from './operations.js';
import {
  nonEmptyString,
  nonNegativeInteger,
  positiveInteger,
  workflowNodeKindSchema,
  workflowOutcomeKindSchema,
  workflowQuestionSpecSchema,
} from './primitives.js';

/**
 * Graph invocations and node executions.
 *
 * A **graph invocation** is one entry into a graph: the root graph once per run, and one per visit
 * to a subgraph node. A **node execution** is one run of one node inside an invocation. A Retry is
 * simply another execution row that points at the one it retries through `retryOf`.
 */

/**
 * Where a failure happened. Every pure step names its own stage, so "the edge threw" and "the node
 * function threw" stay distinguishable. `environment` is preparation of the run's worktree and
 * surface, before any graph runs. A node function cut off by an app restart is an `interrupted`
 * execution whose error stage is `node_function`.
 */
export const workflowErrorStageSchema = Schema.Literal(
  'environment',
  'graph_init',
  'subgraph_parameters',
  'node_function',
  'reducer',
  'edge',
  'graph_output',
  'subgraph_on_result',
  'checkpoint_prepare',
  'checkpoint_capture',
);

/**
 * `graphKey` and `nodeId` say whose code threw when a pure step failed. The failure is recorded on
 * the execution being stepped, which for a child graph's return path is the child's last execution,
 * so these can name a parent graph and node. `nodeId` names an outcome when the stage is
 * `graph_output`, and a node otherwise.
 */
export const workflowErrorSchema = Schema.Struct({
  stage: workflowErrorStageSchema,
  message: Schema.String,
  graphKey: Schema.optionalWith(nonEmptyString, { exact: true }),
  nodeId: Schema.optionalWith(nonEmptyString, { exact: true }),
});

/** A graph's terminal result. `output` is whatever the outcome produced. */
export const workflowOutcomeSchema = Schema.Struct({
  outcomeId: nonEmptyString,
  kind: workflowOutcomeKindSchema,
  reason: Schema.NullOr(Schema.String),
  output: Schema.Unknown,
});

/**
 * An invocation does not fail: failures belong to executions, and the invocation stays open so a
 * Retry can continue inside it. An authored failure outcome is `completed` with a `failure` outcome.
 */
export const workflowGraphInvocationStatusSchema = Schema.Literal(
  'running',
  'completed',
  'cancelled',
);

export const workflowExecutionStatusSchema = Schema.Literal(
  'running',
  'waiting',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
);

export const workflowGraphInvocationSchema = Schema.Struct({
  invocationId: positiveInteger,
  /** The subgraph execution that entered this graph. Null for the root invocation. */
  parentExecutionId: Schema.NullOr(positiveInteger),
  graphKey: nonEmptyString,
  depth: nonNegativeInteger,
  label: Schema.NullOr(Schema.String),
  status: workflowGraphInvocationStatusSchema,
  parameters: Schema.Unknown,
  /** The invocation's current state. Each execution's `stateAfter` holds its history. */
  state: Schema.Unknown,
  outcome: Schema.NullOr(workflowOutcomeSchema),
  startedAt: nonEmptyString,
  endedAt: Schema.NullOr(nonEmptyString),
});

/**
 * What a suspended node is waiting for, read from the result the node function returned.
 * `headless_agent` names the operations it waits on by their operation ids.
 */
export const workflowWaitSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('agent_turn'),
    target: Schema.Struct({ agentSessionId: positiveInteger, sentAt: nonEmptyString }),
  }),
  Schema.Struct({ kind: Schema.Literal('user_continue'), label: Schema.optional(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal('user_input'),
    questions: Schema.Array(workflowQuestionSpecSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal('headless_agent'),
    operations: Schema.Array(Schema.Struct({ operationId: nonEmptyString })),
  }),
);

/** One execution as the trace draws it. Everything a trace row needs, without the JSON values. */
export const workflowExecutionSummarySchema = Schema.Struct({
  executionId: positiveInteger,
  runId: positiveInteger,
  invocationId: positiveInteger,
  nodeId: nonEmptyString,
  nodeKind: workflowNodeKindSchema,
  /** Which visit to this node within its invocation, from zero. A Retry keeps the visit it retries. */
  visitIndex: nonNegativeInteger,
  label: Schema.NullOr(Schema.String),
  /** The verified build that ran this execution. */
  artifactHash: nonEmptyString,
  status: workflowExecutionStatusSchema,
  /** The failed or interrupted execution this one retries. */
  retryOf: Schema.NullOr(positiveInteger),
  /** What the node is waiting for while `waiting`, and what it waited for afterwards. */
  wait: Schema.NullOr(workflowWaitSchema),
  /** Where the edge routed: a node id or an outcome id. Null until the edge has run. */
  routedTo: Schema.NullOr(nonEmptyString),
  /** The graph invocation a subgraph execution entered. */
  childInvocationId: Schema.NullOr(positiveInteger),
  /** The checkpoint a checkpoint execution captured. */
  checkpointId: Schema.NullOr(positiveInteger),
  error: Schema.NullOr(workflowErrorSchema),
  startedAt: nonEmptyString,
  endedAt: Schema.NullOr(nonEmptyString),
});

/**
 * One execution in full: what the node returned, what came back, where the edge went, and the
 * invocation state after the step, plus every operation it performed.
 *
 * `result` is the only value the runtime ever reuses (a Retry keeps it). The rest is a record.
 */
export const workflowExecutionDetailSchema = Schema.extend(
  workflowExecutionSummarySchema,
  Schema.Struct({
    result: Schema.Unknown,
    event: Schema.Unknown,
    decision: Schema.Unknown,
    stateAfter: Schema.Unknown,
    operations: Schema.Array(workflowOperationSchema),
  }),
);

export const workflowExecutionRouteParamsSchema = Schema.Struct({
  executionId: positiveInteger,
});

export const getWorkflowExecutionOutputSchema = Schema.Struct({
  execution: workflowExecutionDetailSchema,
});

export type WorkflowErrorStage = typeof workflowErrorStageSchema.Type;
export type WorkflowErrorDto = typeof workflowErrorSchema.Type;
export type WorkflowOutcomeDto = typeof workflowOutcomeSchema.Type;
export type WorkflowGraphInvocationStatus = typeof workflowGraphInvocationStatusSchema.Type;
export type WorkflowExecutionStatus = typeof workflowExecutionStatusSchema.Type;
export type WorkflowGraphInvocationDto = typeof workflowGraphInvocationSchema.Type;
export type WorkflowWaitDto = typeof workflowWaitSchema.Type;
export type WorkflowExecutionSummaryDto = typeof workflowExecutionSummarySchema.Type;
export type WorkflowExecutionDetailDto = typeof workflowExecutionDetailSchema.Type;
export type WorkflowExecutionRouteParams = typeof workflowExecutionRouteParamsSchema.Type;
export type GetWorkflowExecutionOutput = typeof getWorkflowExecutionOutputSchema.Type;
