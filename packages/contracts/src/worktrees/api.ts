import {
  worktreeBranchListApiErrorSchema,
  worktreeOpenApiErrorSchema,
  worktreeSetupApiErrorSchema,
} from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  listProjectBranchesOutputSchema,
  openWorktreeInputSchema,
  openWorktreeOutputSchema,
  projectWorktreeRouteParamsSchema,
  worktreeSetupPreflightOutputSchema,
  worktreeSetupTrustInputSchema,
  worktreeSetupTrustOutputSchema,
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
  setupPreflight: {
    id: 'worktrees.setupPreflight',
    method: 'POST',
    path: '/projects/:projectId/worktrees/setup/preflight',
    params: projectWorktreeRouteParamsSchema,
    output: worktreeSetupPreflightOutputSchema,
    errors: worktreeSetupApiErrorSchema,
  },
  setupTrust: {
    id: 'worktrees.setupTrust',
    method: 'PUT',
    path: '/projects/:projectId/worktrees/setup/trust',
    params: projectWorktreeRouteParamsSchema,
    body: worktreeSetupTrustInputSchema,
    output: worktreeSetupTrustOutputSchema,
    errors: worktreeSetupApiErrorSchema,
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
  readonly setupPreflight: ApiEndpoint<
    undefined,
    typeof worktreeSetupPreflightOutputSchema,
    typeof worktreeSetupApiErrorSchema,
    typeof projectWorktreeRouteParamsSchema
  >;
  readonly setupTrust: ApiEndpoint<
    typeof worktreeSetupTrustInputSchema,
    typeof worktreeSetupTrustOutputSchema,
    typeof worktreeSetupApiErrorSchema,
    typeof projectWorktreeRouteParamsSchema
  >;
  readonly open: ApiEndpoint<
    typeof openWorktreeInputSchema,
    typeof openWorktreeOutputSchema,
    typeof worktreeOpenApiErrorSchema,
    typeof projectWorktreeRouteParamsSchema
  >;
};
