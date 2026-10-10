import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import { editorApiError } from '../../editor/index.js';
import { HarnessLaunchBlocked } from '../../harnesses/index.js';
import {
  registerLegacyApiEndpoint,
  type ApiRouteContext,
  errorMessage,
  type RouteRuntime,
} from '../../platform/http/index.js';
import { DatabaseError } from '../../platform/persistence/index.js';
import { SurfaceError, SurfaceOrderError } from './errors.js';
import { SurfaceService } from './service.js';

export function registerSurfacesApi(
  fastify: FastifyInstance,
  runtime: RouteRuntime<SurfaceService>,
) {
  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.get, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.getSurfaceDetail(params.surfaceId);
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.rename, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.renameSurface({
          surfaceId: params.surfaceId,
          title: input.title,
        });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.delete, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.deleteSurface(params.surfaceId);
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.deletePane, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.deleteSurfacePane({
          surfaceId: params.surfaceId,
          paneId: params.paneId,
        });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.setWorktreeEnvironmentFocus, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.setWorktreeEnvironmentFocus({
          worktreeId: params.worktreeId,
          focus: input,
        });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.createSurface, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.createSurface({
          worktreeId: params.worktreeId,
          initialPane: input.initialPane,
        });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.splitPane, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.splitPane({ worktreeId: params.worktreeId, split: input });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.startPane, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.startPane({ surfaceId: params.surfaceId, start: input });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.setSplitWeights, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.setSplitWeights({ surfaceId: params.surfaceId, weights: input });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.createPaneSession, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.createPaneSession({ worktreeId: params.worktreeId, create: input });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.claimPaneSession, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.claimPaneSession({ worktreeId: params.worktreeId, claim: input });
      }),
    mapError: (error, context) => toSurfaceApiError(error, context),
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.surfaces.moveOrder, {
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
  });

  // Opening an editor is a placement: the surfaces service resolves (or creates) the pane and
  // asks the editor domain for the context it binds there.
  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.editor.open, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.openEditor({
          worktreeId: params.worktreeId,
          intoSurfaceId: input.intoSurfaceId,
        });
      }),
    mapError: toEditorOpenApiError,
  });
}

/**
 * `editor.open` answers in the editor's error vocabulary. Its surface failures are mapped here;
 * every other failure (the editor's own, the database) goes to the editor mapper, which is total
 * over the editor error union.
 */
function toEditorOpenApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof SurfaceError) {
    // Translated rather than delegated, because the editor's own refusal
    // vocabulary already names it and the palette reads one reason set. The
    // target-surface refusals (`surface_not_found`, `surface_not_empty`) are
    // surfaces conditions and delegate as such; the rest are unreachable from
    // `openEditor` in practice, but the type channel carries them, so
    // delegation keeps this mapper total.
    if (error.code === 'worktree_not_found')
      return {
        code: 'editor_rejected',
        status: 400,
        message: error.message,
        requestId: context.requestId,
        data: {
          reason: 'worktree_not_found',
          ...(error.worktreeId === undefined ? {} : { worktreeId: error.worktreeId }),
        },
      };
    return toSurfaceApiError(error, context);
  }
  return editorApiError(error, context);
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
    case 'surface_not_empty':
      return error.code;
    default:
      return 'surface_not_found';
  }
}
