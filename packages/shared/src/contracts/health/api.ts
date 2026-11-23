import { apiInfrastructureErrorSchema } from '../api/responses.js';
import type { ApiEndpoint } from '../api/types.js';
import { healthOutputSchema } from './types.js';

export const healthEndpoint = {
  id: 'health.get',
  method: 'GET',
  path: '/health',
  output: healthOutputSchema,
  errors: apiInfrastructureErrorSchema,
} as const satisfies ApiEndpoint<
  undefined,
  typeof healthOutputSchema,
  typeof apiInfrastructureErrorSchema
>;
