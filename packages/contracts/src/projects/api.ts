import {
  projectApiErrorSchema,
  projectDeleteApiErrorSchema,
  projectRelocateApiErrorSchema,
} from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  addProjectInputSchema,
  addProjectOutputSchema,
  deleteProjectOutputSchema,
  projectRouteParamsSchema,
  relocateProjectInputSchema,
  relocateProjectOutputSchema,
} from './types.js';

export const projectsEndpoints = {
  add: {
    id: 'projects.add',
    method: 'POST',
    path: '/projects',
    body: addProjectInputSchema,
    output: addProjectOutputSchema,
    errors: projectApiErrorSchema,
  },
  relocate: {
    id: 'projects.relocate',
    method: 'POST',
    path: '/projects/:projectId/relocate',
    params: projectRouteParamsSchema,
    body: relocateProjectInputSchema,
    output: relocateProjectOutputSchema,
    errors: projectRelocateApiErrorSchema,
  },
  delete: {
    id: 'projects.delete',
    method: 'DELETE',
    path: '/projects/:projectId',
    params: projectRouteParamsSchema,
    output: deleteProjectOutputSchema,
    errors: projectDeleteApiErrorSchema,
  },
} as const satisfies {
  readonly add: ApiEndpoint<
    typeof addProjectInputSchema,
    typeof addProjectOutputSchema,
    typeof projectApiErrorSchema
  >;
  readonly relocate: ApiEndpoint<
    typeof relocateProjectInputSchema,
    typeof relocateProjectOutputSchema,
    typeof projectRelocateApiErrorSchema,
    typeof projectRouteParamsSchema
  >;
  readonly delete: ApiEndpoint<
    undefined,
    typeof deleteProjectOutputSchema,
    typeof projectDeleteApiErrorSchema,
    typeof projectRouteParamsSchema
  >;
};
