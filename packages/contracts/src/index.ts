import { healthEndpoint } from './health/api.js';
import { pathsEndpoints } from './paths/api.js';
import { projectsEndpoints } from './projects/api.js';
import { workspaceEndpoints } from './workspace/api.js';
import { worktreesEndpoints } from './worktrees/api.js';

export const apiEndpoints = {
  health: healthEndpoint,
  workspace: workspaceEndpoints,
  projects: projectsEndpoints,
  worktrees: worktreesEndpoints,
  paths: pathsEndpoints,
} as const;

export {
  apiBaseErrorResponseSchema,
  apiBasePath,
  apiErrorBaseSchema,
  apiErrorResponseSchema,
  apiInfrastructureErrorCodeSchema,
  apiInfrastructureErrorSchema,
  apiSuccessResponseSchema,
  responseMetaSchema,
} from './api/responses.js';
export type {
  ApiError,
  ApiErrorResponse,
  ApiInfrastructureError,
  ApiInfrastructureErrorCode,
  ApiSuccessResponse,
  ResponseMeta,
} from './api/responses.js';

export type {
  ApiEndpoint,
  ApiEndpointBody,
  ApiEndpointError,
  ApiEndpointOutput,
  ApiEndpointParams,
  ApiEndpointRequestArgs,
  ApiMethod,
} from './api/types.js';

export {
  gitCommandFailedErrorSchema,
  projectApiErrorSchema,
  projectDeleteApiErrorSchema,
  projectPathRejectedErrorSchema,
  projectPathRejectionReasonSchema,
  projectRelocateApiErrorSchema,
  projectRelocationRejectedErrorSchema,
  projectRelocationRejectionReasonSchema,
  runtimeDataDirectoryFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeStateFileFailedErrorSchema,
  workspaceActiveContextApiErrorSchema,
  workspaceActiveContextRejectedErrorSchema,
  workspaceActiveContextRejectionReasonSchema,
  workspaceGetApiErrorSchema,
  workspaceReconcileApiErrorSchema,
  workspaceReconcileRejectedErrorSchema,
  workspaceReconcileRejectionReasonSchema,
  worktreeBranchListApiErrorSchema,
  worktreeBranchListRejectedErrorSchema,
  worktreeOpenApiErrorSchema,
  worktreeOpenRejectedErrorSchema,
  worktreeOperationRejectionReasonSchema,
} from './api/errors.js';
export type {
  ProjectPathRejectedError,
  ProjectPathRejectionReason,
  ProjectRelocationRejectedError,
  ProjectRelocationRejectionReason,
  WorkspaceActiveContextRejectedError,
  WorkspaceActiveContextRejectionReason,
  WorkspaceReconcileRejectedError,
  WorkspaceReconcileRejectionReason,
  WorktreeBranchListRejectedError,
  WorktreeOpenRejectedError,
  WorktreeOperationRejectionReason,
} from './api/errors.js';

export { healthEndpoint } from './health/api.js';
export { healthOutputSchema } from './health/types.js';
export type { HealthOutput } from './health/types.js';

export { pathsEndpoints } from './paths/api.js';
export {
  pathSuggestInputSchema,
  pathSuggestOutputSchema,
  pathSuggestionSchema,
} from './paths/types.js';
export type { PathSuggestInput, PathSuggestOutput, PathSuggestion } from './paths/types.js';

export { projectsEndpoints } from './projects/api.js';
export {
  addProjectInputSchema,
  addProjectOutputSchema,
  deleteProjectOutputSchema,
  projectRouteParamsSchema,
  relocateProjectInputSchema,
  relocateProjectOutputSchema,
} from './projects/types.js';
export type {
  AddProjectInput,
  AddProjectOutput,
  DeleteProjectOutput,
  ProjectRouteParams,
  RelocateProjectInput,
  RelocateProjectOutput,
} from './projects/types.js';
export { workspaceEndpoints } from './workspace/api.js';
export {
  activeContextOutputSchema,
  activeContextPersistenceInputSchema,
  activeContextSchema,
  attentionStateSchema,
  commandSchema,
  projectSchema,
  projectStatusSchema,
  reconcileWorkspaceInputSchema,
  reconcileWorkspaceOutputSchema,
  reconciliationFindingSchema,
  setActiveContextInputSchema,
  surfaceSchema,
  workspaceSnapshotSchema,
  worktreeSchema,
} from './workspace/types.js';
export type {
  ActiveContext,
  ActiveContextOutput,
  ActiveContextPersistenceInput,
  AttentionState,
  Project,
  ProjectStatus,
  ReconcileWorkspaceInput,
  ReconcileWorkspaceOutput,
  ReconciliationFinding,
  SetActiveContextInput,
  SetActiveContextOutput,
  WorkspaceSnapshot,
  Worktree,
} from './workspace/types.js';

export { worktreesEndpoints } from './worktrees/api.js';
export {
  listProjectBranchesOutputSchema,
  openWorktreeInputSchema,
  openWorktreeOutputSchema,
  projectWorktreeRouteParamsSchema,
  worktreeBranchSchema,
} from './worktrees/types.js';
export type {
  ListProjectBranchesOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  ProjectWorktreeRouteParams,
  WorktreeBranch,
} from './worktrees/types.js';
