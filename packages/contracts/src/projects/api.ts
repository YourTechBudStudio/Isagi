import { projectApiErrorSchema } from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import { workspaceSnapshotSchema } from '../workspace/types.js';
import { addProjectInputSchema } from './types.js';

export const projectsEndpoints = {
  add: {
    id: 'projects.add',
    method: 'POST',
    path: '/projects',
    body: addProjectInputSchema,
    output: workspaceSnapshotSchema,
    errors: projectApiErrorSchema,
  },
} as const satisfies {
  readonly add: ApiEndpoint<
    typeof addProjectInputSchema,
    typeof workspaceSnapshotSchema,
    typeof projectApiErrorSchema
  >;
};
