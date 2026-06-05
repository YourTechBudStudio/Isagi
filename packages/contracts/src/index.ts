import { healthContract } from './health/contracts.js';
import { pathsContract } from './paths/contracts.js';
import { projectsContract, workspaceContract } from './workspace/contracts.js';

export { healthContract } from './health/contracts.js';
export { healthOutputSchema } from './health/types.js';
export type { HealthOutput } from './health/types.js';

export { pathsContract } from './paths/contracts.js';
export {
  pathSuggestInputSchema,
  pathSuggestOutputSchema,
  pathSuggestionSchema,
} from './paths/types.js';
export type { PathSuggestInput, PathSuggestOutput, PathSuggestion } from './paths/types.js';

export { projectsContract, workspaceContract } from './workspace/contracts.js';
export {
  activeContextSchema,
  addProjectInputSchema,
  attentionStateSchema,
  commandSchema,
  projectSchema,
  projectStatusSchema,
  setActiveContextInputSchema,
  surfaceSchema,
  workspaceSnapshotSchema,
  worktreeSchema,
  worktreeStatusSchema,
} from './workspace/types.js';
export type {
  ActiveContext,
  AttentionState,
  Project,
  ProjectStatus,
  WorkspaceSnapshot,
  Worktree,
} from './workspace/types.js';

export const contract = {
  health: healthContract,
  workspace: workspaceContract,
  projects: projectsContract,
  paths: pathsContract,
};

export type IsagiContract = typeof contract;
