import { Effect, type Layer } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import {
  registerLegacyApiEndpoint,
  type ApiRouteContext,
  unhandledApiError,
  type RouteRuntime,
} from '../platform/http/index.js';
import { DatabaseError } from '../platform/persistence/index.js';
import {
  EditorDiagnosticsUnavailable,
  EditorError,
  EditorLaunchFailed,
} from './contexts/errors.js';
import { EditorContextService } from './contexts/service.js';
import type { EditorLayer } from './layer.js';
import {
  EditorUnavailable,
  EditorProvisioning,
  EditorProvisioningBusy,
} from './provisioning/service.js';

// The editor runtime routes. Opening an editor is a placement, so `editor.open`
// is registered by the environment's surface routes, which map its editor
// failures through `editorApiError` below.

export function registerEditorRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<Layer.Success<typeof EditorLayer>>,
) {
  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.editor.ensureRuntime, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const editors = yield* EditorContextService;
        const editorContext = yield* editors.ensureRuntime({
          editorContextId: params.editorContextId,
          intent: input.intent,
        });
        return { editorContext };
      }),
    mapError: editorApiError,
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.editor.diagnostics, {
    handle: (_input, _context, params, query) =>
      Effect.gen(function* () {
        const editors = yield* EditorContextService;
        return yield* editors.diagnostics({
          editorContextId: params.editorContextId,
          ptyProcessId: query.ptyProcessId,
        });
      }),
    mapError: editorApiError,
  });

  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.editor.retryProvisioning, {
    handle: () =>
      Effect.map(
        Effect.flatMap(EditorProvisioning, (provisioning) => provisioning.retry),
        (provisioning) => ({ provisioning }),
      ),
    mapError: editorApiError,
  });
}

/**
 * The editor error mapper, total over every editor failure the editor routes and
 * `editor.open` can produce. `editor.open` maps its surface failures first and
 * delegates everything else here.
 *
 * Totality here is a runtime property, not a typing nicety: `sendRouteApiError`
 * validates every error whose code does not begin with `api_` against the
 * endpoint's declared error schema, and a miss reaches the client as
 * `api_response_encoding_failed` rather than as the failure that actually
 * happened. Each branch below has a member in `editorApiErrorSchema`, and the
 * union has no member this mapper cannot produce.
 */
export function editorApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof EditorUnavailable)
    return {
      code: 'editor_rejected',
      status: 400,
      message: 'The embedded editor is not available on this runtime.',
      requestId: context.requestId,
      data: {
        reason: error.reason,
        ...(error.diagnostic === null ? {} : { diagnostic: error.diagnostic }),
      },
    };
  if (error instanceof EditorProvisioningBusy)
    return {
      code: 'editor_rejected',
      status: 400,
      message: 'Code Server provisioning is already running.',
      requestId: context.requestId,
      data: { reason: 'editor_provisioning_busy' },
    };
  if (error instanceof EditorError)
    return {
      code: 'editor_rejected',
      status: 400,
      message: error.message,
      requestId: context.requestId,
      data: {
        reason: error.code,
        ...(error.worktreeId === undefined ? {} : { worktreeId: error.worktreeId }),
        ...(error.editorContextId === undefined ? {} : { editorContextId: error.editorContextId }),
      },
    };
  if (error instanceof EditorLaunchFailed)
    // Not a 400: the request was well-formed and the target valid. The attempt
    // ran, was persisted on the context, and failed, so the caller's correct
    // response is to re-read the context.
    return {
      code: 'editor_launch_failed',
      status: 409,
      message: 'The editor runtime failed to start.',
      requestId: context.requestId,
      data: {
        reason: error.reason,
        editorContextId: error.editorContextId,
        ...(error.detail === null ? {} : { detail: error.detail }),
      },
    };
  if (error instanceof EditorDiagnosticsUnavailable)
    return {
      code: 'editor_diagnostics_unavailable',
      status: 500,
      message: 'The editor startup output could not be read.',
      requestId: context.requestId,
      data: { detail: error.detail },
    };
  if (error instanceof DatabaseError)
    return {
      code: 'runtime_database_failed',
      status: 500,
      message: 'The runtime database operation failed.',
      requestId: context.requestId,
      data: { operation: error.operation },
    };
  console.error(`[runtime] Unhandled editor API handler error during ${context.endpointId}`, error);
  return unhandledApiError(context, error);
}
