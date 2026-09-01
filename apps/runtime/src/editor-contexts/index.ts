export {
  EditorContextRepository,
  EditorContextRepositoryLive,
  EditorContextTransitionRejected,
} from './editor-contexts.repository.js';
export type {
  EditorContextRepositoryService,
  EditorContextTransitionOutcome,
} from './editor-contexts.repository.js';
export {
  EditorContextService,
  EditorContextServiceLive,
  editorLockKey,
} from './editor-contexts.service.js';
export type { EditorContextServiceShape } from './editor-contexts.service.js';
// `makeEditorContextService` is deliberately absent: the factory exists for
// tests that need to inject a probe, and a production caller has exactly one
// correct way to build this service.
export { EditorDiagnosticsUnavailable, EditorError, EditorLaunchFailed } from './errors.js';
// Re-exported so API error mapping has one import for the editor's whole
// expected-failure channel rather than reaching into provisioning for a third.
export { EditorUnavailable } from '../editor-provisioning/index.js';
export { editorOrigin } from './launch-spec.js';
export { deriveEditorContextFacts, editorProcessDiagnostic } from './projection.js';
// The canonical `editor_contexts` decoder. Exported because the surfaces read
// composition joins editor rows onto panes and must not carry a second attempt
// decoder; the dependency runs surfaces -> editor-contexts and never back.
export { editorContextRow, EditorContextRowInvariantViolation } from './row-mapper.js';
export type {
  EditorAttemptRecord,
  EditorContextFacts,
  EditorContextRow,
  EditorIncarnationHandoff,
  EditorReadinessObservation,
} from './types.js';
