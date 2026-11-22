import { apiInfrastructureErrorSchema } from '../api/responses.js';
import type { ApiEndpoint } from '../api/types.js';
import { clientSettingsOutputSchema } from './types.js';

export const clientSettingsEndpoint = {
  id: 'clientSettings.get',
  method: 'GET',
  path: '/client-settings',
  output: clientSettingsOutputSchema,
  errors: apiInfrastructureErrorSchema,
} as const satisfies ApiEndpoint<
  undefined,
  typeof clientSettingsOutputSchema,
  typeof apiInfrastructureErrorSchema
>;
