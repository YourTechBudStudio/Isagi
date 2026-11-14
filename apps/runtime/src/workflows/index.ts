/**
 * The workflows module's public surface: the engine, its module layer, its HTTP routes, and
 * the deletion ports (project-scoped run erasure, and ending the runs of a deleted surface or
 * worktree).
 */

export { registerWorkflowsRoutes } from './api.js';
export { WorkflowEngine, startEngine } from './engine/service.js';
// The workspace's `ProjectDeletionParticipant` port, implemented over workflow runs. Only the
// composition root wires it.
export { WorkflowProjectErasure } from './erasure.js';
// The environment's `EnvironmentDeletionParticipant` port, implemented over workflow runs. Only the
// composition root wires it.
export { WorkflowEnvironmentDeletion } from './environment-deletion.js';
export { WorkflowEngineError } from './errors.js';
export { WorkflowsLayer } from './layer.js';
export {
  ContentPublishError,
  ContentUnavailable,
  type ContentCapture,
} from './store/content-store.js';
export { WorkflowLoadError, type LoadedWorkflowArtifact } from './structure/loader.js';
