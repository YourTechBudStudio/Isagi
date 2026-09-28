import { Effect } from 'effect';

import {
  apiBasePath,
  apiEndpoints,
  workflowContentEndpoints,
  agentSessionPtyWebSocketEndpoint,
  commandLogStreamWebSocketEndpoint,
  terminalSessionPtyWebSocketEndpoint,
  runtimeEventsWebSocketEndpoint,
  type AcceptHarnessPolicyInput,
  type AcceptHarnessPolicyOutput,
  type ControlPlaneSnapshot,
  type EditorDiagnosticsOutput,
  type EnsureEditorRuntimeInput,
  type EnsureEditorRuntimeOutput,
  type OpenEditorOutput,
  type RefreshInventoryOutput,
  type RetryEditorProvisioningOutput,
  type CreateSurfaceInput,
  type CreateSurfaceOutput,
  type DeleteWorktreeInput,
  type DeleteWorktreeOutput,
  type PaneSessionClaimInput,
  type PaneSessionClaimOutput,
  type PaneSessionCreateInput,
  type SetSplitWeightsInput,
  type SetSplitWeightsOutput,
  type SetWorktreeEnvironmentFocusInput,
  type SplitPaneInput,
  type SurfaceDetail,
  type DeleteSurfaceOutput,
  type RenameSurfaceOutput,
  type WorktreeEnvironmentFocusOutput,
  type ActiveContextOutput,
  type ActiveContextPersistenceInput,
  type AddProjectOutput,
  type DeleteProjectOutput,
  type ListProjectBranchesOutput,
  type MoveProjectOrderInput,
  type MoveProjectOrderOutput,
  type MoveSurfaceOrderInput,
  type MoveSurfaceOrderOutput,
  type MoveWorktreeOrderInput,
  type MoveWorktreeOrderOutput,
  type OpenWorktreeInput,
  type OpenWorktreeOutput,
  type DeleteWorktreePreflightOutput,
  type PathSuggestOutput,
  type WorktreeSetupPreflightOutput,
  type WorktreeSetupTrustInput,
  type WorktreeSetupTrustOutput,
  type ReconcileWorkspaceInput,
  type ReconcileWorkspaceOutput,
  type RelocateProjectOutput,
  type WorktreeCommandsOutput,
  type CommandActionOutput,
  type CommandLogMetadataOutput,
  type ClientSettingsOutput,
  type AdvanceWorkflowInput,
  type GetWorkflowExecutionOutput,
  type GetWorkflowRunOutput,
  type GetWorkflowStructureOutput,
  type ListWorkflowDescriptorsInput,
  type ListWorkflowDescriptorsOutput,
  type ListWorkflowEventsQuery,
  type ListWorkflowEventsOutput,
  type GetWorkflowCheckpointOutput,
  type ListWorkflowCheckpointsOutput,
  type ListWorkflowCheckpointsQuery,
  type ListWorkflowRunsQuery,
  type ListWorkflowRunsOutput,
  type StartWorkflowInput,
  type StartWorkflowOutput,
  type WorkflowRunControlOutput,
  type WorkspaceSnapshot,
  type DurableSessionInventory,
} from '@isagi/contracts';
import {
  contentEndpointUrl,
  createEndpointRequester,
  interpolatePath,
  requestContent,
  RuntimeDecodeError,
  type AnyApiContentEndpoint,
  type ContentQuery,
  type RuntimeContentEndpointError,
  type RuntimeEndpointError,
} from '@isagi/runtime-client';

