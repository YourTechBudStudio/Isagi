import type { Effect } from 'effect';

import type {
  AcceptHarnessPolicyInput,
  AcceptHarnessPolicyOutput,
  ActiveContextOutput,
  ActiveContextPersistenceInput,
  AddProjectOutput,
  AgentHarness,
  ControlPlaneSnapshot,
  CreateSurfaceInput,
  CreateSurfaceOutput,
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  DeletePaneOutput,
  DeleteSurfaceOutput,
  DeleteProjectOutput,
  PaneSessionClaimInput,
  PaneSessionClaimOutput,
  PaneSessionCreateInput,
  ListProjectBranchesOutput,
  MoveProjectOrderInput,
  MoveProjectOrderOutput,
  MoveSurfaceOrderInput,
  MoveSurfaceOrderOutput,
  MoveWorktreeOrderInput,
  MoveWorktreeOrderOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  DeleteWorktreePreflightOutput,
  EditorDiagnosticsOutput,
  EnsureEditorRuntimeInput,
  EnsureEditorRuntimeOutput,
  OpenEditorInput,
  OpenEditorOutput,
  PathSuggestOutput,
  RetryEditorProvisioningOutput,
  RenameSurfaceOutput,
  ReconcileWorkspaceInput,
  SetSplitWeightsInput,
  SetSplitWeightsOutput,
  SetWorktreeEnvironmentFocusInput,
  SplitPaneInput,
  StartPaneInput,
  SurfaceDetail,
  WorktreeEnvironmentFocusOutput,
  WorktreeSetupPreflightOutput,
  WorktreeSetupTrustInput,
  WorktreeSetupTrustOutput,
  WorktreeCommandsOutput,
  CommandActionOutput,
  CommandLogMetadataOutput,
  ClientSettingsOutput,
  ReconcileWorkspaceOutput,
  RefreshInventoryOutput,
  RelocateProjectOutput,
  WorkspaceSnapshot,
  AdvanceWorkflowInput,
  GetWorkflowCheckpointOutput,
  GetWorkflowExecutionOutput,
  GetWorkflowRunOutput,
  GetWorkflowStructureOutput,
  ListWorkflowDescriptorsInput,
  ListWorkflowDescriptorsOutput,
  ListWorkflowEventsQuery,
  ListWorkflowEventsOutput,
  ListWorkflowCheckpointsOutput,
  ListWorkflowCheckpointsQuery,
  ListWorkflowRunsQuery,
  ListWorkflowRunsOutput,
  StartWorkflowInput,
  StartWorkflowOutput,
  WorkflowRunControlOutput,
  DurableSessionInventory,
} from '@isagi/contracts';

import { runtimeErrorCopy } from '../../copy/index.js';
import { classifyRuntimeFailure } from '../runtime/classify.js';
import { RuntimeApi } from '../runtime/client.js';

export class UserVisibleError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'UserVisibleError';
  }
}

export function fetchClientSettings(): Effect.Effect<ClientSettingsOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.fetchClientSettings());
}

export function fetchWorkspace() {
  return RuntimeApi.use((api) => api.fetchWorkspace());
}

export function fetchDurableSessions(): Effect.Effect<DurableSessionInventory, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.fetchDurableSessions());
}

export function fetchWorktreeCommands(
  worktreeId: number,
): Effect.Effect<WorktreeCommandsOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.fetchWorktreeCommands(worktreeId));
}

export function fetchCommandLogMetadata(
  worktreeId: number,
  commandName: string,
): Effect.Effect<CommandLogMetadataOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.fetchCommandLogMetadata(worktreeId, commandName));
}

export function runCommand(
  worktreeId: number,
  commandName: string,
): Effect.Effect<CommandActionOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.runCommand(worktreeId, commandName));
}

export function stopCommand(
  worktreeId: number,
  commandName: string,
): Effect.Effect<CommandActionOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.stopCommand(worktreeId, commandName));
}

