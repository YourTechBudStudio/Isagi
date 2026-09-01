import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import { EditorProvisioning, EditorProvisioningBusy } from '../editor-provisioning/index.js';
import { registerApiEndpoint, type ApiRouteContext, unhandledApiError } from '../lib/api/index.js';
import type { RuntimeServices } from '../runtime.layer.js';

// The editor feature spans two domains — placement is a surfaces operation and
// the runtime lifecycle is an editor one — so its HTTP routes live in a
// composition module that depends on both and is depended on by neither.
// `server.ts` is its only importer.
//
// Putting these routes inside either domain would close a module cycle:
// `editor-contexts → api.ts → surfaces → editor-contexts`. Every `register*Api`
// in this repository is already a leaf, so this is that convention applied where
// a feature genuinely spans domains.
//
// Only `retryProvisioning` is registered today. `open`, `ensureRuntime`, and
// `diagnostics` are described by the contracts and are registered here once the
// domains they compose exist.

export function registerEditorApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => runtime.runPromise(effect, options);

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
 * The editor error mapper.
 *
 * It has exactly one branch because `retry` has exactly one expected failure:
 * it does not call `requireReady` (an undeclared runtime's `not_applicable` is a
 * successful answer), provisioning faults settle into state rather than being
 * raised, and it touches no database. Branches for `EditorUnavailable`,
 * `EditorError`, `SurfaceError`, `EditorLaunchFailed`,
 * `EditorDiagnosticsUnavailable`, and `DatabaseError` arrive with the routes
 * that can actually produce them.
 */
function toEditorApiError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof EditorProvisioningBusy)
    return {
      code: 'editor_rejected',
      status: 400,
      message: 'Code Server provisioning is already running.',
      requestId: context.requestId,
      data: { reason: 'editor_provisioning_busy' },
    };
  console.error(`[runtime] Unhandled editor API handler error during ${context.endpointId}`, error);
  return unhandledApiError(context, error);
}
