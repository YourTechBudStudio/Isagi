import { Schema } from 'effect';

import { pagedSchema, paginationQueryFields } from './pagination.js';
import { nonEmptyString, positiveInteger } from './primitives.js';

/**
 * A run's event log: one append-only list of everything that happened to it, in id order. The same
 * rows are pushed live over the runtime events socket as `workflow_run_event`.
 *
 * `data` is plain JSON whose shape depends on `kind`: a `log` carries `{ level, message }`, a
 * `ui_feedback` carries the author's `WorkflowUiFeedback`, and environment events carry the ids and
 * output of what was created.
 */
export const workflowEventCategorySchema = Schema.Literal(
  'run',
  'environment',
  'node',
  'log',
  'ui',
);

export const workflowEventKindSchema = Schema.Literal(
  // run
  'run_launched',
  'run_paused',
  'run_resumed',
  'run_retried',
  'run_cancelled',
  'run_dismissed',
  'run_completed',
  'run_failed',
  'code_reloaded',
  'stop_failed',
  // environment
  'worktree_created',
  'setup_finished',
  'setup_failed',
  'surface_created',
  'preparation_failed',
  // node
  'graph_entered',
  'graph_completed',
  'node_started',
  'node_waiting',
  'wait_delivered',
  'node_completed',
  'node_failed',
  'node_interrupted',
  // log and ui
  'log',
  'ui_feedback',
);

export const workflowEventSchema = Schema.Struct({
  eventId: positiveInteger,
  runId: positiveInteger,
  executionId: Schema.NullOr(positiveInteger),
  at: nonEmptyString,
  category: workflowEventCategorySchema,
  kind: workflowEventKindSchema,
  message: Schema.String,
  data: Schema.Unknown,
});

export const listWorkflowEventsQuerySchema = Schema.Struct(paginationQueryFields);

export const listWorkflowEventsOutputSchema = pagedSchema(workflowEventSchema);

export type WorkflowEventCategory = typeof workflowEventCategorySchema.Type;
export type WorkflowEventKind = typeof workflowEventKindSchema.Type;
export type WorkflowEventDto = typeof workflowEventSchema.Type;
export type ListWorkflowEventsQuery = typeof listWorkflowEventsQuerySchema.Type;
export type ListWorkflowEventsOutput = typeof listWorkflowEventsOutputSchema.Type;
