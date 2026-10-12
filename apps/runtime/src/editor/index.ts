/**
 * The editor module's public surface: Code Server provisioning and durable editor contexts.
 */
export { editorRejection, registerEditorRoutes } from './api.js';
export type { EditorFailure, EditorRejection } from './api.js';
export { deriveEditorContextFacts } from './contexts/projection.js';
// The canonical `editor_contexts` decoder. Exported because the surfaces read composition joins
// editor rows onto panes and must not carry a second attempt decoder; the dependency runs
// environment -> editor and never back.
export { editorContextRow } from './contexts/row-mapper.js';
export { EditorContextService, editorLockKey } from './contexts/service.js';
export type { EditorContextRow, EditorReadinessObservation } from './contexts/types.js';
export { EditorProvisioning, EditorUnavailable } from './provisioning/service.js';
export { EditorLayer } from './layer.js';