export function restartCommand(
  worktreeId: number,
  commandName: string,
): Effect.Effect<CommandActionOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.restartCommand(worktreeId, commandName));
}

export function pauseWorkflow(
  runId: number,
): Effect.Effect<WorkflowRunControlOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.pauseWorkflow(runId));
}

export function resumeWorkflow(
  runId: number,
): Effect.Effect<WorkflowRunControlOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.resumeWorkflow(runId));
}

export function retryWorkflow(
  runId: number,
): Effect.Effect<WorkflowRunControlOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.retryWorkflow(runId));
}

export function cancelWorkflow(
  runId: number,
): Effect.Effect<WorkflowRunControlOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.cancelWorkflow(runId));
}

export function dismissWorkflow(
  runId: number,
): Effect.Effect<WorkflowRunControlOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.dismissWorkflow(runId));
}

export function getWorkflowRun(
  runId: number,
): Effect.Effect<GetWorkflowRunOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.getWorkflowRun(runId));
}

export function listWorkflowRuns(
  query: ListWorkflowRunsQuery,
): Effect.Effect<ListWorkflowRunsOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.listWorkflowRuns(query));
}

export function getWorkflowStructure(
  runId: number,
  artifactHash: string,
): Effect.Effect<GetWorkflowStructureOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.getWorkflowStructure(runId, artifactHash));
}

export function listWorkflowEvents(
  runId: number,
  query: ListWorkflowEventsQuery,
): Effect.Effect<ListWorkflowEventsOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.listWorkflowEvents(runId, query));
}

export function getWorkflowExecution(
  executionId: number,
): Effect.Effect<GetWorkflowExecutionOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.getWorkflowExecution(executionId));
}

export function listWorkflowCheckpoints(
  runId: number,
  query: ListWorkflowCheckpointsQuery,
): Effect.Effect<ListWorkflowCheckpointsOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.listWorkflowCheckpoints(runId, query));
}

export function getWorkflowCheckpoint(
  checkpointId: number,
): Effect.Effect<GetWorkflowCheckpointOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.getWorkflowCheckpoint(checkpointId));
}

export function fetchWorkflowCheckpointFile(
  checkpointId: number,
  path: string,
): Effect.Effect<Blob, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.fetchWorkflowCheckpointFile(checkpointId, path));
}

export function advanceWorkflow(
  runId: number,
  input: AdvanceWorkflowInput,
): Effect.Effect<WorkflowRunControlOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.advanceWorkflow(runId, input));
}

export function listWorkflowDescriptors(
  input: ListWorkflowDescriptorsInput,
): Effect.Effect<ListWorkflowDescriptorsOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.listWorkflowDescriptors(input));
}

export function startWorkflow(
  input: StartWorkflowInput,
): Effect.Effect<StartWorkflowOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.startWorkflow(input));
}

export function fetchActiveContext(): Effect.Effect<ActiveContextOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.fetchActiveContext());
}

export function updateActiveContext(
  input: ActiveContextPersistenceInput,
): Effect.Effect<ActiveContextOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.updateActiveContext(input));
}

export function reconcileWorkspace(
  input: ReconcileWorkspaceInput,
): Effect.Effect<ReconcileWorkspaceOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.reconcileWorkspace(input));
}

export function getSurfaceDetail(
  surfaceId: number,
): Effect.Effect<SurfaceDetail, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.getSurfaceDetail(surfaceId));
}

export function renameSurfaceTitle(
  surfaceId: number,
  title: string,
): Effect.Effect<RenameSurfaceOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.renameSurfaceTitle(surfaceId, title));
}

export function deleteSurface(
  surfaceId: number,
): Effect.Effect<DeleteSurfaceOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.deleteSurface(surfaceId));
}

export function deleteSurfacePane(
  surfaceId: number,
  paneId: number,
): Effect.Effect<DeletePaneOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.deleteSurfacePane(surfaceId, paneId));
}

export function setWorktreeEnvironmentFocus(
  worktreeId: number,
  input: SetWorktreeEnvironmentFocusInput,
): Effect.Effect<WorktreeEnvironmentFocusOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.setWorktreeEnvironmentFocus(worktreeId, input));
}

