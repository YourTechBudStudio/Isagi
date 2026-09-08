export { Git, GitCommandError, GitLive } from './git.command.js';
export type { GitCommandFailure, GitService } from './git.command.js';
export { displayBranch, parseGitWorktreeListPorcelain } from './worktree.list.js';
export type { GitWorktreeRecord } from './worktree.list.js';
export { branchPathHash, listGitWorktrees, listLocalBranches } from './git.repository.js';
export {
  classifyProjectRoot,
  normalizeExistingDirectory,
  ProjectPathValidationError,
  validateProjectRoot,
} from './project-root.js';
export type {
  ProjectPathValidationCode,
  ProjectRootClassification,
  ValidProjectRoot,
} from './project-root.js';
