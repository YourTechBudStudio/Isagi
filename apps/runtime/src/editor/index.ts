/**
 * The editor module's public surface: Code Server provisioning and durable editor contexts.
 */
export { editorApiError, registerEditorApi } from './api.js';
export { deriveEditorContextFacts } from './contexts/projection.js';
// The canonical `editor_contexts` decoder. Exported because the surfaces read composition joins
// editor rows onto panes and must not carry a second attempt decoder; the dependency runs
// environment -> editor and never back.
export { editorContextRow } from './contexts/row-mapper.js';
export { EditorContextService, editorLockKey } from './contexts/service.js';
export type { EditorContextRow, EditorReadinessObservation } from './contexts/types.js';
export { EditorProvisioning, EditorUnavailable } from './provisioning/service.js';

// Composition-root wiring only: `app/layer.ts` still provides these by hand until the services wire
// their own module dependencies (S3.7). No other module imports them.
export { EditorContextRepository } from './contexts/repository.js';
export { EditorInstallIo } from './provisioning/install-io.js';
