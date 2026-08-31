import { editorApiErrorSchema } from '../api/errors.js';
import type { ApiEndpoint } from '../api/types.js';
import {
  editorContextRouteParamsSchema,
  editorDiagnosticsOutputSchema,
  editorDiagnosticsQuerySchema,
  ensureEditorRuntimeInputSchema,
  ensureEditorRuntimeOutputSchema,
  openEditorOutputSchema,
  openEditorRouteParamsSchema,
  retryEditorProvisioningOutputSchema,
} from './types.js';

export const editorEndpoints = {
  /**
   * The worktree is the whole input and it is a path parameter, so there is no
   * request body; a body would only invite a second target.
   */
  open: {
    id: 'worktrees.openEditor',
    method: 'POST',
    path: '/worktrees/:worktreeId/editor',
    params: openEditorRouteParamsSchema,
    output: openEditorOutputSchema,
    errors: editorApiErrorSchema,
  },
  /**
   * Keyed by editor context, not worktree: the pane already holds both ids from
   * surface detail, and the runtime re-reads the context's worktree itself.
   */
  ensureRuntime: {
    id: 'editorContexts.ensureRuntime',
    method: 'POST',
    path: '/editor-contexts/:editorContextId/runtime',
    params: editorContextRouteParamsSchema,
    body: ensureEditorRuntimeInputSchema,
    output: ensureEditorRuntimeOutputSchema,
    errors: editorApiErrorSchema,
  },
  /**
   * Additionally names its incarnation. The durable context outlives its
   * incarnations, so a read keyed only by context would happily return one
   * incarnation's startup output to a pane that asked about another.
   */
  diagnostics: {
    id: 'editorContexts.diagnostics',
    method: 'GET',
    path: '/editor-contexts/:editorContextId/diagnostics',
    params: editorContextRouteParamsSchema,
    query: editorDiagnosticsQuerySchema,
    output: editorDiagnosticsOutputSchema,
    errors: editorApiErrorSchema,
  },
  /**
   * The provisioning *state* is composed into the control-plane snapshot, but
   * the *operation* belongs to the domain that owns the work.
   */
  retryProvisioning: {
    id: 'editor.retryProvisioning',
    method: 'POST',
    path: '/editor/provisioning/retry',
    output: retryEditorProvisioningOutputSchema,
    errors: editorApiErrorSchema,
  },
} as const satisfies {
  readonly open: ApiEndpoint<
    undefined,
    typeof openEditorOutputSchema,
    typeof editorApiErrorSchema,
    typeof openEditorRouteParamsSchema
  >;
  readonly ensureRuntime: ApiEndpoint<
    typeof ensureEditorRuntimeInputSchema,
    typeof ensureEditorRuntimeOutputSchema,
    typeof editorApiErrorSchema,
    typeof editorContextRouteParamsSchema
  >;
  readonly diagnostics: ApiEndpoint<
    undefined,
    typeof editorDiagnosticsOutputSchema,
    typeof editorApiErrorSchema,
    typeof editorContextRouteParamsSchema,
    typeof editorDiagnosticsQuerySchema
  >;
  readonly retryProvisioning: ApiEndpoint<
    undefined,
    typeof retryEditorProvisioningOutputSchema,
    typeof editorApiErrorSchema
  >;
};
