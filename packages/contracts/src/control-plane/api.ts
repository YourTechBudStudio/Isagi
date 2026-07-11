import { Schema } from 'effect';

import { apiInfrastructureErrorSchema } from '../api/responses.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  acceptHarnessPolicyInputSchema,
  acceptHarnessPolicyOutputSchema,
  controlPlaneSnapshotSchema,
  refreshInventoryOutputSchema,
} from './types.js';
export const controlPlaneErrorSchema = Schema.Union(
  apiInfrastructureErrorSchema,
  Schema.Struct({
    code: Schema.Literal(
      'harness_policy_conflict',
      'harness_config_invalid',
      'control_plane_not_ready',
    ),
    status: Schema.Number,
    message: Schema.String,
    requestId: Schema.String,
    data: Schema.optional(Schema.Unknown),
  }),
);
export const controlPlaneEndpoints = {
  get: {
    id: 'controlPlane.get',
    method: 'GET',
    path: '/control-plane',
    output: controlPlaneSnapshotSchema,
    errors: controlPlaneErrorSchema,
  },
  refreshInventory: {
    id: 'controlPlane.refreshInventory',
    method: 'POST',
    path: '/control-plane/inventory/refresh',
    output: refreshInventoryOutputSchema,
    errors: controlPlaneErrorSchema,
  },
  acceptPolicy: {
    id: 'controlPlane.acceptPolicy',
    method: 'PUT',
    path: '/control-plane/harness-policy',
    body: acceptHarnessPolicyInputSchema,
    output: acceptHarnessPolicyOutputSchema,
    errors: controlPlaneErrorSchema,
  },
} as const satisfies Record<string, ApiEndpoint<any, any, any>>;
