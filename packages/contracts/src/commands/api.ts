import { worktreeCommandsApiErrorSchema } from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import { worktreeCommandsOutputSchema, worktreeCommandsRouteParamsSchema } from './types.js';

export const commandsEndpoints = {
  listForWorktree: {
    id: 'commands.listForWorktree',
    method: 'GET',
    path: '/worktrees/:worktreeId/commands',
    params: worktreeCommandsRouteParamsSchema,
    output: worktreeCommandsOutputSchema,
    errors: worktreeCommandsApiErrorSchema,
  },
} as const satisfies {
  readonly listForWorktree: ApiEndpoint<
    undefined,
    typeof worktreeCommandsOutputSchema,
    typeof worktreeCommandsApiErrorSchema,
    typeof worktreeCommandsRouteParamsSchema
  >;
};
