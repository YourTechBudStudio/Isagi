import {
  sessionLaunchApiErrorSchema,
  surfaceApiErrorSchema,
  worktreeEnvironmentFocusApiErrorSchema,
} from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  launchAgentSessionInputSchema,
  launchSessionOutputSchema,
  setWorktreeEnvironmentFocusInputSchema,
  surfaceDetailSchema,
  surfaceRouteParamsSchema,
  worktreeEnvironmentFocusOutputSchema,
  worktreeEnvironmentFocusRouteParamsSchema,
} from './types.js';

export const surfacesEndpoints = {
  get: {
    id: 'surfaces.get',
    method: 'GET',
    path: '/surfaces/:surfaceId',
    params: surfaceRouteParamsSchema,
    output: surfaceDetailSchema,
    errors: surfaceApiErrorSchema,
  },
  setWorktreeEnvironmentFocus: {
    id: 'worktrees.setEnvironmentFocus',
    method: 'PUT',
    path: '/worktrees/:worktreeId/environment-focus',
    params: worktreeEnvironmentFocusRouteParamsSchema,
    body: setWorktreeEnvironmentFocusInputSchema,
    output: worktreeEnvironmentFocusOutputSchema,
    errors: worktreeEnvironmentFocusApiErrorSchema,
  },
  launchAgentSession: {
    id: 'worktrees.launchAgentSession',
    method: 'POST',
    path: '/worktrees/:worktreeId/agent-sessions',
    params: worktreeEnvironmentFocusRouteParamsSchema,
    body: launchAgentSessionInputSchema,
    output: launchSessionOutputSchema,
    errors: sessionLaunchApiErrorSchema,
  },
  launchTerminalSession: {
    id: 'worktrees.launchTerminalSession',
    method: 'POST',
    path: '/worktrees/:worktreeId/terminal-sessions',
    params: worktreeEnvironmentFocusRouteParamsSchema,
    output: launchSessionOutputSchema,
    errors: sessionLaunchApiErrorSchema,
  },
} as const satisfies {
  readonly get: ApiEndpoint<
    undefined,
    typeof surfaceDetailSchema,
    typeof surfaceApiErrorSchema,
    typeof surfaceRouteParamsSchema
  >;
  readonly setWorktreeEnvironmentFocus: ApiEndpoint<
    typeof setWorktreeEnvironmentFocusInputSchema,
    typeof worktreeEnvironmentFocusOutputSchema,
    typeof worktreeEnvironmentFocusApiErrorSchema,
    typeof worktreeEnvironmentFocusRouteParamsSchema
  >;
  readonly launchAgentSession: ApiEndpoint<
    typeof launchAgentSessionInputSchema,
    typeof launchSessionOutputSchema,
    typeof sessionLaunchApiErrorSchema,
    typeof worktreeEnvironmentFocusRouteParamsSchema
  >;
  readonly launchTerminalSession: ApiEndpoint<
    undefined,
    typeof launchSessionOutputSchema,
    typeof sessionLaunchApiErrorSchema,
    typeof worktreeEnvironmentFocusRouteParamsSchema
  >;
};
