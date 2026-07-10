import { workflowApiErrorSchema } from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  advanceWorkflowInputSchema,
  getWorkflowRunOutputSchema,
  listWorkflowDescriptorsInputSchema,
  listWorkflowDescriptorsOutputSchema,
  listWorkflowRunsOutputSchema,
  listWorkflowRunsQuerySchema,
  startWorkflowInputSchema,
  startWorkflowOutputSchema,
  workflowEventsQuerySchema,
  workflowEventsReplayOutputSchema,
  workflowEventsStreamInputMessageSchema,
  workflowEventsStreamOutputMessageSchema,
  workflowRunControlOutputSchema,
  workflowRunRouteParamsSchema,
} from './types.js';

export const workflowEventsStreamWebSocketEndpoint = {
  id: 'workflows.eventsStream',
  path: '/workflows/runs/:runId/events-stream',
  params: workflowRunRouteParamsSchema,
  query: workflowEventsQuerySchema,
  clientMessages: workflowEventsStreamInputMessageSchema,
  serverMessages: workflowEventsStreamOutputMessageSchema,
} as const;

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
  getRun: {
    id: 'workflows.getRun',
    method: 'GET',
    path: '/workflows/runs/:runId',
    params: workflowRunRouteParamsSchema,
    output: getWorkflowRunOutputSchema,
    errors: workflowApiErrorSchema,
  },
  runEvents: {
    id: 'workflows.runEvents',
    method: 'GET',
    path: '/workflows/runs/:runId/events',
    params: workflowRunRouteParamsSchema,
    query: workflowEventsQuerySchema,
    output: workflowEventsReplayOutputSchema,
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
  resume: {
    id: 'workflows.resume',
    method: 'POST',
    path: '/workflows/runs/:runId/resume',
    params: workflowRunRouteParamsSchema,
    output: workflowRunControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
  clear: {
    id: 'workflows.clear',
    method: 'POST',
    path: '/workflows/runs/:runId/clear',
    params: workflowRunRouteParamsSchema,
    output: workflowRunControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
  retry: {
    id: 'workflows.retry',
    method: 'POST',
    path: '/workflows/runs/:runId/retry',
    params: workflowRunRouteParamsSchema,
    output: workflowRunControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
  advance: {
    id: 'workflows.advance',
    method: 'POST',
    path: '/workflows/runs/:runId/advance',
    params: workflowRunRouteParamsSchema,
    body: advanceWorkflowInputSchema,
    output: workflowRunControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
} as const satisfies {
  readonly descriptors: ApiEndpoint<
    typeof listWorkflowDescriptorsInputSchema,
    typeof listWorkflowDescriptorsOutputSchema,
    typeof workflowApiErrorSchema
  >;
  readonly start: ApiEndpoint<
    typeof startWorkflowInputSchema,
    typeof startWorkflowOutputSchema,
    typeof workflowApiErrorSchema
  >;
  readonly listRuns: ApiEndpoint<
    undefined,
    typeof listWorkflowRunsOutputSchema,
    typeof workflowApiErrorSchema,
    undefined,
    typeof listWorkflowRunsQuerySchema
  >;
  readonly getRun: ApiEndpoint<
    undefined,
    typeof getWorkflowRunOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowRunRouteParamsSchema
  >;
  readonly runEvents: ApiEndpoint<
    undefined,
    typeof workflowEventsReplayOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowRunRouteParamsSchema,
    typeof workflowEventsQuerySchema
  >;
  readonly pause: ApiEndpoint<
    undefined,
    typeof workflowRunControlOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowRunRouteParamsSchema
  >;
  readonly resume: ApiEndpoint<
    undefined,
    typeof workflowRunControlOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowRunRouteParamsSchema
  >;
  readonly clear: ApiEndpoint<
    undefined,
    typeof workflowRunControlOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowRunRouteParamsSchema
  >;
  readonly retry: ApiEndpoint<
    undefined,
    typeof workflowRunControlOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowRunRouteParamsSchema
  >;
  readonly advance: ApiEndpoint<
    typeof advanceWorkflowInputSchema,
    typeof workflowRunControlOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowRunRouteParamsSchema
  >;
};
