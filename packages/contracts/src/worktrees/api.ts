import { worktreeBranchListApiErrorSchema, worktreeOpenApiErrorSchema } from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  listProjectBranchesOutputSchema,
  openWorktreeInputSchema,
  openWorktreeOutputSchema,
  projectWorktreeRouteParamsSchema,
} from './types.js';

export const worktreesEndpoints = {
  branches: {
    id: 'worktrees.branches',
    method: 'GET',
    path: '/projects/:projectId/branches',
    params: projectWorktreeRouteParamsSchema,
    output: listProjectBranchesOutputSchema,
    errors: worktreeBranchListApiErrorSchema,
  },
  open: {
    id: 'worktrees.open',
    method: 'POST',
    path: '/projects/:projectId/worktrees/open',
    params: projectWorktreeRouteParamsSchema,
    body: openWorktreeInputSchema,
    output: openWorktreeOutputSchema,
    errors: worktreeOpenApiErrorSchema,
  },
} as const satisfies {
  readonly branches: ApiEndpoint<
    undefined,
    typeof listProjectBranchesOutputSchema,
    typeof worktreeBranchListApiErrorSchema,
    typeof projectWorktreeRouteParamsSchema
  >;
  readonly open: ApiEndpoint<
    typeof openWorktreeInputSchema,
    typeof openWorktreeOutputSchema,
    typeof worktreeOpenApiErrorSchema,
    typeof projectWorktreeRouteParamsSchema
  >;
};