export function createSurface(
  worktreeId: number,
  input: CreateSurfaceInput,
): Effect.Effect<CreateSurfaceOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.createSurface(worktreeId, input));
}

export function splitPane(
  worktreeId: number,
  input: SplitPaneInput,
): Effect.Effect<CreateSurfaceOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.splitPane(worktreeId, input));
}

/** Starts the first pane of an empty surface. */
export function startPane(
  surfaceId: number,
  input: StartPaneInput,
): Effect.Effect<CreateSurfaceOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.startPane(surfaceId, input));
}

export function setSplitWeights(
  surfaceId: number,
  input: SetSplitWeightsInput,
): Effect.Effect<SetSplitWeightsOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.setSplitWeights(surfaceId, input));
}

export function createPaneSession(
  worktreeId: number,
  input: PaneSessionCreateInput,
): Effect.Effect<PaneSessionClaimOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.createPaneSession(worktreeId, input));
}

export function claimPaneSession(
  worktreeId: number,
  input: PaneSessionClaimInput,
): Effect.Effect<PaneSessionClaimOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.claimPaneSession(worktreeId, input));
}

export function launchAgentSession(
  worktreeId: number,
  harness: AgentHarness,
): Effect.Effect<CreateSurfaceOutput, Error, RuntimeApi> {
  return createSurface(worktreeId, { initialPane: { kind: 'agent_session', harness } });
}

export function launchTerminalSession(
  worktreeId: number,
): Effect.Effect<CreateSurfaceOutput, Error, RuntimeApi> {
  return createSurface(worktreeId, { initialPane: { kind: 'terminal_session' } });
}

export function resolveAgentSessionPtyWebSocketUrl(
  agentSessionId: number,
  attachToken?: string,
): Effect.Effect<string, Error, RuntimeApi> {
  return RuntimeApi.use((api) =>
    api.resolveAgentSessionPtyWebSocketUrl(agentSessionId, attachToken),
  );
}

export function resolveTerminalSessionPtyWebSocketUrl(
  terminalSessionId: number,
  attachToken?: string,
): Effect.Effect<string, Error, RuntimeApi> {
  return RuntimeApi.use((api) =>
    api.resolveTerminalSessionPtyWebSocketUrl(terminalSessionId, attachToken),
  );
}

export function resolveCommandLogStreamWebSocketUrl(
  worktreeId: number,
  commandName: string,
): Effect.Effect<string, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.resolveCommandLogStreamWebSocketUrl(worktreeId, commandName));
}

export function resolveRuntimeEventsWebSocketUrl(): Effect.Effect<string, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.resolveRuntimeEventsWebSocketUrl());
}

export function addProject(path: string): Effect.Effect<AddProjectOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.addProject(path));
}

export function relocateProject(
  projectId: number,
  path: string,
): Effect.Effect<RelocateProjectOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.relocateProject(projectId, path));
}

export function deleteProject(
  projectId: number,
): Effect.Effect<DeleteProjectOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.deleteProject(projectId));
}

export function moveProjectOrder(
  projectId: number,
  input: MoveProjectOrderInput,
): Effect.Effect<MoveProjectOrderOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.moveProjectOrder(projectId, input));
}

export function moveWorktreeOrder(
  projectId: number,
  worktreeId: number,
  input: MoveWorktreeOrderInput,
): Effect.Effect<MoveWorktreeOrderOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.moveWorktreeOrder(projectId, worktreeId, input));
}

export function moveSurfaceOrder(
  worktreeId: number,
  surfaceId: number,
  input: MoveSurfaceOrderInput,
): Effect.Effect<MoveSurfaceOrderOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.moveSurfaceOrder(worktreeId, surfaceId, input));
}

export function listProjectBranches(
  projectId: number,
): Effect.Effect<ListProjectBranchesOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.listProjectBranches(projectId));
}

