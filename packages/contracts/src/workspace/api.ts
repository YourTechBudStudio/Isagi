import {
  workspaceActiveContextApiErrorSchema,
  workspaceGetApiErrorSchema,
  workspaceReconcileApiErrorSchema,
} from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  activeContextOutputSchema,
  activeContextPersistenceInputSchema,
  reconcileWorkspaceInputSchema,
  reconcileWorkspaceOutputSchema,
  workspaceSnapshotSchema,
} from './types.js';

export const workspaceEndpoints = {
  get: {
    id: 'workspace.get',
    method: 'GET',
    path: '/workspace',
    output: workspaceSnapshotSchema,
    errors: workspaceGetApiErrorSchema,
  },
  getActiveContext: {
    id: 'workspace.getActiveContext',
    method: 'GET',
    path: '/workspace/active-context',
    output: activeContextOutputSchema,
    errors: workspaceActiveContextApiErrorSchema,
  },
  setActiveContext: {
    id: 'workspace.setActiveContext',
    method: 'PUT',
    path: '/workspace/active-context',
    body: activeContextPersistenceInputSchema,
    output: activeContextOutputSchema,
    errors: workspaceActiveContextApiErrorSchema,
  },
  reconcile: {
    id: 'workspace.reconcile',
    method: 'POST',
    path: '/workspace/reconcile',
    body: reconcileWorkspaceInputSchema,
    output: reconcileWorkspaceOutputSchema,
    errors: workspaceReconcileApiErrorSchema,
  },
} as const satisfies {
  readonly get: ApiEndpoint<
    undefined,
    typeof workspaceSnapshotSchema,
    typeof workspaceGetApiErrorSchema
  >;
  readonly getActiveContext: ApiEndpoint<
    undefined,
    typeof activeContextOutputSchema,
    typeof workspaceActiveContextApiErrorSchema
  >;
  readonly setActiveContext: ApiEndpoint<
    typeof activeContextPersistenceInputSchema,
    typeof activeContextOutputSchema,
    typeof workspaceActiveContextApiErrorSchema
  >;
  readonly reconcile: ApiEndpoint<
    typeof reconcileWorkspaceInputSchema,
    typeof reconcileWorkspaceOutputSchema,
    typeof workspaceReconcileApiErrorSchema
  >;
};
