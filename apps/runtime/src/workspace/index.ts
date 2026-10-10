export {
  ProjectOrderError,
  WorkspaceError,
  WorkspaceService,
  WorktreeOrderError,
} from './service.js';
export type { WorkspaceServiceError } from './service.js';
export { DetachedWorktreeError } from './detached-worktree.js';
export { ProjectDeletionParticipant } from './project-deletion-participant.js';
export { workspaceApiError, workspaceRejections, type WorkspaceRejection } from './api-errors.js';
export { NewDirectoryRejected } from './new-directory.js';
export type { DetachedWorktree, DetachedWorktreeInput } from './detached-worktree.js';
export { StateFile, StateFileError } from './state-file.js';
export { registerWorkspaceRoutes } from './api.js';
export { WorkspaceLayer } from './layer.js';