export function preflightWorktreeSetup(
  projectId: number,
): Effect.Effect<WorktreeSetupPreflightOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.preflightWorktreeSetup(projectId));
}

export function trustWorktreeSetup(
  projectId: number,
  input: WorktreeSetupTrustInput,
): Effect.Effect<WorktreeSetupTrustOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.trustWorktreeSetup(projectId, input));
}

export function openWorktree(
  projectId: number,
  input: OpenWorktreeInput,
): Effect.Effect<OpenWorktreeOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.openWorktree(projectId, input));
}

export function preflightDeleteWorktree(
  projectId: number,
  worktreeId: number,
): Effect.Effect<DeleteWorktreePreflightOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.preflightDeleteWorktree(projectId, worktreeId));
}

export function deleteWorktree(
  projectId: number,
  worktreeId: number,
  input: DeleteWorktreeInput,
): Effect.Effect<DeleteWorktreeOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.deleteWorktree(projectId, worktreeId, input));
}

export function suggestProjectPaths(
  input: string,
  limit = 25,
): Effect.Effect<PathSuggestOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.suggestProjectPaths(input, limit));
}

export function fetchControlPlane(): Effect.Effect<ControlPlaneSnapshot, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.getControlPlane());
}

export function refreshInventory(): Effect.Effect<RefreshInventoryOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.refreshInventory());
}

export function acceptHarnessPolicy(
  input: AcceptHarnessPolicyInput,
): Effect.Effect<AcceptHarnessPolicyOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.acceptHarnessPolicy(input));
}

export function openEditor(
  worktreeId: number,
  input: OpenEditorInput,
): Effect.Effect<OpenEditorOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.openEditor(worktreeId, input));
}

export function ensureEditorRuntime(
  editorContextId: number,
  input: EnsureEditorRuntimeInput,
): Effect.Effect<EnsureEditorRuntimeOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.ensureEditorRuntime(editorContextId, input));
}

export function editorDiagnostics(
  editorContextId: number,
  ptyProcessId: number,
): Effect.Effect<EditorDiagnosticsOutput, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.editorDiagnostics(editorContextId, ptyProcessId));
}

export function retryEditorProvisioning(): Effect.Effect<
  RetryEditorProvisioningOutput,
  Error,
  RuntimeApi
> {
  return RuntimeApi.use((api) => api.retryEditorProvisioning());
}

/**
 * A stable name for the runtime this client is talking to.
 *
 * There is no runtime-issued identifier on the wire, and the app resolves one runtime URL per
 * session, so the normalized URL is the identity. It namespaces the workflow caches and the
 * synchronization coordinator, which is what stops a run's converged state being reused for a
 * different runtime if the configured URL ever changes under the same page.
 */
export function resolveRuntimeIdentity(): Effect.Effect<string, Error, RuntimeApi> {
  return RuntimeApi.use((api) => api.runtimeIdentity());
}

function runtimeErrorCopyFor(error: unknown, options: { readonly diagnostic: boolean }) {
  // `UserVisibleError` is a workspace-local validation failure (e.g. surface
  // rename), not a runtime-client failure, so it is checked before classifying.
  if (error instanceof UserVisibleError) {
    return error.userMessage;
  }
  const classified = classifyRuntimeFailure(error);
  switch (classified.kind) {
    case 'api': {
      const summary = runtimeErrorCopy.fromApiError(classified.apiError);
      return options.diagnostic
        ? `${summary} (${runtimeErrorCopy.diagnostic(classified.apiError)})`
        : summary;
    }
    case 'transport':
      return runtimeErrorCopy.transport;
    case 'decode':
      return runtimeErrorCopy.decode;
    case 'unknown':
      return runtimeErrorCopy.unknown;
  }
}

export function formatRuntimeError(error: unknown) {
  return runtimeErrorCopyFor(error, { diagnostic: true });
}

export function formatRuntimeErrorSummary(error: unknown) {
  return runtimeErrorCopyFor(error, { diagnostic: false });
}

export type { WorkspaceSnapshot };
