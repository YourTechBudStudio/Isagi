import { Effect, type Layer } from 'effect';
import type { FastifyInstance } from 'fastify';

import { apiEndpoints } from '@isagi/contracts';

import { registerApiEndpoint, type Rejection, type RouteRuntime } from '../platform/http/index.js';
import type {
  RuntimeConfigConflict,
  RuntimeConfigError,
  RuntimeHarnessConfigInvalid,
} from '../runtime-config/index.js';
import { HarnessControlPlane, type ControlPlaneNotReady } from './control-plane/service.js';
import type { HarnessesLayer } from './layer.js';

type AcceptPolicy = typeof apiEndpoints.controlPlane.acceptPolicy;

/** The harnesses module's routes: the harness control plane. */
export function registerHarnessesRoutes(
  fastify: FastifyInstance,
  runtime: RouteRuntime<Layer.Success<typeof HarnessesLayer>>,
) {
  // The snapshot is a projection of state the control plane already holds; reading it cannot fail.
  registerApiEndpoint(fastify, runtime, apiEndpoints.controlPlane.get, () =>
    HarnessControlPlane.use((controlPlane) => controlPlane.snapshot),
  );
  // Refresh is an explicit operational lifecycle: a changed trusted Docs target projection also
  // reconciles global isagi-docs integrations before this mutation completes.
  registerApiEndpoint(fastify, runtime, apiEndpoints.controlPlane.refreshInventory, () =>
    HarnessControlPlane.use((controlPlane) => controlPlane.refreshInventory),
  );
  registerApiEndpoint(fastify, runtime, apiEndpoints.controlPlane.acceptPolicy, (request) =>
    HarnessControlPlane.use((controlPlane) => controlPlane.acceptPolicy(request.body)).pipe(
      Effect.catchTags({
        RuntimeConfigConflict: (error) => request.reject(acceptPolicyRejection(error)),
        RuntimeHarnessConfigInvalid: (error) => request.reject(acceptPolicyRejection(error)),
        ControlPlaneNotReady: (error) => request.reject(acceptPolicyRejection(error)),
        RuntimeConfigError: (error) => request.reject(acceptPolicyRejection(error)),
      }),
    ),
  );
}

function acceptPolicyRejection(
  error:
    | RuntimeConfigConflict
    | RuntimeHarnessConfigInvalid
    | ControlPlaneNotReady
    | RuntimeConfigError,
): Rejection<AcceptPolicy> {
  switch (error._tag) {
    case 'RuntimeConfigConflict':
      return {
        code: 'harness_policy_conflict',
        status: 409,
        message: 'Harness policy changed before this mutation could be applied.',
        data: {
          expectedPolicyRevision: error.expectedRevision,
          actualPolicyRevision: error.actualRevision,
        },
      };
    case 'RuntimeHarnessConfigInvalid':
      return {
        code: 'harness_config_invalid',
        status: 409,
        message: 'Harness configuration is invalid and was left untouched.',
        data: { diagnostic: error.diagnostic },
      };
    case 'ControlPlaneNotReady':
      return {
        code: 'control_plane_not_ready',
        status: 503,
        message: 'The harness control plane is not ready to reconcile policy.',
        data: { reason: error.reason },
      };
    case 'RuntimeConfigError':
      // `config.yaml` could not be read, parsed or written. The contract has no code for it, so it
      // reads as an unhandled runtime failure. Its message is authored from safe fields only.
      return { code: 'api_unhandled_error', status: 500, message: error.message };
  }
}
