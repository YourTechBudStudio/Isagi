import { projectApiErrorSchema } from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import { addProjectInputSchema, addProjectOutputSchema } from './types.js';

export const projectsEndpoints = {
  add: {
    id: 'projects.add',
    method: 'POST',
    path: '/projects',
    body: addProjectInputSchema,
    output: addProjectOutputSchema,
    errors: projectApiErrorSchema,
  },
} as const satisfies {
  readonly add: ApiEndpoint<
    typeof addProjectInputSchema,
    typeof addProjectOutputSchema,
    typeof projectApiErrorSchema
  >;
};
