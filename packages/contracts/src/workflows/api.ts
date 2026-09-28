import { workflowApiErrorSchema } from '../api/errors.js';
import type { ApiContentEndpoint, ApiEndpoint } from '../api/types.js';
import {
  advanceWorkflowInputSchema,
  exportWorkflowCheckpointInputSchema,
  exportWorkflowCheckpointOutputSchema,
  getWorkflowCheckpointOutputSchema,
  getWorkflowExecutionOutputSchema,
  getWorkflowOperationOutputSchema,
  getWorkflowRunOutputSchema,
  getWorkflowStructureOutputSchema,
  getWorkflowStructureQuerySchema,
  listWorkflowCheckpointsOutputSchema,
  listWorkflowCheckpointsQuerySchema,
  listWorkflowDescriptorsInputSchema,
  listWorkflowDescriptorsOutputSchema,
  listWorkflowEventsOutputSchema,
  listWorkflowEventsQuerySchema,
  listWorkflowOperationsOutputSchema,
  listWorkflowOperationsQuerySchema,
  listWorkflowRunsOutputSchema,
  listWorkflowRunsQuerySchema,
  startWorkflowInputSchema,
  startWorkflowOutputSchema,
  workflowCheckpointFileQuerySchema,
  workflowCheckpointRouteParamsSchema,
  workflowExecutionRouteParamsSchema,
  workflowOperationRouteParamsSchema,
  workflowRunControlOutputSchema,
  workflowRunRouteParamsSchema,
} from './types.js';

/**
 * The workflow read and control surface. Live changes reach clients on the shared runtime event
 * socket (`workflow_run_changed` and `workflow_run_event`); these routes are the source of truth a
 * client refetches from.
 */
