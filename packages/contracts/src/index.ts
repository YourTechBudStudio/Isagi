import { healthEndpoint } from './health/api.js';
import { pathsEndpoints } from './paths/api.js';
import { projectsEndpoints } from './projects/api.js';
import { runtimeEventsWebSocketEndpoint } from './runtime-events/api.js';
import { surfacesEndpoints } from './surfaces/api.js';
import { workspaceEndpoints } from './workspace/api.js';
import { worktreesEndpoints } from './worktrees/api.js';

export const apiEndpoints = {
  health: healthEndpoint,
  workspace: workspaceEndpoints,
  projects: projectsEndpoints,
  runtimeEvents: runtimeEventsWebSocketEndpoint,
  worktrees: worktreesEndpoints,
  surfaces: surfacesEndpoints,
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
  sessionLaunchApiErrorSchema,
  sessionLaunchRejectedErrorSchema,
  sessionLaunchRejectionReasonSchema,
  surfaceApiErrorSchema,
  surfaceRejectedErrorSchema,
  surfaceRejectionReasonSchema,
  workspaceActiveContextApiErrorSchema,
  workspaceActiveContextRejectedErrorSchema,
  workspaceActiveContextRejectionReasonSchema,
  workspaceGetApiErrorSchema,
  workspaceReconcileApiErrorSchema,
  workspaceReconcileRejectedErrorSchema,
  workspaceReconcileRejectionReasonSchema,
  worktreeEnvironmentFocusApiErrorSchema,
  worktreeEnvironmentFocusRejectedErrorSchema,
  worktreeEnvironmentFocusRejectionReasonSchema,
  worktreeBranchListApiErrorSchema,
  worktreeBranchListRejectedErrorSchema,
  worktreeDeleteApiErrorSchema,
  worktreeDeleteRejectedErrorSchema,
  worktreeDeleteRejectionReasonSchema,
  worktreeOpenApiErrorSchema,
  worktreeOpenRejectedErrorSchema,
  worktreeOperationRejectionReasonSchema,
  worktreeSetupApiErrorSchema,
  worktreeSetupRejectedErrorSchema,
  worktreeSetupRejectionReasonSchema,
} from './api/errors.js';
export type {
  ProjectPathRejectedError,
  ProjectPathRejectionReason,
  ProjectRelocationRejectedError,
  ProjectRelocationRejectionReason,
  SessionLaunchRejectedError,
  SessionLaunchRejectionReason,
  SurfaceRejectedError,
  SurfaceRejectionReason,
  WorkspaceActiveContextRejectedError,
  WorkspaceActiveContextRejectionReason,
  WorkspaceReconcileRejectedError,
  WorkspaceReconcileRejectionReason,
  WorktreeEnvironmentFocusRejectedError,
  WorktreeEnvironmentFocusRejectionReason,
  WorktreeBranchListRejectedError,
  WorktreeDeleteRejectedError,
  WorktreeDeleteRejectionReason,
  WorktreeOpenRejectedError,
  WorktreeOperationRejectionReason,
  WorktreeSetupRejectedError,
  WorktreeSetupRejectionReason,
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
export { runtimeEventsWebSocketEndpoint } from './runtime-events/api.js';
export {
  ptySessionChangedEventSchema,
  runtimeEventBaseSchema,
  runtimeEventSchema,
  runtimeEventTypeSchema,
} from './runtime-events/types.js';
export type {
  PtySessionChangedEvent,
  RuntimeEvent,
  RuntimeEventBase,
  RuntimeEventType,
} from './runtime-events/types.js';
export { ptySessionWebSocketEndpoint, surfacesEndpoints } from './surfaces/api.js';
export {
  agentHarnessSchema,
  deleteSurfaceOutputSchema,
  launchAgentSessionInputSchema,
  launchSessionOutputSchema,
  ptySessionBackendSchema,
  ptySessionLogModeSchema,
  ptySessionRouteParamsSchema,
  ptySessionMetadataSchema,
  ptySessionPurposeSchema,
  ptySessionStatusReasonSchema,
  ptySessionStatusSchema,
  ptyWebSocketErrorCodeSchema,
  ptyWebSocketInputMessageSchema,
  ptyWebSocketOutputMessageSchema,
  renameSurfaceInputSchema,
  renameSurfaceOutputSchema,
  runtimeSurfaceKindSchema,
  setWorktreeEnvironmentFocusInputSchema,
  surfaceDetailSchema,
  surfaceDeleteWarningSchema,
  surfaceLayoutAxisSchema,
  surfaceLayoutNodeSchema,
  surfaceLayoutSizingSchema,
  surfacePaneSchema,
  surfacePaneRouteParamsSchema,
  surfaceRouteParamsSchema,
  worktreeEnvironmentFocusOutputSchema,
  worktreeEnvironmentFocusRouteParamsSchema,
} from './surfaces/types.js';
export type {
  AgentHarness,
  DeleteSurfaceOutput,
  LaunchAgentSessionInput,
  LaunchSessionOutput,
  PtySessionBackend,
  PtySessionLogMode,
  PtySessionRouteParams,
  PtySessionMetadata,
  PtySessionPurpose,
  PtySessionStatusReason,
  PtySessionStatus,
  PtyWebSocketErrorCode,
  PtyWebSocketInputMessage,
  PtyWebSocketOutputMessage,
  RenameSurfaceInput,
  RenameSurfaceOutput,
  RuntimeSurfaceKind,
  SetWorktreeEnvironmentFocusInput,
  SurfaceDeleteWarning,
  SurfaceDetail,
  SurfaceLayoutLeaf,
  SurfaceLayoutNode,
  SurfaceLayoutSplit,
  SurfacePane,
  SurfacePaneRouteParams,
  SurfaceRouteParams,
  WorktreeEnvironmentFocusOutput,
  WorktreeEnvironmentFocusRouteParams,
} from './surfaces/types.js';
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
  WorkspaceSurfaceMetadata,
  WorkspaceSnapshot,
  Worktree,
} from './workspace/types.js';

