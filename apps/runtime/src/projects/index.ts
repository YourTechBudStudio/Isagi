/**
 * The project and worktree registry every other module refers to. `ProjectRepository` is this
 * module's service: every `projects`/`worktrees` read and write goes through it.
 */
export {
  ProjectRepository,
  type ProjectOrderMoveResult,
  type WorkspaceReconcileProjectWorktreesResult,
  type WorktreeOrderMoveResult,
} from './repository.js';
export { ProjectsLayer } from './layer.js';
export type { DiscoveredWorktree, ProjectRow, ProjectStatus, WorktreeRow } from './types.js';
export type {
  CommandPortPathConfig,
  WorktreeCommandCatalogConfig,
  WorktreeCommandConfig,
  WorktreeCommandPortConfig,
  WorktreeHooksConfig,
  WorktreePostCreateHook,
} from './config/config-schema.js';
export {
  ProjectConfigError,
  loadWorktreeCommandCatalog,
  loadWorktreeHooks,
} from './config/service.js';
