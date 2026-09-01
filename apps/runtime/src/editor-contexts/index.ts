export {
  EditorContextRepository,
  EditorContextRepositoryLive,
  EditorContextTransitionRejected,
} from './editor-contexts.repository.js';
export type {
  EditorContextRepositoryService,
  EditorContextTransitionOutcome,
} from './editor-contexts.repository.js';
// The canonical `editor_contexts` decoder. Exported because the surfaces read
// composition joins editor rows onto panes and must not carry a second attempt
// decoder; the dependency runs surfaces -> editor-contexts and never back.
export { editorContextRow, EditorContextRowInvariantViolation } from './row-mapper.js';
export type { EditorAttemptRecord, EditorContextRow, EditorIncarnationHandoff } from './types.js';
