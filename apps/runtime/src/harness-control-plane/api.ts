import { Effect, type ManagedRuntime } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import { registerApiEndpoint, type ApiRouteContext, errorMessage } from '../lib/api/index.js';
import { RuntimeConfigConflict, RuntimeHarnessConfigInvalid } from '../runtime-config/index.js';
import type { RuntimeServices } from '../runtime.layer.js';
import { ControlPlaneNotReady, HarnessControlPlane } from './index.js';
export function registerControlPlaneApi(
  fastify: FastifyInstance,
  runtime: ManagedRuntime.ManagedRuntime<RuntimeServices, unknown>,
) {
  const run = <A>(
    effect: Effect.Effect<A, unknown, RuntimeServices>,
    options?: { readonly signal?: AbortSignal | undefined },
  ) => runtime.runPromise(effect, options);
  registerApiEndpoint(fastify, apiEndpoints.controlPlane.get, {
    handle: () => Effect.flatMap(HarnessControlPlane, (service) => service.snapshot),
    run,
  });
  registerApiEndpoint(fastify, apiEndpoints.controlPlane.refreshInventory, {
    // Refresh is an explicit operational lifecycle: a changed trusted Docs target projection also
    // reconciles global isagi-docs integrations before this mutation completes.
    handle: () => Effect.flatMap(HarnessControlPlane, (service) => service.refreshInventory),
    run,
  });
  registerApiEndpoint(fastify, apiEndpoints.controlPlane.acceptPolicy, {
    handle: (input) =>
      Effect.flatMap(HarnessControlPlane, (service) => service.acceptPolicy(input)),
    mapError: toError,
    run,
  });
}
function toError(error: unknown, context: ApiRouteContext): ApiError {
  if (error instanceof RuntimeConfigConflict)
    return {
      code: 'harness_policy_conflict',
      status: 409,
      message: 'Harness policy changed before this mutation could be applied.',
      requestId: context.requestId,
      data: {
        expectedPolicyRevision: error.expectedRevision,
        actualPolicyRevision: error.actualRevision,
      },
    };
  if (error instanceof RuntimeHarnessConfigInvalid)
    return {
      code: 'harness_config_invalid',
      status: 409,
      message: 'Harness configuration is invalid and was left untouched.',
      requestId: context.requestId,
      data: { diagnostic: error.diagnostic },
    };
  if (error instanceof ControlPlaneNotReady)
    return {
      code: 'control_plane_not_ready',
      status: 503,
      message: 'The harness control plane is not ready to reconcile policy.',
      requestId: context.requestId,
      data: { reason: error.reason },
    };
  return {
    code: 'api_unhandled_error',
    status: 500,
    message: errorMessage(error),
    requestId: context.requestId,
  };
}