export { worktreesEndpoints } from './worktrees/api.js';
export {
  branchRemovalModeSchema,
  checkoutRemovalModeSchema,
  deleteWorktreeInputSchema,
  deleteWorktreeOutputSchema,
  deleteWorktreePreflightOutputSchema,
  listProjectBranchesOutputSchema,
  openWorktreeInputSchema,
  openWorktreeOutputSchema,
  openWorktreeStatusSchema,
  projectWorktreeRouteParamsSchema,
  worktreeBranchRemovalSchema,
  worktreeBaseRefSchema,
  worktreeBranchSchema,
  worktreeRouteParamsSchema,
  worktreeSetupHookTypeSchema,
  worktreeSetupLifecycleSchema,
  worktreeSetupPreflightOutputSchema,
  worktreeSetupPreflightStatusSchema,
  worktreeSetupResultSchema,
  worktreeSetupSummarySchema,
  worktreeSetupTrustInputSchema,
  worktreeSetupTrustOutputSchema,
} from './worktrees/types.js';
export type {
  BranchRemovalMode,
  CheckoutRemovalMode,
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  DeleteWorktreePreflightOutput,
  ListProjectBranchesOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  OpenWorktreeStatus,
  ProjectWorktreeRouteParams,
  WorktreeBranchRemoval,
  WorktreeBaseRef,
  WorktreeBranch,
  WorktreeRouteParams,
  WorktreeSetupHookType,
  WorktreeSetupLifecycle,
  WorktreeSetupPreflightOutput,
  WorktreeSetupPreflightStatus,
  WorktreeSetupResult,
  WorktreeSetupSummary,
  WorktreeSetupTrustInput,
  WorktreeSetupTrustOutput,
} from './worktrees/types.js';
