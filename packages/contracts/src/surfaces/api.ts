import { surfaceApiErrorSchema, worktreeEnvironmentFocusApiErrorSchema } from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  agentSessionRouteParamsSchema,
  createSurfaceInputSchema,
  createSurfaceOutputSchema,
  deleteSurfaceOutputSchema,
  paneSessionClaimInputSchema,
  paneSessionClaimOutputSchema,
  ptyWebSocketInputMessageSchema,
  ptyWebSocketOutputMessageSchema,
  renameSurfaceInputSchema,
  renameSurfaceOutputSchema,
  setWorktreeEnvironmentFocusInputSchema,
  surfaceDetailSchema,
  surfacePaneRouteParamsSchema,
  surfaceRouteParamsSchema,
  terminalSessionRouteParamsSchema,
  worktreeEnvironmentFocusOutputSchema,
  worktreeEnvironmentFocusRouteParamsSchema,
} from './types.js';

export const agentSessionPtyWebSocketEndpoint = {
  id: 'agentSessions.attachPty',
  path: '/agent-sessions/:agentSessionId/attach',
  params: agentSessionRouteParamsSchema,
  clientMessages: ptyWebSocketInputMessageSchema,
  serverMessages: ptyWebSocketOutputMessageSchema,
} as const;

export const terminalSessionPtyWebSocketEndpoint = {
  id: 'terminalSessions.attachPty',
  path: '/terminal-sessions/:terminalSessionId/attach',
  params: terminalSessionRouteParamsSchema,
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
  createSurface: {
    id: 'worktrees.createSurface',
    method: 'POST',
    path: '/worktrees/:worktreeId/surfaces',
    params: worktreeEnvironmentFocusRouteParamsSchema,
    body: createSurfaceInputSchema,
    output: createSurfaceOutputSchema,
    errors: surfaceApiErrorSchema,
  },
  claimPaneSession: {
    id: 'worktrees.claimPaneSession',
    method: 'POST',
    path: '/worktrees/:worktreeId/pane-session-claims',
    params: worktreeEnvironmentFocusRouteParamsSchema,
    body: paneSessionClaimInputSchema,
    output: paneSessionClaimOutputSchema,
    errors: surfaceApiErrorSchema,
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
  readonly createSurface: ApiEndpoint<
    typeof createSurfaceInputSchema,
    typeof createSurfaceOutputSchema,
    typeof surfaceApiErrorSchema,
    typeof worktreeEnvironmentFocusRouteParamsSchema
  >;
  readonly claimPaneSession: ApiEndpoint<
    typeof paneSessionClaimInputSchema,
    typeof paneSessionClaimOutputSchema,
    typeof surfaceApiErrorSchema,
    typeof worktreeEnvironmentFocusRouteParamsSchema
  >;
};
