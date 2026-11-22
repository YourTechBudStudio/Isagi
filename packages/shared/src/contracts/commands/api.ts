import { worktreeCommandsApiErrorSchema } from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  commandLogStreamOutputMessageSchema,
  commandActionOutputSchema,
  commandLogMetadataOutputSchema,
  worktreeCommandActionInputSchema,
  worktreeCommandQuerySchema,
  worktreeCommandsOutputSchema,
  worktreeCommandsRouteParamsSchema,
} from './types.js';

export const commandLogStreamWebSocketEndpoint = {
  id: 'commands.logStream',
  path: '/worktrees/:worktreeId/commands/log-stream',
  params: worktreeCommandsRouteParamsSchema,
  query: worktreeCommandQuerySchema,
  serverMessages: commandLogStreamOutputMessageSchema,
} as const;

export const commandsEndpoints = {
  listForWorktree: {
    id: 'commands.listForWorktree',
    method: 'GET',
    path: '/worktrees/:worktreeId/commands',
    params: worktreeCommandsRouteParamsSchema,
    output: worktreeCommandsOutputSchema,
    errors: worktreeCommandsApiErrorSchema,
  },
  logMetadata: {
    id: 'commands.logMetadata',
    method: 'GET',
    path: '/worktrees/:worktreeId/commands/log-metadata',
    params: worktreeCommandsRouteParamsSchema,
    query: worktreeCommandQuerySchema,
    output: commandLogMetadataOutputSchema,
    errors: worktreeCommandsApiErrorSchema,
  },
  run: {
    id: 'commands.run',
    method: 'POST',
    path: '/worktrees/:worktreeId/commands/run',
    params: worktreeCommandsRouteParamsSchema,
    body: worktreeCommandActionInputSchema,
    output: commandActionOutputSchema,
    errors: worktreeCommandsApiErrorSchema,
  },
  stop: {
    id: 'commands.stop',
    method: 'POST',
    path: '/worktrees/:worktreeId/commands/stop',
    params: worktreeCommandsRouteParamsSchema,
    body: worktreeCommandActionInputSchema,
    output: commandActionOutputSchema,
    errors: worktreeCommandsApiErrorSchema,
  },
  restart: {
    id: 'commands.restart',
    method: 'POST',
    path: '/worktrees/:worktreeId/commands/restart',
    params: worktreeCommandsRouteParamsSchema,
    body: worktreeCommandActionInputSchema,
    output: commandActionOutputSchema,
    errors: worktreeCommandsApiErrorSchema,
  },
} as const satisfies {
  readonly listForWorktree: ApiEndpoint<
    undefined,
    typeof worktreeCommandsOutputSchema,
    typeof worktreeCommandsApiErrorSchema,
    typeof worktreeCommandsRouteParamsSchema
  >;
  readonly logMetadata: ApiEndpoint<
    undefined,
    typeof commandLogMetadataOutputSchema,
    typeof worktreeCommandsApiErrorSchema,
    typeof worktreeCommandsRouteParamsSchema,
    typeof worktreeCommandQuerySchema
  >;
  readonly run: ApiEndpoint<
    typeof worktreeCommandActionInputSchema,
    typeof commandActionOutputSchema,
    typeof worktreeCommandsApiErrorSchema,
    typeof worktreeCommandsRouteParamsSchema
  >;
  readonly stop: ApiEndpoint<
    typeof worktreeCommandActionInputSchema,
    typeof commandActionOutputSchema,
    typeof worktreeCommandsApiErrorSchema,
    typeof worktreeCommandsRouteParamsSchema
  >;
  readonly restart: ApiEndpoint<
    typeof worktreeCommandActionInputSchema,
    typeof commandActionOutputSchema,
    typeof worktreeCommandsApiErrorSchema,
    typeof worktreeCommandsRouteParamsSchema
  >;
};
