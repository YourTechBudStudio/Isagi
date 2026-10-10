import { Effect, type Layer } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints, type ApiError } from '@isagi/contracts';

import {
  registerLegacyApiEndpoint,
  type ApiRouteContext,
  errorMessage,
  type RouteRuntime,
} from '../platform/http/index.js';
import { RuntimeConfigConflict, RuntimeHarnessConfigInvalid } from '../runtime-config/index.js';
import { ControlPlaneNotReady, HarnessControlPlane } from './control-plane/service.js';
import type { HarnessesLayer } from './layer.js';

/** The harnesses module's routes: the harness control plane. */
export function registerHarnessesRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<Layer.Success<typeof HarnessesLayer>>,
) {
  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.controlPlane.get, {
    handle: () => Effect.flatMap(HarnessControlPlane, (service) => service.snapshot),
  });
  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.controlPlane.refreshInventory, {
    // Refresh is an explicit operational lifecycle: a changed trusted Docs target projection also
    // reconciles global isagi-docs integrations before this mutation completes.
    handle: () => Effect.flatMap(HarnessControlPlane, (service) => service.refreshInventory),
  });
  registerLegacyApiEndpoint(fastify, runtime, apiEndpoints.controlPlane.acceptPolicy, {
    handle: (input) =>
      Effect.flatMap(HarnessControlPlane, (service) => service.acceptPolicy(input)),
    mapError: toError,
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
