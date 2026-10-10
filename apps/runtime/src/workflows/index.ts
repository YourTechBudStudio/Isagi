/**
 * The workflows module's public surface: the engine, its module layer, its HTTP routes, and
 * project-scoped run erasure (the workspace's deletion port).
 */

export { registerWorkflowsRoutes } from './api.js';
export { WorkflowEngine, startEngine } from './engine/service.js';
// The workspace's `ProjectDeletionParticipant` port, implemented over workflow runs. Only the
// composition root wires it.
export { WorkflowProjectErasure } from './erasure.js';
export { WorkflowEngineError } from './errors.js';
export { WorkflowsLayer } from './layer.js';
export {
  ContentPublishError,
  ContentUnavailable,
  type ContentCapture,
} from './store/content-store.js';
export { WorkflowLoadError, type LoadedWorkflowArtifact } from './structure/loader.js';
