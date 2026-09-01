import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import {
  EditorContextService,
  EditorDiagnosticsUnavailable,
  EditorError,
  EditorLaunchFailed,
  EditorUnavailable,
} from '../editor-contexts/index.js';
import { EditorProvisioning, EditorProvisioningBusy } from '../editor-provisioning/index.js';
import { registerApiEndpoint, type ApiRouteContext, unhandledApiError } from '../lib/api/index.js';
import { DatabaseError } from '../persistence/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { toSurfaceApiError } from '../surfaces/api.js';
import { SurfaceError } from '../surfaces/errors.js';
import { SurfaceService } from '../surfaces/index.js';

// The editor feature spans two domains — placement is a surfaces operation and
// the runtime lifecycle is an editor one — so its HTTP routes live in a
// composition module that depends on both and is depended on by neither.
// `server.ts` is its only importer.
//
// Putting these routes inside either domain would close a module cycle:
// `editor-contexts → api.ts → surfaces → editor-contexts`. Every `register*Api`
// in this repository is already a leaf, so this is that convention applied where
// a feature genuinely spans domains.

export function registerEditorApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => runtime.runPromise(effect, options);

  registerApiEndpoint(fastify, apiEndpoints.editor.open, {
    handle: (_input, _context, params) =>
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.openEditor({ worktreeId: params.worktreeId });
      }),
    mapError: toEditorApiError,
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.editor.ensureRuntime, {
    handle: (input, _context, params) =>
      Effect.gen(function* () {
        const editors = yield* EditorContextService;
        const editorContext = yield* editors.ensureRuntime({
          editorContextId: params.editorContextId,
          intent: input.intent,
        });
        return { editorContext };
      }),
    mapError: toEditorApiError,
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.editor.diagnostics, {
    handle: (_input, _context, params, query) =>
      Effect.gen(function* () {
        const editors = yield* EditorContextService;
        return yield* editors.diagnostics({
          editorContextId: params.editorContextId,
          ptyProcessId: query.ptyProcessId,
        });
      }),
    mapError: toEditorApiError,
    run,
  });

  registerApiEndpoint(fastify, apiEndpoints.editor.retryProvisioning, {
    handle: () =>
      Effect.map(
        Effect.flatMap(EditorProvisioning, (provisioning) => provisioning.retry),
        (provisioning) => ({ provisioning }),
      ),
    mapError: toEditorApiError,
    run,
  });
}

/**
 * The editor error mapper, total over every failure the four routes can produce.
 *
 * Totality here is a runtime property, not a typing nicety: `sendRouteApiError`
 * validates every error whose code does not begin with `api_` against the
 * endpoint's declared error schema, and a miss reaches the client as
 * `api_response_encoding_failed` rather than as the failure that actually
 * happened. Each branch below has a member in `editorApiErrorSchema`, and the
 * union has no member this mapper cannot produce.
 */
function toEditorApiError(error: unknown, context: ApiRouteContext): ApiError {
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
  if (error instanceof SurfaceError) {
    // Translated rather than delegated, because the editor's own refusal
    // vocabulary already names it and the palette reads one reason set. Every
    // other `SurfaceError` variant is unreachable from `openEditor` in practice,
    // but the type channel carries them, so delegation keeps this mapper total
    // without inventing editor reasons for surfaces conditions.
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
