export { Git, GitCommandError } from './command.js';
export type { GitCommandFailure } from './command.js';
export { displayBranch, parseGitWorktreeListPorcelain } from './worktree.list.js';
export type { GitWorktreeRecord } from './worktree.list.js';
export { branchPathHash, listGitWorktrees, listLocalBranches } from './repository.js';
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
