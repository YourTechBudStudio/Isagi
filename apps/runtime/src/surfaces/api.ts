import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import { registerApiEndpoint, type ApiRouteContext, errorMessage } from '../lib/api/index.js';
import { DatabaseError } from '../persistence/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { SurfaceError, SurfaceService } from './surfaces.service.js';

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
}

function toSurfaceApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof SurfaceError) {
    if (context.endpointId.startsWith('surfaces.')) {
      return {
        code: 'surface_rejected',
        status: 400,
        message: error.message,
        requestId: context.requestId,
        data: {
          reason: surfaceRejectionReason(error),
          ...(error.surfaceId ? { surfaceId: error.surfaceId } : {}),
          ...(error.paneId ? { paneId: error.paneId } : {}),
        },
      };
    }

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
      return error.code;
    default:
      return 'surface_not_found';
  }
}
