import { healthEndpoint } from './health/api.js';
import { pathsEndpoints } from './paths/api.js';
import { projectsEndpoints } from './projects/api.js';
import { workspaceEndpoints } from './workspace/api.js';

export const apiEndpoints = {
  health: healthEndpoint,
  workspace: workspaceEndpoints,
  projects: projectsEndpoints,
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
  ApiMethod,
} from './api/types.js';

export {
  gitCommandFailedErrorSchema,
  projectApiErrorSchema,
  projectPathRejectedErrorSchema,
  projectPathRejectionReasonSchema,
  runtimeDataDirectoryFailedErrorSchema,
  runtimeDatabaseFailedErrorSchema,
  runtimeStateFileFailedErrorSchema,
  workspaceActiveContextApiErrorSchema,
  workspaceActiveContextRejectedErrorSchema,
  workspaceActiveContextRejectionReasonSchema,
  workspaceGetApiErrorSchema,
} from './api/errors.js';
export type {
  ProjectPathRejectedError,
  ProjectPathRejectionReason,
  WorkspaceActiveContextRejectedError,
  WorkspaceActiveContextRejectionReason,
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
export { addProjectInputSchema } from './projects/types.js';
export type { AddProjectInput } from './projects/types.js';
export { workspaceEndpoints } from './workspace/api.js';
export {
  activeContextSchema,
  attentionStateSchema,
  commandSchema,
  projectSchema,
  projectStatusSchema,
  setActiveContextInputSchema,
  surfaceSchema,
  workspaceSnapshotSchema,
  worktreeSchema,
} from './workspace/types.js';
export type {
  ActiveContext,
  AttentionState,
  Project,
  ProjectStatus,
  SetActiveContextInput,
  WorkspaceSnapshot,
  Worktree,
} from './workspace/types.js';
