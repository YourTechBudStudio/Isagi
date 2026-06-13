import {
  sessionLaunchApiErrorSchema,
  surfaceApiErrorSchema,
  worktreeEnvironmentFocusApiErrorSchema,
} from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  deleteSurfaceOutputSchema,
  launchAgentSessionInputSchema,
  ptySessionRouteParamsSchema,
  ptyWebSocketInputMessageSchema,
  ptyWebSocketOutputMessageSchema,
  launchSessionOutputSchema,
  renameSurfaceInputSchema,
  renameSurfaceOutputSchema,
  setWorktreeEnvironmentFocusInputSchema,
  surfaceDetailSchema,
  surfacePaneRouteParamsSchema,
  surfaceRouteParamsSchema,
  worktreeEnvironmentFocusOutputSchema,
  worktreeEnvironmentFocusRouteParamsSchema,
} from './types.js';

export const ptySessionWebSocketEndpoint = {
  id: 'ptySessions.attach',
  path: '/pty-sessions/:ptySessionId',
  params: ptySessionRouteParamsSchema,
  clientMessages: ptyWebSocketInputMessageSchema,
  serverMessages: ptyWebSocketOutputMessageSchema,
} as const;

export const surfacesEndpoints = {
  get: {
    id: 'surfaces.get',
    method: 'GET',
    path: '/surfaces/:surfaceId',
    params: surfaceRouteParamsSchema,
    output: surfaceDetailSchema,
    errors: surfaceApiErrorSchema,
  },
  rename: {
    id: 'surfaces.rename',
    method: 'PUT',
    path: '/surfaces/:surfaceId/title',
    params: surfaceRouteParamsSchema,
    body: renameSurfaceInputSchema,
    output: renameSurfaceOutputSchema,
    errors: surfaceApiErrorSchema,
  },
  delete: {
    id: 'surfaces.delete',
    method: 'DELETE',
    path: '/surfaces/:surfaceId',
    params: surfaceRouteParamsSchema,
    output: deleteSurfaceOutputSchema,
    errors: surfaceApiErrorSchema,
  },
  deletePane: {
    id: 'surfaces.deletePane',
    method: 'DELETE',
    path: '/surfaces/:surfaceId/panes/:paneId',
    params: surfacePaneRouteParamsSchema,
    output: deleteSurfaceOutputSchema,
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
  readonly rename: ApiEndpoint<
    typeof renameSurfaceInputSchema,
    typeof renameSurfaceOutputSchema,
    typeof surfaceApiErrorSchema,
    typeof surfaceRouteParamsSchema
  >;
  readonly delete: ApiEndpoint<
    undefined,
    typeof deleteSurfaceOutputSchema,
    typeof surfaceApiErrorSchema,
    typeof surfaceRouteParamsSchema
  >;
  readonly deletePane: ApiEndpoint<
    undefined,
    typeof deleteSurfaceOutputSchema,
    typeof surfaceApiErrorSchema,
    typeof surfacePaneRouteParamsSchema
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