export const workflowsEndpoints = {
  descriptors: {
    id: 'workflows.descriptors',
    method: 'POST',
    path: '/workflows/descriptors',
    body: listWorkflowDescriptorsInputSchema,
    output: listWorkflowDescriptorsOutputSchema,
    errors: workflowApiErrorSchema,
  },
  start: {
    id: 'workflows.start',
    method: 'POST',
    path: '/workflows/runs',
    body: startWorkflowInputSchema,
    output: startWorkflowOutputSchema,
    errors: workflowApiErrorSchema,
  },
  listRuns: {
    id: 'workflows.listRuns',
    method: 'GET',
    path: '/workflows/runs',
    query: listWorkflowRunsQuerySchema,
    output: listWorkflowRunsOutputSchema,
    errors: workflowApiErrorSchema,
  },
  /** The run summary with every graph invocation and execution. */
  getRun: {
    id: 'workflows.getRun',
    method: 'GET',
    path: '/workflows/runs/:runId',
    params: workflowRunRouteParamsSchema,
    output: getWorkflowRunOutputSchema,
    errors: workflowApiErrorSchema,
  },
  getStructure: {
    id: 'workflows.getStructure',
    method: 'GET',
    path: '/workflows/runs/:runId/structure',
    params: workflowRunRouteParamsSchema,
    query: getWorkflowStructureQuerySchema,
    output: getWorkflowStructureOutputSchema,
    errors: workflowApiErrorSchema,
  },
  listEvents: {
    id: 'workflows.listEvents',
    method: 'GET',
    path: '/workflows/runs/:runId/events',
    params: workflowRunRouteParamsSchema,
    query: listWorkflowEventsQuerySchema,
    output: listWorkflowEventsOutputSchema,
    errors: workflowApiErrorSchema,
  },
  listOperations: {
    id: 'workflows.listOperations',
    method: 'GET',
    path: '/workflows/runs/:runId/operations',
    params: workflowRunRouteParamsSchema,
    query: listWorkflowOperationsQuerySchema,
    output: listWorkflowOperationsOutputSchema,
    errors: workflowApiErrorSchema,
  },
  listCheckpoints: {
    id: 'workflows.listCheckpoints',
    method: 'GET',
    path: '/workflows/runs/:runId/checkpoints',
    params: workflowRunRouteParamsSchema,
    query: listWorkflowCheckpointsQuerySchema,
    output: listWorkflowCheckpointsOutputSchema,
    errors: workflowApiErrorSchema,
  },
  getExecution: {
    id: 'workflows.getExecution',
    method: 'GET',
    path: '/workflows/executions/:executionId',
    params: workflowExecutionRouteParamsSchema,
    output: getWorkflowExecutionOutputSchema,
    errors: workflowApiErrorSchema,
  },
  getOperation: {
    id: 'workflows.getOperation',
    method: 'GET',
    path: '/workflows/operations/:operationId',
    params: workflowOperationRouteParamsSchema,
    output: getWorkflowOperationOutputSchema,
    errors: workflowApiErrorSchema,
  },
  getCheckpoint: {
    id: 'workflows.getCheckpoint',
    method: 'GET',
    path: '/workflows/checkpoints/:checkpointId',
    params: workflowCheckpointRouteParamsSchema,
    output: getWorkflowCheckpointOutputSchema,
    errors: workflowApiErrorSchema,
  },
  /** Rebuilds the checkpoint in a new folder the caller names. */
  exportCheckpoint: {
    id: 'workflows.exportCheckpoint',
    method: 'POST',
    path: '/workflows/checkpoints/:checkpointId/export',
    params: workflowCheckpointRouteParamsSchema,
    body: exportWorkflowCheckpointInputSchema,
    output: exportWorkflowCheckpointOutputSchema,
    errors: workflowApiErrorSchema,
  },
  pause: {
    id: 'workflows.pause',
    method: 'POST',
    path: '/workflows/runs/:runId/pause',
    params: workflowRunRouteParamsSchema,
    output: workflowRunControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
  /** Reloads the latest verified build, then continues where the run is parked. */
  resume: {
    id: 'workflows.resume',
    method: 'POST',
    path: '/workflows/runs/:runId/resume',
    params: workflowRunRouteParamsSchema,
    output: workflowRunControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
  /** Reloads the latest verified build, then retries the failed or interrupted execution. */
  retry: {
    id: 'workflows.retry',
    method: 'POST',
    path: '/workflows/runs/:runId/retry',
    params: workflowRunRouteParamsSchema,
    output: workflowRunControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
  /** Stops the run and, best effort, its running headless processes. Agent panes stay open. */
  cancel: {
    id: 'workflows.cancel',
    method: 'POST',
    path: '/workflows/runs/:runId/cancel',
    params: workflowRunRouteParamsSchema,
    output: workflowRunControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
  /** Detaches a finished or cancelled run from its surface. The run stays listed and inspectable. */
  dismiss: {
    id: 'workflows.dismiss',
    method: 'POST',
    path: '/workflows/runs/:runId/dismiss',
    params: workflowRunRouteParamsSchema,
    output: workflowRunControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
  /** Answers a `user_continue` or `user_input` wait. */
  advance: {
    id: 'workflows.advance',
    method: 'POST',
    path: '/workflows/runs/:runId/advance',
    params: workflowRunRouteParamsSchema,
    body: advanceWorkflowInputSchema,
    output: workflowRunControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
  // `satisfies` keeps the declaration-site check that every entry is a legal endpoint without
  // restating each endpoint's generic arguments.
} as const satisfies Record<string, ApiEndpoint<any, any, any, any, any>>;

/**
 * Content routes return a byte stream rather than JSON, so they have no `output` schema and live
 * beside `workflowsEndpoints` instead of inside it.
 */
export const workflowContentEndpoints = {
  getCheckpointFile: {
    id: 'workflows.getCheckpointFile',
    method: 'GET',
    path: '/workflows/checkpoints/:checkpointId/file',
    params: workflowCheckpointRouteParamsSchema,
    query: workflowCheckpointFileQuerySchema,
    errors: workflowApiErrorSchema,
  },
} as const satisfies Record<string, ApiContentEndpoint<any, any, any>>;
