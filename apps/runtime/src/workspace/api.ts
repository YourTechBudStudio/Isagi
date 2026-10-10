import { Effect, type Layer } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiEndpoints,
  type WorkspaceActiveContextRejectionReason,
  type WorktreeDeleteRejectionReason,
  type WorktreeOperationRejectionReason,
  type WorktreeSetupRejectionReason,
} from '@isagi/contracts';

import { registerApiEndpoint, type RouteRuntime } from '../platform/http/index.js';
import type { ProjectConfigError } from '../projects/index.js';
import { workspaceRejections } from './api-errors.js';
import {
  activeContextReasons,
  projectDeleteReasons,
  projectOperationReasons,
  reconcileReasons,
  relocationReasons,
  setupProjectReasons,
  withReason,
  worktreeDeleteReasons,
  worktreeOperationReasons,
} from './api-reasons.js';
import type { WorkspaceError } from './errors.js';
import type { WorkspaceLayer } from './layer.js';
import { registerPathsApi } from './path-suggestions-api.js';
import { WorkspaceService } from './service.js';
import type { WorktreeSetupError } from './setup/service.js';

/** The workspace module's routes: projects, worktrees, the workspace snapshot and path suggestions. */
export function registerWorkspaceRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<Layer.Success<typeof WorkspaceLayer>>,
) {
  registerWorkspaceApi(fastify, runtime);
  registerPathsApi(fastify, runtime);
}

/**
 * Each endpoint maps the failures of its one service method next to it (arch §2.2). The service methods share one
 * declared failure union, so every endpoint names every tag in it: a tag the endpoint's contract describes becomes that
 * rejection, and a tag its method never produces dies (`notProduced`), which the request pipeline answers as
 * `api_unhandled_error`. Git, database and data-directory failures the contract declares pass through to the platform
 * mapping.
 */
