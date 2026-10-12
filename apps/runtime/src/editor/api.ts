import { Effect, type Layer } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { registerApiEndpoint, type Rejection, type RouteRuntime } from '../platform/http/index.js';
import type { DatabaseError } from '../platform/persistence/index.js';
import type {
  EditorDiagnosticsUnavailable,
  EditorError,
  EditorLaunchFailed,
} from './contexts/errors.js';
import { EditorContextService } from './contexts/service.js';
import type { EditorLayer } from './layer.js';
import {
  type EditorUnavailable,
  EditorProvisioning,
  type EditorProvisioningBusy,
} from './provisioning/service.js';

// The editor runtime routes. Opening an editor is a placement, so `editor.open`
// is registered by the environment's surface routes, which map its editor
// failures through `editorRejection` below.

/** Every failure an editor route, or the editor half of `editor.open`, can answer with. */
export type EditorFailure =
  | EditorUnavailable
  | EditorProvisioningBusy
  | EditorError
  | EditorLaunchFailed
  | EditorDiagnosticsUnavailable
  | DatabaseError;

/**
 * The contract rejection every editor endpoint shares. All four editor endpoints declare the same
 * `editorApiErrorSchema`, so one type serves them all.
 */
export type EditorRejection = Rejection<typeof apiEndpoints.editor.ensureRuntime>;

export function registerEditorRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<Layer.Success<typeof EditorLayer>>,
) {
  registerApiEndpoint(fastify, runtime, apiEndpoints.editor.ensureRuntime, (request) =>
    EditorContextService.use((editors) =>
      editors.ensureRuntime({
        editorContextId: request.params.editorContextId,
        intent: request.body.intent,
      }),
    ).pipe(
      Effect.map((editorContext) => ({ editorContext })),
      Effect.catchTags({
        EditorUnavailable: (error) => request.reject(editorRejection(error)),
        EditorError: (error) => request.reject(editorRejection(error)),
        EditorLaunchFailed: (error) => request.reject(editorRejection(error)),
        DatabaseError: (error) => request.reject(editorRejection(error)),
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.editor.diagnostics, (request) =>
    EditorContextService.use((editors) =>
      editors.diagnostics({
        editorContextId: request.params.editorContextId,
        ptyProcessId: request.query.ptyProcessId,
      }),
    ).pipe(
      Effect.catchTags({
        EditorError: (error) => request.reject(editorRejection(error)),
        EditorDiagnosticsUnavailable: (error) => request.reject(editorRejection(error)),
        DatabaseError: (error) => request.reject(editorRejection(error)),
      }),
    ),
  );

  registerApiEndpoint(fastify, runtime, apiEndpoints.editor.retryProvisioning, (request) =>
    EditorProvisioning.use((provisioning) => provisioning.retry).pipe(
      Effect.map((provisioning) => ({ provisioning })),
      Effect.catchTag('EditorProvisioningBusy', (error) => request.reject(editorRejection(error))),
    ),
  );
}

/**
 * The editor error mapper, total over every editor failure the editor routes and `editor.open` can produce. Each
 * branch has a member in `editorApiErrorSchema`, and the union has no member this mapper cannot produce; the route
 * helper still validates every rejection against the endpoint's declared schema at runtime, because a miss would reach
 * the client as `api_response_encoding_failed` rather than as the failure that actually happened.
 *
 * `DatabaseError` is mapped here rather than left to the platform's infrastructure table so the editor routes keep
 * their own wording for it.
 */
export function editorRejection(error: EditorFailure): EditorRejection {
  switch (error._tag) {
    case 'EditorUnavailable':
      return {
        code: 'editor_rejected',
        status: 400,
        message: 'The embedded editor is not available on this runtime.',
        data: {
          reason: error.reason,
          ...(error.diagnostic === null ? {} : { diagnostic: error.diagnostic }),
        },
      };
    case 'EditorProvisioningBusy':
      return {
        code: 'editor_rejected',
        status: 400,
        message: 'Code Server provisioning is already running.',
        data: { reason: 'editor_provisioning_busy' },
      };
    case 'EditorError':
      return {
        code: 'editor_rejected',
        status: 400,
        message: error.message,
        data: {
          reason: error.code,
          ...(error.worktreeId === undefined ? {} : { worktreeId: error.worktreeId }),
          ...(error.editorContextId === undefined
            ? {}
            : { editorContextId: error.editorContextId }),
        },
      };
    case 'EditorLaunchFailed':
      // Not a 400: the request was well-formed and the target valid. The attempt
      // ran, was persisted on the context, and failed, so the caller's correct
      // response is to re-read the context.
      return {
        code: 'editor_launch_failed',
        status: 409,
        message: 'The editor runtime failed to start.',
        data: {
          reason: error.reason,
          editorContextId: error.editorContextId,
          ...(error.detail === null ? {} : { detail: error.detail }),
        },
      };
    case 'EditorDiagnosticsUnavailable':
      return {
        code: 'editor_diagnostics_unavailable',
        status: 500,
        message: 'The editor startup output could not be read.',
        data: { detail: error.detail },
      };
    case 'DatabaseError':
      return {
        code: 'runtime_database_failed',
        status: 500,
        message: 'The runtime database operation failed.',
        data: { operation: error.operation },
      };
  }
}
