import { workflowApiErrorSchema } from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  advanceWorkflowInputSchema,
  listWorkflowDescriptorsInputSchema,
  listWorkflowDescriptorsOutputSchema,
  setWorkflowPausedInputSchema,
  startWorkflowInputSchema,
  startWorkflowOutputSchema,
  workflowEventsReplayOutputSchema,
  workflowEventsStreamInputMessageSchema,
  workflowEventsStreamOutputMessageSchema,
  workflowRunControlOutputSchema,
  workflowRunRouteParamsSchema,
  workflowSurfaceControlOutputSchema,
  workflowSurfaceRouteParamsSchema,
} from './types.js';

export const workflowEventsStreamWebSocketEndpoint = {
  id: 'workflows.eventsStream',
  path: '/workflows/surfaces/:surfaceId/events-stream',
  params: workflowSurfaceRouteParamsSchema,
  clientMessages: workflowEventsStreamInputMessageSchema,
  serverMessages: workflowEventsStreamOutputMessageSchema,
} as const;

export const workflowsEndpoints = {
  list: {
    id: 'workflows.list',
    method: 'POST',
    path: '/workflows/list',
    body: listWorkflowDescriptorsInputSchema,
    output: listWorkflowDescriptorsOutputSchema,
    errors: workflowApiErrorSchema,
  },
  start: {
    id: 'workflows.start',
    method: 'POST',
    path: '/workflows/start',
    body: startWorkflowInputSchema,
    output: startWorkflowOutputSchema,
    errors: workflowApiErrorSchema,
  },
  surfaceEvents: {
    id: 'workflows.surfaceEvents',
    method: 'GET',
    path: '/workflows/surfaces/:surfaceId/events',
    params: workflowSurfaceRouteParamsSchema,
    output: workflowEventsReplayOutputSchema,
    errors: workflowApiErrorSchema,
  },
  setPaused: {
    id: 'workflows.setPaused',
    method: 'POST',
    path: '/workflows/surfaces/:surfaceId/set-paused',
    params: workflowSurfaceRouteParamsSchema,
    body: setWorkflowPausedInputSchema,
    output: workflowSurfaceControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
  clear: {
    id: 'workflows.clear',
    method: 'POST',
    path: '/workflows/surfaces/:surfaceId/clear',
    params: workflowSurfaceRouteParamsSchema,
    output: workflowSurfaceControlOutputSchema,
    errors: workflowApiErrorSchema,
  },
  retry: {
    id: 'workflows.retry',
    method: 'POST',
    path: '/workflows/surfaces/:surfaceId/retry',
    params: workflowSurfaceRouteParamsSchema,
    output: workflowSurfaceControlOutputSchema,
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
  readonly list: ApiEndpoint<
    typeof listWorkflowDescriptorsInputSchema,
    typeof listWorkflowDescriptorsOutputSchema,
    typeof workflowApiErrorSchema
  >;
  readonly start: ApiEndpoint<
    typeof startWorkflowInputSchema,
    typeof startWorkflowOutputSchema,
    typeof workflowApiErrorSchema
  >;
  readonly surfaceEvents: ApiEndpoint<
    undefined,
    typeof workflowEventsReplayOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowSurfaceRouteParamsSchema
  >;
  readonly setPaused: ApiEndpoint<
    typeof setWorkflowPausedInputSchema,
    typeof workflowSurfaceControlOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowSurfaceRouteParamsSchema
  >;
  readonly clear: ApiEndpoint<
    undefined,
    typeof workflowSurfaceControlOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowSurfaceRouteParamsSchema
  >;
  readonly retry: ApiEndpoint<
    undefined,
    typeof workflowSurfaceControlOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowSurfaceRouteParamsSchema
  >;
  readonly advance: ApiEndpoint<
    typeof advanceWorkflowInputSchema,
    typeof workflowRunControlOutputSchema,
    typeof workflowApiErrorSchema,
    typeof workflowRunRouteParamsSchema
  >;
};
