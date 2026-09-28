import { Schema } from 'effect';

import { agentHarnessSchema } from '../surfaces/types.js';
import { pagedSchema, paginationQueryFields } from './pagination.js';
import { nonEmptyString, nonNegativeInteger, positiveInteger } from './primitives.js';

/**
 * The operation log: one row per side-effecting `ctx` call a node function made.
 *
 * It is a plain history of what was asked and what came back. The runtime never consults it to skip
 * work, so a Retry that runs a node function again logs new rows.
 */

export const workflowOperationKindSchema = Schema.Literal(
  'spawn_agent',
  'send_prompt',
  'run_headless',
  'close_pane',
);

/** `interrupted`: the runtime restarted or the run was cancelled while the operation was running. */
export const workflowOperationStatusSchema = Schema.Literal(
  'running',
  'completed',
  'failed',
  'interrupted',
);

/**
 * What a provider reported about the work it did, read verbatim. Every field is the provider's own
 * number, so no total is computed: Claude reports cache reads and writes separately from the bare
 * uncached input, and `costUsd` is the one figure that already reflects caching.
 */
export const workflowOperationUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Number),
  cacheReadInputTokens: Schema.NullOr(Schema.Number),
  cacheCreationInputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
});

export const workflowOperationSchema = Schema.Struct({
  operationId: positiveInteger,
  runId: positiveInteger,
  executionId: positiveInteger,
  /** Order within its execution, from zero. Across a run, operations are ordered by id. */
  seq: nonNegativeInteger,
  kind: workflowOperationKindSchema,
  agentSessionId: Schema.NullOr(positiveInteger),
  paneId: Schema.NullOr(positiveInteger),
  harness: Schema.NullOr(agentHarnessSchema),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  /** The request as sent, including the full prompt text. */
  request: Schema.Unknown,
  status: workflowOperationStatusSchema,
  /**
   * What the agent said: for a prompt, the last assistant text of the turn it started; for a
   * headless run, its output. Null while running, or when the reply could not be read.
   */
  responseText: Schema.NullOr(Schema.String),
  /** The call's structured result, such as a spawned session's handle or a headless exit. */
  result: Schema.Unknown,
  harnessSessionId: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(workflowOperationUsageSchema),
  startedAt: nonEmptyString,
  endedAt: Schema.NullOr(nonEmptyString),
});

export const workflowOperationRouteParamsSchema = Schema.Struct({ operationId: positiveInteger });

export const getWorkflowOperationOutputSchema = Schema.Struct({
  operation: workflowOperationSchema,
});

/** A run's operations in id order: its dialogue. Filters narrow it to one session or execution. */
export const listWorkflowOperationsQuerySchema = Schema.Struct({
  ...paginationQueryFields,
  agentSessionId: Schema.optional(positiveInteger),
  executionId: Schema.optional(positiveInteger),
});

export const listWorkflowOperationsOutputSchema = pagedSchema(workflowOperationSchema);

export type WorkflowOperationKind = typeof workflowOperationKindSchema.Type;
export type WorkflowOperationStatus = typeof workflowOperationStatusSchema.Type;
export type WorkflowOperationUsage = typeof workflowOperationUsageSchema.Type;
export type WorkflowOperationDto = typeof workflowOperationSchema.Type;
export type WorkflowOperationRouteParams = typeof workflowOperationRouteParamsSchema.Type;
export type GetWorkflowOperationOutput = typeof getWorkflowOperationOutputSchema.Type;
export type ListWorkflowOperationsQuery = typeof listWorkflowOperationsQuerySchema.Type;
export type ListWorkflowOperationsOutput = typeof listWorkflowOperationsOutputSchema.Type;
