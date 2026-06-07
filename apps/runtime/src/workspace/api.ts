import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import { GitCommandError, ProjectPathValidationError } from '../git/index.js';
import { registerApiEndpoint, type ApiRouteContext, errorMessage } from '../lib/api/index.js';
import { DataDirectoryError, DatabaseError, StateFileError } from '../persistence/index.js';
import type { RuntimeServices } from '../runtime-layer.js';
import { WorkspaceError, WorkspaceService } from './index.js';

const runWithRuntime =
  (runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>) =>
  <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) =>
    runtime.runPromise(effect, options);

export function registerWorkspaceApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = runWithRuntime(runtime);

  registerApiEndpoint(fastify, apiEndpoints.workspace.get, {
    handle: () =>
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.get;
      }),
    mapError: (error, context) => toWorkspaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workspace.getActiveContext, {
    handle: () =>
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.getActiveContext;
      }),
    mapError: (error, context) => toWorkspaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workspace.setActiveContext, {
    handle: (input) =>
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.setActiveContext(input);
      }),
    mapError: (error, context) => toWorkspaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.workspace.reconcile, {
    handle: (input) =>
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.reconcileWorkspace(input);
      }),
    mapError: (error, context) => toWorkspaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.projects.add, {
    handle: (input) =>
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.registerProject(input);
      }),
    mapError: (error, context) => toWorkspaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.projects.relocate, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.relocateProject({ projectId: params.projectId, path: input.path });
      }),
    mapError: (error, context) => toWorkspaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.projects.delete, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.deleteProject(params.projectId);
      }),
    mapError: (error, context) => toWorkspaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.worktrees.branches, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.listProjectBranches({ projectId: params.projectId });
      }),
    mapError: (error, context) => toWorkspaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.worktrees.open, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const workspace = yield* WorkspaceService;
        return yield* workspace.openWorktree({ projectId: params.projectId, request: input });
      }),
    mapError: (error, context) => toWorkspaceApiError(error, context),
    run,
  });
}

function relocationRejectionReason(error: WorkspaceError) {
  switch (error.code) {
    case 'project_not_found':
    case 'project_not_missing':
    case 'project_path_already_registered':
      return error.code;
    default:
      return 'project_not_found';
  }
}

function worktreeRejectionReason(error: WorkspaceError) {
  switch (error.code) {
    case 'project_not_found':
    case 'project_not_present':
    case 'branch_not_found':
    case 'checkout_path_exists':
    case 'checkout_parent_unavailable':
    case 'worktree_not_found':
      return error.code;
    default:
      return 'project_not_found';
  }
}

function toWorkspaceApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof ProjectPathValidationError) {
    return {
      code: 'project_path_rejected',
      status: 400,
      message: error.message,
      requestId: context.requestId,
      data: { reason: error.code, path: error.path },
    };
  }

  if (error instanceof WorkspaceError) {
    if (context.endpointId === 'projects.relocate' && error.projectId) {
      return {
        code: 'project_relocation_rejected',
        status: error.code === 'project_path_already_registered' ? 409 : 400,
        message: error.message,
        requestId: context.requestId,
        data: {
          reason: relocationRejectionReason(error),
          projectId: error.projectId,
          ...(error.path ? { path: error.path } : {}),
          ...(error.conflictingProjectId
            ? { conflictingProjectId: error.conflictingProjectId }
            : {}),
        },
      };
    }

    if (
      context.endpointId === 'workspace.reconcile' &&
      error.code === 'project_not_found' &&
      error.projectId
    ) {
      return {
        code: 'workspace_reconcile_rejected',
        status: 400,
        message: error.message,
        requestId: context.requestId,
        data: { reason: 'project_not_found', projectId: error.projectId },
      };
    }

    if (context.endpointId === 'worktrees.branches') {
      return {
        code: 'worktree_branch_list_rejected',
        status: 400,
        message: error.message,
        requestId: context.requestId,
        data: {
          reason: worktreeRejectionReason(error),
          ...(error.projectId ? { projectId: error.projectId } : {}),
        },
      };
    }

    if (context.endpointId === 'worktrees.open') {
      return {
        code: 'worktree_open_rejected',
        status:
          error.code === 'checkout_path_exists'
            ? 409
            : error.code === 'checkout_parent_unavailable'
              ? 500
              : 400,
        message: error.message,
        requestId: context.requestId,
        data: {
          reason: worktreeRejectionReason(error),
          ...(error.projectId ? { projectId: error.projectId } : {}),
          ...(error.branch ? { branch: error.branch } : {}),
          ...(error.path ? { path: error.path } : {}),
        },
      };
    }

    return {
      code: 'workspace_active_context_rejected',
      status: 400,
      message: error.message,
      requestId: context.requestId,
      data: {
        reason: error.code,
        ...(error.projectId ? { projectId: error.projectId } : {}),
        ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
      },
    };
  }

  if (error instanceof GitCommandError) {
    return {
      code: 'git_command_failed',
      status: 500,
      message: `git ${error.args.join(' ')} failed${error.stderr ? `: ${error.stderr.trim()}` : ''}`,
      requestId: context.requestId,
      data: { args: [...error.args], cwd: error.cwd ?? null },
    };
  }

  if (error instanceof DatabaseError) {
    return {
      code: 'runtime_database_failed',
      status: 500,
      message: `Database operation failed: ${error.operation}`,
      requestId: context.requestId,
      data: { operation: error.operation },
    };
  }

  if (error instanceof StateFileError) {
    return {
      code: 'runtime_state_file_failed',
      status: 500,
      message: `State file operation failed: ${error.operation}`,
      requestId: context.requestId,
      data: { operation: error.operation },
    };
  }

  if (error instanceof DataDirectoryError) {
    return {
      code: 'runtime_data_directory_failed',
      status: 500,
      message: 'Could not prepare the Isagi data directory.',
      requestId: context.requestId,
    };
  }

  console.error(`[runtime] Unhandled API handler error during ${context.endpointId}`, error);

  return {
    code: 'api_unhandled_error',
    status: 500,
    message: errorMessage(error),
    requestId: context.requestId,
    data: { endpointId: context.endpointId },
  };
}
