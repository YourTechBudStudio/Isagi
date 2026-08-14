import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import { HarnessLaunchBlocked } from '../harness-control-plane/index.js';
import { registerApiEndpoint, type ApiRouteContext, errorMessage } from '../lib/api/index.js';
import { DatabaseError } from '../persistence/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { SurfaceError, SurfaceOrderError, SurfaceService } from './surfaces.service.js';

const runWithRuntime =
  (runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>) =>
  <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) =>
    runtime.runPromise(effect, options);

export function registerSurfacesApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = runWithRuntime(runtime);

  registerApiEndpoint(fastify, apiEndpoints.surfaces.get, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.getSurfaceDetail(params.surfaceId);
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.surfaces.rename, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.renameSurface({
          surfaceId: params.surfaceId,
          title: input.title,
        });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.surfaces.delete, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.deleteSurface(params.surfaceId);
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.surfaces.deletePane, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.deleteSurfacePane({
          surfaceId: params.surfaceId,
          paneId: params.paneId,
        });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.surfaces.setWorktreeEnvironmentFocus, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.setWorktreeEnvironmentFocus({
          worktreeId: params.worktreeId,
          focus: input,
        });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.surfaces.createSurface, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.createSurface({
          worktreeId: params.worktreeId,
          initialPane: input.initialPane,
        });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.surfaces.splitPane, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.splitPane({ worktreeId: params.worktreeId, split: input });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.surfaces.setSplitWeights, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.setSplitWeights({ surfaceId: params.surfaceId, weights: input });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.surfaces.createPaneSession, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.createPaneSession({ worktreeId: params.worktreeId, create: input });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.surfaces.claimPaneSession, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.claimPaneSession({ worktreeId: params.worktreeId, claim: input });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.surfaces.moveOrder, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.moveSurfaceOrder({
          worktreeId: params.worktreeId,
          surfaceId: params.surfaceId,
          beforeSurfaceId: input.beforeSurfaceId,
        });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
    run,
  });
}

export function toSurfaceApiError(error: unknown, context: ApiRouteContext): ApiError {
  // Ahead of `SurfaceError`, whose reason mapping ends in a catch-all default.
  // This reason is already the contract reason, so it maps straight through.
  if (error instanceof SurfaceOrderError)
    return {
      code: 'surface_order_rejected',
      status: 400,
      message: error.message,
      requestId: context.requestId,
      data: {
        reason: error.reason,
        worktreeId: error.worktreeId,
        surfaceId: error.surfaceId,
        ...(error.beforeSurfaceId ? { beforeSurfaceId: error.beforeSurfaceId } : {}),
      },
    };
  if (error instanceof HarnessLaunchBlocked)
    return {
      code: 'session_launch_rejected',
      status: 400,
      message: `Harness process creation is blocked: ${error.reason}.`,
      requestId: context.requestId,
      data: {
        reason: error.reason,
        ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
      },
    };
  if (error instanceof SurfaceError) {
    if (context.endpointId === apiEndpoints.surfaces.setWorktreeEnvironmentFocus.id)
      return {
        code: 'worktree_environment_focus_rejected',
        status: 400,
        message: error.message,
        requestId: context.requestId,
        data: {
          reason: error.code,
          ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
          ...(error.surfaceId ? { surfaceId: error.surfaceId } : {}),
          ...(error.paneId ? { paneId: error.paneId } : {}),
        },
      };

    return {
      code: 'surface_rejected',
      status: 400,
      message: error.message,
      requestId: context.requestId,
      data: {
        reason: surfaceRejectionReason(error),
        ...(error.worktreeId ? { worktreeId: error.worktreeId } : {}),
        ...(error.surfaceId ? { surfaceId: error.surfaceId } : {}),
        ...(error.paneId ? { paneId: error.paneId } : {}),
        ...(error.sessionId ? { sessionId: error.sessionId } : {}),
      },
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

  console.error(
    `[runtime] Unhandled surface API handler error during ${context.endpointId}`,
    error,
  );

  return {
    code: 'api_unhandled_error',
    status: 500,
    message: errorMessage(error),
    requestId: context.requestId,
    data: { endpointId: context.endpointId },
  };
}

function surfaceRejectionReason(error: SurfaceError) {
  switch (error.code) {
    case 'surface_not_found':
    case 'pane_not_found':
    case 'invalid_surface_title':
    case 'worktree_not_found':
    case 'session_not_found':
    case 'session_worktree_mismatch':
    case 'layout_node_stale':
      return error.code;
    default:
      return 'surface_not_found';
  }
}
