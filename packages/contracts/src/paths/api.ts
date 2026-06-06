import { apiInfrastructureErrorSchema } from '../api/responses.js';
import type { ApiEndpoint } from '../api/types.js';
import { pathSuggestInputSchema, pathSuggestOutputSchema } from './types.js';

export const pathsEndpoints = {
  suggestions: {
    id: 'paths.suggestions',
    method: 'POST',
    path: '/paths/suggestions',
    body: pathSuggestInputSchema,
    output: pathSuggestOutputSchema,
    errors: apiInfrastructureErrorSchema,
  },
} as const satisfies {
  readonly suggestions: ApiEndpoint<
    typeof pathSuggestInputSchema,
    typeof pathSuggestOutputSchema,
    typeof apiInfrastructureErrorSchema
  >;
};