export interface RuntimeClient {
  readonly fetchClientSettings: () => Effect.Effect<
    ClientSettingsOutput,
    RuntimeEndpointError<typeof apiEndpoints.clientSettings>
  >;
  readonly fetchWorkspace: () => Effect.Effect<
    WorkspaceSnapshot,
    RuntimeEndpointError<typeof apiEndpoints.workspace.get>
  >;
  readonly fetchDurableSessions: () => Effect.Effect<
    DurableSessionInventory,
    RuntimeEndpointError<typeof apiEndpoints.workspace.durableSessions>
  >;
  readonly fetchWorktreeCommands: (
    worktreeId: number,
  ) => Effect.Effect<
    WorktreeCommandsOutput,
    RuntimeEndpointError<typeof apiEndpoints.commands.listForWorktree>
  >;
  readonly fetchCommandLogMetadata: (
    worktreeId: number,
    commandName: string,
  ) => Effect.Effect<
    CommandLogMetadataOutput,
    RuntimeEndpointError<typeof apiEndpoints.commands.logMetadata>
  >;
  readonly resolveCommandLogStreamWebSocketUrl: (worktreeId: number, commandName: string) => string;
  readonly runCommand: (
    worktreeId: number,
    commandName: string,
  ) => Effect.Effect<CommandActionOutput, RuntimeEndpointError<typeof apiEndpoints.commands.run>>;
  readonly stopCommand: (
    worktreeId: number,
    commandName: string,
  ) => Effect.Effect<CommandActionOutput, RuntimeEndpointError<typeof apiEndpoints.commands.stop>>;
  readonly restartCommand: (
    worktreeId: number,
    commandName: string,
  ) => Effect.Effect<
    CommandActionOutput,
    RuntimeEndpointError<typeof apiEndpoints.commands.restart>
  >;
  readonly fetchActiveContext: () => Effect.Effect<
    ActiveContextOutput,
    RuntimeEndpointError<typeof apiEndpoints.workspace.getActiveContext>
  >;
  readonly updateActiveContext: (
    input: ActiveContextPersistenceInput,
  ) => Effect.Effect<
    ActiveContextOutput,
    RuntimeEndpointError<typeof apiEndpoints.workspace.setActiveContext>
  >;
  readonly reconcileWorkspace: (
    input: ReconcileWorkspaceInput,
  ) => Effect.Effect<
    ReconcileWorkspaceOutput,
    RuntimeEndpointError<typeof apiEndpoints.workspace.reconcile>
  >;
  readonly getSurfaceDetail: (
    surfaceId: number,
  ) => Effect.Effect<SurfaceDetail, RuntimeEndpointError<typeof apiEndpoints.surfaces.get>>;
  readonly renameSurfaceTitle: (
    surfaceId: number,
    title: string,
  ) => Effect.Effect<
    RenameSurfaceOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.rename>
  >;
  readonly deleteSurface: (
    surfaceId: number,
  ) => Effect.Effect<
    DeleteSurfaceOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.delete>
  >;
  readonly deleteSurfacePane: (
    surfaceId: number,
    paneId: number,
  ) => Effect.Effect<
    DeleteSurfaceOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.deletePane>
  >;
  readonly setWorktreeEnvironmentFocus: (
    worktreeId: number,
    input: SetWorktreeEnvironmentFocusInput,
  ) => Effect.Effect<
    WorktreeEnvironmentFocusOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.setWorktreeEnvironmentFocus>
  >;
  readonly createSurface: (
    worktreeId: number,
    input: CreateSurfaceInput,
  ) => Effect.Effect<
    CreateSurfaceOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.createSurface>
  >;
  readonly splitPane: (
    worktreeId: number,
    input: SplitPaneInput,
  ) => Effect.Effect<
    CreateSurfaceOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.splitPane>
  >;
  readonly setSplitWeights: (
    surfaceId: number,
    input: SetSplitWeightsInput,
  ) => Effect.Effect<
    SetSplitWeightsOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.setSplitWeights>
  >;
  readonly createPaneSession: (
    worktreeId: number,
    input: PaneSessionCreateInput,
  ) => Effect.Effect<
    PaneSessionClaimOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.createPaneSession>
  >;
  readonly claimPaneSession: (
    worktreeId: number,
    input: PaneSessionClaimInput,
  ) => Effect.Effect<
    PaneSessionClaimOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.claimPaneSession>
  >;
  readonly resolveAgentSessionPtyWebSocketUrl: (
    agentSessionId: number,
    attachToken?: string,
  ) => string;
  readonly resolveTerminalSessionPtyWebSocketUrl: (
    terminalSessionId: number,
    attachToken?: string,
  ) => string;
  readonly resolveRuntimeEventsWebSocketUrl: () => string;
  readonly addProject: (
    path: string,
  ) => Effect.Effect<AddProjectOutput, RuntimeEndpointError<typeof apiEndpoints.projects.add>>;
  readonly relocateProject: (
    projectId: number,
    path: string,
  ) => Effect.Effect<
    RelocateProjectOutput,
    RuntimeEndpointError<typeof apiEndpoints.projects.relocate>
  >;
  readonly deleteProject: (
    projectId: number,
  ) => Effect.Effect<
    DeleteProjectOutput,
    RuntimeEndpointError<typeof apiEndpoints.projects.delete>
  >;
  /**
   * The three sibling reorder mutations. Each carries a `before…Id | null`
   * anchor — `null` appends — and returns only identifiers, so a caller that
   * needs the new order must refetch the workspace snapshot.
   */
  readonly moveProjectOrder: (
    projectId: number,
    input: MoveProjectOrderInput,
  ) => Effect.Effect<
    MoveProjectOrderOutput,
    RuntimeEndpointError<typeof apiEndpoints.projects.moveOrder>
  >;
  readonly moveWorktreeOrder: (
    projectId: number,
    worktreeId: number,
    input: MoveWorktreeOrderInput,
  ) => Effect.Effect<
    MoveWorktreeOrderOutput,
    RuntimeEndpointError<typeof apiEndpoints.worktrees.moveOrder>
  >;
  readonly moveSurfaceOrder: (
    worktreeId: number,
    surfaceId: number,
    input: MoveSurfaceOrderInput,
  ) => Effect.Effect<
    MoveSurfaceOrderOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.moveOrder>
  >;
  readonly listProjectBranches: (
    projectId: number,
  ) => Effect.Effect<
    ListProjectBranchesOutput,
    RuntimeEndpointError<typeof apiEndpoints.worktrees.branches>
  >;
  readonly preflightWorktreeSetup: (
    projectId: number,
  ) => Effect.Effect<
    WorktreeSetupPreflightOutput,
    RuntimeEndpointError<typeof apiEndpoints.worktrees.setupPreflight>
  >;
  readonly trustWorktreeSetup: (
    projectId: number,
    input: WorktreeSetupTrustInput,
  ) => Effect.Effect<
    WorktreeSetupTrustOutput,
    RuntimeEndpointError<typeof apiEndpoints.worktrees.setupTrust>
  >;
  readonly openWorktree: (
    projectId: number,
    input: OpenWorktreeInput,
  ) => Effect.Effect<OpenWorktreeOutput, RuntimeEndpointError<typeof apiEndpoints.worktrees.open>>;
  readonly preflightDeleteWorktree: (
    projectId: number,
    worktreeId: number,
  ) => Effect.Effect<
    DeleteWorktreePreflightOutput,
    RuntimeEndpointError<typeof apiEndpoints.worktrees.deletePreflight>
  >;
  readonly deleteWorktree: (
    projectId: number,
    worktreeId: number,
    input: DeleteWorktreeInput,
  ) => Effect.Effect<
    DeleteWorktreeOutput,
    RuntimeEndpointError<typeof apiEndpoints.worktrees.delete>
  >;
  readonly suggestProjectPaths: (
    input: string,
    limit?: number,
  ) => Effect.Effect<
    PathSuggestOutput,
    RuntimeEndpointError<typeof apiEndpoints.paths.suggestions>
  >;
  readonly pauseWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.pause>
  >;
  readonly resumeWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.resume>
  >;
  readonly retryWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.retry>
  >;
  /** Stops graph work and new effects. History is retained and the run stays inspectable. */
  readonly cancelWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.cancel>
  >;
  /** Releases a terminal run's surface attachment. It removes the bar, never the history. */
  readonly dismissWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.dismiss>
  >;
  readonly advanceWorkflow: (
    runId: number,
    input: AdvanceWorkflowInput,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.advance>
  >;
  readonly getWorkflowRun: (
    runId: number,
  ) => Effect.Effect<
    GetWorkflowRunOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.getRun>
  >;
  readonly listWorkflowRuns: (
    query: ListWorkflowRunsQuery,
  ) => Effect.Effect<
    ListWorkflowRunsOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.listRuns>
  >;
  /** The structure of one verified build the run has used. */
  readonly getWorkflowStructure: (
    runId: number,
    artifactHash: string,
  ) => Effect.Effect<
    GetWorkflowStructureOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.getStructure>
  >;
  readonly listWorkflowEvents: (
    runId: number,
    query: ListWorkflowEventsQuery,
  ) => Effect.Effect<
    ListWorkflowEventsOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.listEvents>
  >;
  /** One execution in full, with every operation it performed. */
  readonly getWorkflowExecution: (
    executionId: number,
  ) => Effect.Effect<
    GetWorkflowExecutionOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.getExecution>
  >;
  readonly listWorkflowCheckpoints: (
    runId: number,
    query: ListWorkflowCheckpointsQuery,
  ) => Effect.Effect<
    ListWorkflowCheckpointsOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.listCheckpoints>
  >;
  readonly getWorkflowCheckpoint: (
    checkpointId: number,
  ) => Effect.Effect<
    GetWorkflowCheckpointOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.getCheckpoint>
  >;
  /**
   * The bytes of one saved checkpoint file.
   *
   * A raw `fetch` rather than the typed requester, because the success body is not the JSON
   * envelope every other route returns. A failure still is, so a non-OK response is decoded exactly
   * as the typed requester decodes one and the caller sees the same error shape.
   */
  readonly fetchWorkflowCheckpointFile: (
    checkpointId: number,
    path: string,
  ) => Effect.Effect<
    Blob,
    RuntimeContentEndpointError<typeof workflowContentEndpoints.getCheckpointFile>
  >;
  /** The URL a download action points at. No request is made; anchors and previews use it. */
  readonly workflowCheckpointFileUrl: (
    checkpointId: number,
    path: string,
    options?: { readonly download?: boolean },
  ) => string;
  readonly listWorkflowDescriptors: (
    input: ListWorkflowDescriptorsInput,
  ) => Effect.Effect<
    ListWorkflowDescriptorsOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.descriptors>
  >;
  readonly startWorkflow: (
    input: StartWorkflowInput,
  ) => Effect.Effect<
    StartWorkflowOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.start>
  >;
  readonly getControlPlane: () => Effect.Effect<
    ControlPlaneSnapshot,
    RuntimeEndpointError<typeof apiEndpoints.controlPlane.get>
  >;
  readonly refreshInventory: () => Effect.Effect<
    RefreshInventoryOutput,
    RuntimeEndpointError<typeof apiEndpoints.controlPlane.refreshInventory>
  >;
  readonly acceptHarnessPolicy: (
    input: AcceptHarnessPolicyInput,
  ) => Effect.Effect<
    AcceptHarnessPolicyOutput,
    RuntimeEndpointError<typeof apiEndpoints.controlPlane.acceptPolicy>
  >;
  readonly openEditor: (
    worktreeId: number,
  ) => Effect.Effect<OpenEditorOutput, RuntimeEndpointError<typeof apiEndpoints.editor.open>>;
  readonly ensureEditorRuntime: (
    editorContextId: number,
    input: EnsureEditorRuntimeInput,
  ) => Effect.Effect<
    EnsureEditorRuntimeOutput,
    RuntimeEndpointError<typeof apiEndpoints.editor.ensureRuntime>
  >;
  readonly editorDiagnostics: (
    editorContextId: number,
    ptyProcessId: number,
  ) => Effect.Effect<
    EditorDiagnosticsOutput,
    RuntimeEndpointError<typeof apiEndpoints.editor.diagnostics>
  >;
  readonly retryEditorProvisioning: () => Effect.Effect<
    RetryEditorProvisioningOutput,
    RuntimeEndpointError<typeof apiEndpoints.editor.retryProvisioning>
  >;
}

export function createRuntimeClient(runtimeUrl: string): RuntimeClient {
  const request = createEndpointRequester(runtimeUrl);

  return {
    fetchClientSettings: () => request(apiEndpoints.clientSettings),
    fetchWorkspace: () => request(apiEndpoints.workspace.get),
    fetchDurableSessions: () => request(apiEndpoints.workspace.durableSessions),
    fetchWorktreeCommands: (worktreeId) =>
      request(apiEndpoints.commands.listForWorktree, { worktreeId }),
    fetchCommandLogMetadata: (worktreeId, commandName) =>
      request(apiEndpoints.commands.logMetadata, { worktreeId }, { commandName }),
    resolveCommandLogStreamWebSocketUrl: (worktreeId, commandName) => {
      const httpUrl = new URL(
        `${apiBasePath}${interpolatePath(commandLogStreamWebSocketEndpoint.path, { worktreeId })}`,
        runtimeUrl,
      );
      httpUrl.searchParams.set('commandName', commandName);
      httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      return httpUrl.toString();
    },
    runCommand: (worktreeId, commandName) =>
      request(apiEndpoints.commands.run, { worktreeId }, { commandName }),
    stopCommand: (worktreeId, commandName) =>
      request(apiEndpoints.commands.stop, { worktreeId }, { commandName }),
    restartCommand: (worktreeId, commandName) =>
      request(apiEndpoints.commands.restart, { worktreeId }, { commandName }),
    fetchActiveContext: () => request(apiEndpoints.workspace.getActiveContext),
    updateActiveContext: (input) => request(apiEndpoints.workspace.setActiveContext, input),
    reconcileWorkspace: (input) => request(apiEndpoints.workspace.reconcile, input),
    getSurfaceDetail: (surfaceId) => request(apiEndpoints.surfaces.get, { surfaceId }),
    renameSurfaceTitle: (surfaceId, title) =>
      request(apiEndpoints.surfaces.rename, { surfaceId }, { title }),
    deleteSurface: (surfaceId) => request(apiEndpoints.surfaces.delete, { surfaceId }),
    deleteSurfacePane: (surfaceId, paneId) =>
      request(apiEndpoints.surfaces.deletePane, { surfaceId, paneId }),
    setWorktreeEnvironmentFocus: (worktreeId, input) =>
      request(apiEndpoints.surfaces.setWorktreeEnvironmentFocus, { worktreeId }, input),
    createSurface: (worktreeId, input) =>
      request(apiEndpoints.surfaces.createSurface, { worktreeId }, input),
    splitPane: (worktreeId, input) =>
      request(apiEndpoints.surfaces.splitPane, { worktreeId }, input),
    setSplitWeights: (surfaceId, input) =>
      request(apiEndpoints.surfaces.setSplitWeights, { surfaceId }, input),
    createPaneSession: (worktreeId, input) =>
      request(apiEndpoints.surfaces.createPaneSession, { worktreeId }, input),
    claimPaneSession: (worktreeId, input) =>
      request(apiEndpoints.surfaces.claimPaneSession, { worktreeId }, input),
    resolveAgentSessionPtyWebSocketUrl: (agentSessionId, attachToken) => {
      const httpUrl = new URL(
        `${apiBasePath}${interpolatePath(agentSessionPtyWebSocketEndpoint.path, { agentSessionId })}`,
        runtimeUrl,
      );
      if (attachToken) httpUrl.searchParams.set('attachToken', attachToken);
      httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      return httpUrl.toString();
    },
    resolveTerminalSessionPtyWebSocketUrl: (terminalSessionId, attachToken) => {
      const httpUrl = new URL(
        `${apiBasePath}${interpolatePath(terminalSessionPtyWebSocketEndpoint.path, { terminalSessionId })}`,
        runtimeUrl,
      );
      if (attachToken) httpUrl.searchParams.set('attachToken', attachToken);
      httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      return httpUrl.toString();
    },
    resolveRuntimeEventsWebSocketUrl: () => {
      const httpUrl = new URL(`${apiBasePath}${runtimeEventsWebSocketEndpoint.path}`, runtimeUrl);
      httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      return httpUrl.toString();
    },
    addProject: (path) => request(apiEndpoints.projects.add, { path }),
    relocateProject: (projectId, path) =>
      request(apiEndpoints.projects.relocate, { projectId }, { path }),
    deleteProject: (projectId) => request(apiEndpoints.projects.delete, { projectId }),
    moveProjectOrder: (projectId, input) =>
      request(apiEndpoints.projects.moveOrder, { projectId }, input),
    moveWorktreeOrder: (projectId, worktreeId, input) =>
      request(apiEndpoints.worktrees.moveOrder, { projectId, worktreeId }, input),
    moveSurfaceOrder: (worktreeId, surfaceId, input) =>
      request(apiEndpoints.surfaces.moveOrder, { worktreeId, surfaceId }, input),
    listProjectBranches: (projectId) => request(apiEndpoints.worktrees.branches, { projectId }),
    preflightWorktreeSetup: (projectId) =>
      request(apiEndpoints.worktrees.setupPreflight, { projectId }),
    trustWorktreeSetup: (projectId, input) =>
      request(apiEndpoints.worktrees.setupTrust, { projectId }, input),
    openWorktree: (projectId, input) => request(apiEndpoints.worktrees.open, { projectId }, input),
    preflightDeleteWorktree: (projectId, worktreeId) =>
      request(apiEndpoints.worktrees.deletePreflight, { projectId, worktreeId }),
    deleteWorktree: (projectId, worktreeId, input) =>
      request(apiEndpoints.worktrees.delete, { projectId, worktreeId }, input),
    suggestProjectPaths: (input, limit = 25) =>
      request(apiEndpoints.paths.suggestions, { input, limit }),
    pauseWorkflow: (runId) => request(apiEndpoints.workflows.pause, { runId }),
    resumeWorkflow: (runId) => request(apiEndpoints.workflows.resume, { runId }),
    retryWorkflow: (runId) => request(apiEndpoints.workflows.retry, { runId }),
    cancelWorkflow: (runId) => request(apiEndpoints.workflows.cancel, { runId }),
    dismissWorkflow: (runId) => request(apiEndpoints.workflows.dismiss, { runId }),
    advanceWorkflow: (runId, input) => request(apiEndpoints.workflows.advance, { runId }, input),
    getWorkflowRun: (runId) => request(apiEndpoints.workflows.getRun, { runId }),
    listWorkflowRuns: (query) => request(apiEndpoints.workflows.listRuns, query),
    getWorkflowStructure: (runId, artifactHash) =>
      request(apiEndpoints.workflows.getStructure, { runId }, { artifactHash }),
    listWorkflowEvents: (runId, query) =>
      request(apiEndpoints.workflows.listEvents, { runId }, query),
    getWorkflowExecution: (executionId) =>
      request(apiEndpoints.workflows.getExecution, { executionId }),
    listWorkflowCheckpoints: (runId, query) =>
      request(apiEndpoints.workflows.listCheckpoints, { runId }, query),
    getWorkflowCheckpoint: (checkpointId) =>
      request(apiEndpoints.workflows.getCheckpoint, { checkpointId }),
    workflowCheckpointFileUrl: (checkpointId, path, options) =>
      contentEndpointUrl(
        runtimeUrl,
        workflowContentEndpoints.getCheckpointFile,
        { checkpointId },
        { path, ...(options?.download ? { download: true } : {}) },
      ),
    fetchWorkflowCheckpointFile: (checkpointId, path) =>
      fetchContent(
        runtimeUrl,
        workflowContentEndpoints.getCheckpointFile,
        { checkpointId },
        { path },
      ),
    listWorkflowDescriptors: (input) => request(apiEndpoints.workflows.descriptors, input),
    startWorkflow: (input) => request(apiEndpoints.workflows.start, input),
    getControlPlane: () => request(apiEndpoints.controlPlane.get),
    refreshInventory: () => request(apiEndpoints.controlPlane.refreshInventory),
    acceptHarnessPolicy: (input) => request(apiEndpoints.controlPlane.acceptPolicy, input),
    openEditor: (worktreeId) => request(apiEndpoints.editor.open, { worktreeId }),
    ensureEditorRuntime: (editorContextId, input) =>
      request(apiEndpoints.editor.ensureRuntime, { editorContextId }, input),
    // Params, then query — the argument order `ApiEndpointRequestArgs` derives for
    // a params+query endpoint, the same shape `fetchCommandLogMetadata` uses. The
    // incarnation is named because the durable context outlives its incarnations.
    editorDiagnostics: (editorContextId, ptyProcessId) =>
      request(apiEndpoints.editor.diagnostics, { editorContextId }, { ptyProcessId }),
    retryEditorProvisioning: () => request(apiEndpoints.editor.retryProvisioning),
  };
}

/**
 * One content route's bytes, buffered: the web renders or downloads a capture whole. The request and
 * its error decoding are the shared client's, so a failure has the same shape as any other route's.
 */
function fetchContent<Endpoint extends AnyApiContentEndpoint>(
  runtimeUrl: string,
  endpoint: Endpoint,
  params: Record<string, string | number>,
  query?: ContentQuery,
): Effect.Effect<Blob, RuntimeContentEndpointError<Endpoint>> {
  return requestContent(runtimeUrl, endpoint, params, query).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.blob(),
        catch: (cause) => new RuntimeDecodeError(endpoint.id, cause),
      }),
    ),
  );
}
