import { workspaceActiveContextApiErrorSchema, workspaceGetApiErrorSchema } from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import { setActiveContextInputSchema, workspaceSnapshotSchema } from './types.js';

export const workspaceEndpoints = {
  get: {
    id: 'workspace.get',
    method: 'GET',
    path: '/workspace',
    output: workspaceSnapshotSchema,
    errors: workspaceGetApiErrorSchema,
  },
  setActiveContext: {
    id: 'workspace.setActiveContext',
    method: 'PATCH',
    path: '/workspace/active-context',
    body: setActiveContextInputSchema,
    output: workspaceSnapshotSchema,
    errors: workspaceActiveContextApiErrorSchema,
  },
} as const satisfies {
  readonly get: ApiEndpoint<
    undefined,
    typeof workspaceSnapshotSchema,
    typeof workspaceGetApiErrorSchema
  >;
  readonly setActiveContext: ApiEndpoint<
    typeof setActiveContextInputSchema,
    typeof workspaceSnapshotSchema,
    typeof workspaceActiveContextApiErrorSchema
  >;
};