export function registerWorkspaceApi(
  fastify: FastifyInstance,
  runtime: RouteRuntime<WorkspaceService>,
) {
  registerApiEndpoint(fastify, runtime, apiEndpoints.workspace.get, (request) =>
    WorkspaceService.use((workspace) => workspace.get).pipe(
      Effect.catchTags({
        StateFileError: (error) => request.reject(workspaceRejections.stateFile(error)),
        ProjectConfigError: notProduced,
        ProjectPathValidationError: notProduced,
        WorktreeSetupError: notProduced,
        WorkspaceError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.workspace.durableSessions, (request) =>
    WorkspaceService.use((workspace) => workspace.durableSessions).pipe(
      Effect.catchTags({
        StateFileError: (error) => request.reject(workspaceRejections.stateFile(error)),
        ProjectConfigError: notProduced,
        ProjectPathValidationError: notProduced,
        WorktreeSetupError: notProduced,
        WorkspaceError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.workspace.getActiveContext, (request) =>
    WorkspaceService.use((workspace) => workspace.getActiveContext).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(activeContextReasons, error, (reason) =>
            request.reject(activeContextRejection(error, reason)),
          ),
        StateFileError: (error) => request.reject(workspaceRejections.stateFile(error)),
        ProjectConfigError: notProduced,
        ProjectPathValidationError: notProduced,
        WorktreeSetupError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.workspace.setActiveContext, (request) =>
    WorkspaceService.use((workspace) => workspace.setActiveContext(request.body)).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(activeContextReasons, error, (reason) =>
            request.reject(activeContextRejection(error, reason)),
          ),
        StateFileError: (error) => request.reject(workspaceRejections.stateFile(error)),
        ProjectConfigError: notProduced,
        ProjectPathValidationError: notProduced,
        WorktreeSetupError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.workspace.reconcile, (request) =>
    WorkspaceService.use((workspace) => workspace.reconcileWorkspace(request.body)).pipe(
      Effect.catchTags({
        // The contract requires the project, and every reconcile rejection names the one it was about.
        WorkspaceError: (error) =>
          withReason(reconcileReasons, error, (reason) =>
            error.projectId === undefined
              ? Effect.die(error)
              : request.reject({
                  code: 'workspace_reconcile_rejected',
                  status: 400,
                  message: error.message,
                  data: { reason, projectId: error.projectId },
                }),
          ),
        StateFileError: notProduced,
        ProjectConfigError: notProduced,
        ProjectPathValidationError: notProduced,
        WorktreeSetupError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.projects.add, (request) =>
    WorkspaceService.use((workspace) => workspace.registerProject(request.body)).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(projectOperationReasons, error, (reason) =>
            request.reject({
              code: 'project_operation_rejected',
              status: 400,
              message: error.message,
              data: { reason, ...projectAndWorktree(error) },
            }),
          ),
        StateFileError: (error) => request.reject(workspaceRejections.stateFile(error)),
        ProjectConfigError: notProduced,
        WorktreeSetupError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.projects.relocate, (request) =>
    WorkspaceService.use((workspace) =>
      workspace.relocateProject({ projectId: request.params.projectId, path: request.body.path }),
    ).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(relocationReasons, error, (reason) =>
            request.reject({
              code: 'project_relocation_rejected',
              status: error.code === 'project_path_already_registered' ? 409 : 400,
              message: error.message,
              data: {
                reason,
                projectId: request.params.projectId,
                ...(error.path ? { path: error.path } : {}),
                ...(error.conflictingProjectId
                  ? { conflictingProjectId: error.conflictingProjectId }
                  : {}),
              },
            }),
          ),
        StateFileError: notProduced,
        ProjectConfigError: notProduced,
        WorktreeSetupError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.projects.delete, (request) =>
    WorkspaceService.use((workspace) => workspace.deleteProject(request.params.projectId)).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(projectDeleteReasons, error, (reason) =>
            request.reject({
              code: 'project_delete_rejected',
              status: 400,
              message: error.message,
              data: { reason, ...projectAndWorktree(error) },
            }),
          ),
        GitCommandError: notProduced,
        StateFileError: notProduced,
        ProjectConfigError: notProduced,
        ProjectPathValidationError: notProduced,
        WorktreeSetupError: notProduced,
      }),
    ),
  );

  // The reorder rejections already carry their contract reason, so they map straight through.
  registerApiEndpoint(fastify, runtime, apiEndpoints.projects.moveOrder, (request) =>
    WorkspaceService.use((workspace) =>
      workspace.moveProjectOrder({
        projectId: request.params.projectId,
        beforeProjectId: request.body.beforeProjectId,
      }),
    ).pipe(
      Effect.catchTags({
        ProjectOrderError: (error) =>
          request.reject({
            code: 'project_order_rejected',
            status: 400,
            message: error.message,
            data: {
              reason: error.reason,
              projectId: error.projectId,
              ...(error.beforeProjectId ? { beforeProjectId: error.beforeProjectId } : {}),
            },
          }),
        GitCommandError: notProduced,
        StateFileError: notProduced,
        ProjectConfigError: notProduced,
        ProjectPathValidationError: notProduced,
        WorktreeSetupError: notProduced,
        WorkspaceError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.worktrees.moveOrder, (request) =>
    WorkspaceService.use((workspace) =>
      workspace.moveWorktreeOrder({
        projectId: request.params.projectId,
        worktreeId: request.params.worktreeId,
        beforeWorktreeId: request.body.beforeWorktreeId,
      }),
    ).pipe(
      Effect.catchTags({
        WorktreeOrderError: (error) =>
          request.reject({
            code: 'worktree_order_rejected',
            status: 400,
            message: error.message,
            data: {
              reason: error.reason,
              projectId: error.projectId,
              worktreeId: error.worktreeId,
              ...(error.beforeWorktreeId ? { beforeWorktreeId: error.beforeWorktreeId } : {}),
            },
          }),
        GitCommandError: notProduced,
        StateFileError: notProduced,
        ProjectConfigError: notProduced,
        ProjectPathValidationError: notProduced,
        WorktreeSetupError: notProduced,
        WorkspaceError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.worktrees.branches, (request) =>
    WorkspaceService.use((workspace) =>
      workspace.listProjectBranches({ projectId: request.params.projectId }),
    ).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(worktreeOperationReasons, error, (reason) =>
            request.reject({
              code: 'worktree_branch_list_rejected',
              status: 400,
              message: error.message,
              data: { reason, ...(error.projectId ? { projectId: error.projectId } : {}) },
            }),
          ),
        StateFileError: notProduced,
        ProjectConfigError: notProduced,
        ProjectPathValidationError: notProduced,
        WorktreeSetupError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.worktrees.setupPreflight, (request) =>
    WorkspaceService.use((workspace) =>
      workspace.preflightWorktreeSetup({ projectId: request.params.projectId }),
    ).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(setupProjectReasons, error, (reason) =>
            request.reject(setupProjectRejection(error, reason)),
          ),
        ProjectConfigError: (error) => request.reject(workspaceRejections.projectConfig(error)),
        WorktreeSetupError: (error) => request.reject(workspaceRejections.worktreeSetup(error)),
        GitCommandError: notProduced,
        StateFileError: notProduced,
        ProjectPathValidationError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.worktrees.setupTrust, (request) =>
    WorkspaceService.use((workspace) =>
      workspace.trustWorktreeSetup({ projectId: request.params.projectId, request: request.body }),
    ).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(setupProjectReasons, error, (reason) =>
            request.reject(setupProjectRejection(error, reason)),
          ),
        ProjectConfigError: (error) => request.reject(workspaceRejections.projectConfig(error)),
        WorktreeSetupError: (error) => request.reject(workspaceRejections.worktreeSetup(error)),
        GitCommandError: notProduced,
        StateFileError: notProduced,
        ProjectPathValidationError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.worktrees.open, (request) =>
    WorkspaceService.use((workspace) =>
      workspace.openWorktree({ projectId: request.params.projectId, request: request.body }),
    ).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(worktreeOperationReasons, error, (reason) =>
            request.reject({
              code: 'worktree_open_rejected',
              status: worktreeOpenStatus(error.code),
              message: error.message,
              data: {
                reason,
                ...projectAndWorktree(error),
                ...(error.branch ? { branch: error.branch } : {}),
                ...(error.path ? { path: error.path } : {}),
              },
            }),
          ),
        // Opening reports a setup failure as part of *opening*: these two read as `worktree_open_rejected` here,
        // where every other endpoint that can meet them uses `workspaceRejections`.
        ProjectConfigError: (error) =>
          request.reject(openSetupRejection(error, 'setup_config_invalid')),
        WorktreeSetupError: (error) => {
          switch (error.code) {
            case 'setup_config_invalid':
            case 'setup_trust_required':
            case 'setup_trust_mismatch':
              return request.reject(openSetupRejection(error, error.code));
            // Only the trust update refuses for missing hooks; opening treats them as "no setup".
            case 'setup_not_configured':
              return Effect.die(error);
          }
        },
        StateFileError: notProduced,
        ProjectPathValidationError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.worktrees.deletePreflight, (request) =>
    WorkspaceService.use((workspace) =>
      workspace.preflightDeleteWorktree({
        projectId: request.params.projectId,
        worktreeId: request.params.worktreeId,
      }),
    ).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(worktreeDeleteReasons, error, (reason) =>
            request.reject(worktreeDeleteRejection(error, reason)),
          ),
        StateFileError: notProduced,
        ProjectConfigError: notProduced,
        ProjectPathValidationError: notProduced,
        WorktreeSetupError: notProduced,
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.worktrees.delete, (request) =>
    WorkspaceService.use((workspace) =>
      workspace.deleteWorktree({
        projectId: request.params.projectId,
        worktreeId: request.params.worktreeId,
        request: request.body,
      }),
    ).pipe(
      Effect.catchTags({
        WorkspaceError: (error) =>
          withReason(worktreeDeleteReasons, error, (reason) =>
            request.reject(worktreeDeleteRejection(error, reason)),
          ),
        StateFileError: notProduced,
        ProjectConfigError: notProduced,
        ProjectPathValidationError: notProduced,
        WorktreeSetupError: notProduced,
      }),
    ),
  );
}

/**
 * A failure the shared service union names but this endpoint's method never produces. Reaching it is a runtime bug,
 * so it is a defect, logged and answered `api_unhandled_error` by the request pipeline.
 */
function notProduced(error: unknown) {
  return Effect.die(error);
}

function activeContextRejection(
  error: WorkspaceError,
  reason: WorkspaceActiveContextRejectionReason,
) {
  return {
    code: 'workspace_active_context_rejected',
    status: 400,
    message: error.message,
    data: { reason, ...projectAndWorktree(error) },
  } as const;
}

/** Both setup endpoints refuse a project the same way before the setup service is reached. */
function setupProjectRejection(error: WorkspaceError, reason: WorktreeSetupRejectionReason) {
  return {
    code: 'worktree_setup_rejected',
    status: 400,
    message: error.message,
    data: { reason, ...(error.projectId ? { projectId: error.projectId } : {}) },
  } as const;
}

function worktreeDeleteRejection(error: WorkspaceError, reason: WorktreeDeleteRejectionReason) {
  return {
    code: 'worktree_delete_rejected',
    status: 400,
    message: error.message,
    data: {
      reason,
      ...projectAndWorktree(error),
      ...(error.path ? { path: error.path } : {}),
    },
  } as const;
}

function openSetupRejection(
  error: ProjectConfigError | WorktreeSetupError,
  reason: WorktreeOperationRejectionReason,
) {
  return {
    code: 'worktree_open_rejected',
    status: 400,
    message: error.message,
    data: { reason, ...(error.projectId ? { projectId: error.projectId } : {}) },
  } as const;
}

/**
 * The open-worktree rejections that mean "something is already there", as opposed to "your request
 * was malformed", answer 409: each describes a resource this call would have had to take over. That
 * keeps the answer consistent with the workflow boundary, where `workflow_environment_collision` is
 * already a 409 for the same underlying condition. A checkout parent the runtime could not create is
 * the runtime's failure, 500.
 */
const worktreeOpenConflicts: ReadonlySet<WorkspaceError['code']> = new Set([
  'checkout_path_exists',
  'checkout_path_registered',
  'branch_exists',
  'worktree_exists',
]);

function worktreeOpenStatus(code: WorkspaceError['code']) {
  if (worktreeOpenConflicts.has(code)) return 409;
  return code === 'checkout_parent_unavailable' ? 500 : 400;
}

function projectAndWorktree(error: WorkspaceError) {
  return {
    ...(error.projectId ? { projectId: error.projectId } : {}),
    ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
  };
}
