/**
 * The workflows module's public surface: the engine, its HTTP routes, and the services other
 * runtime code composes (discovery, the on-disk content store, and project-scoped run erasure).
 */

export { registerWorkflowApi } from './api.js';
export { WorkflowEngine, startEngine } from './engine/service.js';
// The workspace's `ProjectDeletionParticipant` port, implemented over workflow runs. Only the
// composition root wires it.
export { WorkflowProjectErasure } from './erasure.js';
export { WorkflowEngineError } from './errors.js';
export {
  ContentPublishError,
  ContentUnavailable,
  type ContentCapture,
  makeWorkflowContentStore,
  WorkflowContentStore,
} from './store/content-store.js';
export { WorkflowLoadError, type LoadedWorkflowArtifact } from './structure/loader.js';
export { WorkflowRegistry } from './structure/registry.js';
