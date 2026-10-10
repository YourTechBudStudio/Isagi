export {
  ProjectOrderError,
  WorkspaceError,
  WorkspaceService,
  WorktreeOrderError,
} from './service.js';
export type { WorkspaceServiceError } from './service.js';
export { DetachedWorktreeError } from './detached-worktree.js';
export { ProjectDeletionParticipant } from './project-deletion-participant.js';
export { WorktreeDeleteDiagnosticsReader } from './delete-diagnostics.js';
export { workspaceApiError, workspaceRejections, type WorkspaceRejection } from './api-errors.js';
export { NewDirectoryRejected } from './new-directory.js';
export type { DetachedWorktree, DetachedWorktreeInput } from './detached-worktree.js';
export { StateFile, StateFileError } from './state-file.js';
export { registerWorkspaceApi } from './api.js';
export { registerPathsApi } from './path-suggestions-api.js';

// Composition-root wiring only: `app/layer.ts` still provides these by hand until the services wire
// their own module dependencies (S3.7). No other module imports them.
export { WorktreeSetupRepository } from './setup/repository.js';
export { WorktreeSetupService } from './setup/service.js';
