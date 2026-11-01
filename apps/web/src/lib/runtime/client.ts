import { Context, Effect, Layer } from 'effect';

import {
  apiBasePath,
  apiEndpoints,
  fluidcastEndpoints,
  workflowContentEndpoints,
  agentSessionPtyWebSocketEndpoint,
  commandLogStreamWebSocketEndpoint,
  terminalSessionPtyWebSocketEndpoint,
  runtimeEventsWebSocketEndpoint,
  type AcceptHarnessPolicyInput,
  type SetAgentSessionInteractionModeInput,
  type SetAgentSessionInteractionModeOutput,
  type AcceptHarnessPolicyOutput,
  type ControlPlaneSnapshot,
  type EditorDiagnosticsOutput,
  type EnsureEditorRuntimeInput,
  type EnsureEditorRuntimeOutput,
  type OpenEditorInput,
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
  type StartPaneInput,
  type SurfaceDetail,
  type DeletePaneOutput,
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
  type AnyApiContentEndpoint,
  type AnyApiEndpoint,
  type ApiEndpointRequestArgs,
} from '@isagi/contracts';
import {
  contentEndpointUrl,
  interpolatePath,
  RuntimeClient as RuntimeHttpApi,
  RuntimeHttpClient,
  type ContentQuery,
  type RuntimeContentEndpointError,
  type RuntimeEndpointError,
} from '@isagi/runtime-client';

import { resolveRuntimeUrl, RuntimeUrlUnavailable } from './resolve.js';

/** A typed endpoint call's failure: the runtime-client failures, or no runtime URL to call. */
export type RuntimeCallError<Endpoint> = RuntimeEndpointError<Endpoint> | RuntimeUrlUnavailable;
/** A content endpoint call's failure. */
export type RuntimeContentCallError<Endpoint> =
  | RuntimeContentEndpointError<Endpoint>
  | RuntimeUrlUnavailable;

/**
 * The web app's view of the runtime API: one method per endpoint the UI calls, plus the socket and
 * download URLs it opens. Every member resolves the runtime URL when it runs, so a desktop runtime
 * restarting on a new port is picked up by the next call.
 */
export interface RuntimeApiShape {
  readonly fetchClientSettings: () => Effect.Effect<
    ClientSettingsOutput,
    RuntimeCallError<typeof apiEndpoints.clientSettings>
  >;
  readonly fetchWorkspace: () => Effect.Effect<
    WorkspaceSnapshot,
    RuntimeCallError<typeof apiEndpoints.workspace.get>
  >;
  readonly fetchDurableSessions: () => Effect.Effect<
    DurableSessionInventory,
    RuntimeCallError<typeof apiEndpoints.workspace.durableSessions>
  >;
  readonly fetchWorktreeCommands: (
    worktreeId: number,
  ) => Effect.Effect<
    WorktreeCommandsOutput,
    RuntimeCallError<typeof apiEndpoints.commands.listForWorktree>
  >;
  readonly fetchCommandLogMetadata: (
    worktreeId: number,
    commandName: string,
  ) => Effect.Effect<
    CommandLogMetadataOutput,
    RuntimeCallError<typeof apiEndpoints.commands.logMetadata>
  >;
  readonly resolveCommandLogStreamWebSocketUrl: (
    worktreeId: number,
    commandName: string,
  ) => Effect.Effect<string, RuntimeUrlUnavailable>;
  readonly runCommand: (
    worktreeId: number,
    commandName: string,
  ) => Effect.Effect<CommandActionOutput, RuntimeCallError<typeof apiEndpoints.commands.run>>;
  readonly stopCommand: (
    worktreeId: number,
    commandName: string,
  ) => Effect.Effect<CommandActionOutput, RuntimeCallError<typeof apiEndpoints.commands.stop>>;
  readonly restartCommand: (
    worktreeId: number,
    commandName: string,
  ) => Effect.Effect<CommandActionOutput, RuntimeCallError<typeof apiEndpoints.commands.restart>>;
  readonly fetchActiveContext: () => Effect.Effect<
    ActiveContextOutput,
    RuntimeCallError<typeof apiEndpoints.workspace.getActiveContext>
  >;
  readonly updateActiveContext: (
    input: ActiveContextPersistenceInput,
  ) => Effect.Effect<
    ActiveContextOutput,
    RuntimeCallError<typeof apiEndpoints.workspace.setActiveContext>
  >;
  readonly reconcileWorkspace: (
    input: ReconcileWorkspaceInput,
  ) => Effect.Effect<
    ReconcileWorkspaceOutput,
    RuntimeCallError<typeof apiEndpoints.workspace.reconcile>
  >;
  readonly getSurfaceDetail: (
    surfaceId: number,
  ) => Effect.Effect<SurfaceDetail, RuntimeCallError<typeof apiEndpoints.surfaces.get>>;
  readonly renameSurfaceTitle: (
    surfaceId: number,
    title: string,
  ) => Effect.Effect<RenameSurfaceOutput, RuntimeCallError<typeof apiEndpoints.surfaces.rename>>;
  readonly deleteSurface: (
    surfaceId: number,
  ) => Effect.Effect<DeleteSurfaceOutput, RuntimeCallError<typeof apiEndpoints.surfaces.delete>>;
  readonly deleteSurfacePane: (
    surfaceId: number,
    paneId: number,
  ) => Effect.Effect<DeletePaneOutput, RuntimeCallError<typeof apiEndpoints.surfaces.deletePane>>;
  readonly setWorktreeEnvironmentFocus: (
    worktreeId: number,
    input: SetWorktreeEnvironmentFocusInput,
  ) => Effect.Effect<
    WorktreeEnvironmentFocusOutput,
    RuntimeCallError<typeof apiEndpoints.surfaces.setWorktreeEnvironmentFocus>
  >;
  readonly createSurface: (
    worktreeId: number,
    input: CreateSurfaceInput,
  ) => Effect.Effect<
    CreateSurfaceOutput,
    RuntimeCallError<typeof apiEndpoints.surfaces.createSurface>
  >;
  readonly splitPane: (
    worktreeId: number,
    input: SplitPaneInput,
  ) => Effect.Effect<CreateSurfaceOutput, RuntimeCallError<typeof apiEndpoints.surfaces.splitPane>>;
  readonly startPane: (
    surfaceId: number,
    input: StartPaneInput,
  ) => Effect.Effect<CreateSurfaceOutput, RuntimeCallError<typeof apiEndpoints.surfaces.startPane>>;
  readonly setSplitWeights: (
    surfaceId: number,
    input: SetSplitWeightsInput,
  ) => Effect.Effect<
    SetSplitWeightsOutput,
    RuntimeCallError<typeof apiEndpoints.surfaces.setSplitWeights>
  >;
  readonly createPaneSession: (
    worktreeId: number,
    input: PaneSessionCreateInput,
  ) => Effect.Effect<
    PaneSessionClaimOutput,
    RuntimeCallError<typeof apiEndpoints.surfaces.createPaneSession>
  >;
  readonly claimPaneSession: (
    worktreeId: number,
    input: PaneSessionClaimInput,
  ) => Effect.Effect<
    PaneSessionClaimOutput,
    RuntimeCallError<typeof apiEndpoints.surfaces.claimPaneSession>
  >;
  readonly resolveAgentSessionPtyWebSocketUrl: (
    agentSessionId: number,
    attachToken?: string,
  ) => Effect.Effect<string, RuntimeUrlUnavailable>;
  readonly resolveTerminalSessionPtyWebSocketUrl: (
    terminalSessionId: number,
    attachToken?: string,
  ) => Effect.Effect<string, RuntimeUrlUnavailable>;
  readonly resolveRuntimeEventsWebSocketUrl: () => Effect.Effect<string, RuntimeUrlUnavailable>;
  readonly addProject: (
    path: string,
  ) => Effect.Effect<AddProjectOutput, RuntimeCallError<typeof apiEndpoints.projects.add>>;
  readonly relocateProject: (
    projectId: number,
    path: string,
  ) => Effect.Effect<
    RelocateProjectOutput,
    RuntimeCallError<typeof apiEndpoints.projects.relocate>
  >;
  readonly deleteProject: (
    projectId: number,
  ) => Effect.Effect<DeleteProjectOutput, RuntimeCallError<typeof apiEndpoints.projects.delete>>;
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
    RuntimeCallError<typeof apiEndpoints.projects.moveOrder>
  >;
  readonly moveWorktreeOrder: (
    projectId: number,
    worktreeId: number,
    input: MoveWorktreeOrderInput,
  ) => Effect.Effect<
    MoveWorktreeOrderOutput,
    RuntimeCallError<typeof apiEndpoints.worktrees.moveOrder>
  >;
  readonly moveSurfaceOrder: (
    worktreeId: number,
    surfaceId: number,
    input: MoveSurfaceOrderInput,
  ) => Effect.Effect<
    MoveSurfaceOrderOutput,
    RuntimeCallError<typeof apiEndpoints.surfaces.moveOrder>
  >;
  readonly listProjectBranches: (
    projectId: number,
  ) => Effect.Effect<
    ListProjectBranchesOutput,
    RuntimeCallError<typeof apiEndpoints.worktrees.branches>
  >;
  readonly preflightWorktreeSetup: (
    projectId: number,
  ) => Effect.Effect<
    WorktreeSetupPreflightOutput,
    RuntimeCallError<typeof apiEndpoints.worktrees.setupPreflight>
  >;
  readonly trustWorktreeSetup: (
    projectId: number,
    input: WorktreeSetupTrustInput,
  ) => Effect.Effect<
    WorktreeSetupTrustOutput,
    RuntimeCallError<typeof apiEndpoints.worktrees.setupTrust>
  >;
  readonly openWorktree: (
    projectId: number,
    input: OpenWorktreeInput,
  ) => Effect.Effect<OpenWorktreeOutput, RuntimeCallError<typeof apiEndpoints.worktrees.open>>;
  readonly preflightDeleteWorktree: (
    projectId: number,
    worktreeId: number,
  ) => Effect.Effect<
    DeleteWorktreePreflightOutput,
    RuntimeCallError<typeof apiEndpoints.worktrees.deletePreflight>
  >;
  readonly deleteWorktree: (
    projectId: number,
    worktreeId: number,
    input: DeleteWorktreeInput,
  ) => Effect.Effect<DeleteWorktreeOutput, RuntimeCallError<typeof apiEndpoints.worktrees.delete>>;
  readonly suggestProjectPaths: (
    input: string,
    limit?: number,
  ) => Effect.Effect<PathSuggestOutput, RuntimeCallError<typeof apiEndpoints.paths.suggestions>>;
  readonly pauseWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.pause>
  >;
  readonly resumeWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.resume>
  >;
  readonly retryWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.retry>
  >;
  /** Stops graph work and new effects. History is retained and the run stays inspectable. */
  readonly cancelWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.cancel>
  >;
  /** Releases a terminal run's surface attachment. It removes the bar, never the history. */
  readonly dismissWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.dismiss>
  >;
  readonly advanceWorkflow: (
    runId: number,
    input: AdvanceWorkflowInput,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.advance>
  >;
  readonly getWorkflowRun: (
    runId: number,
  ) => Effect.Effect<GetWorkflowRunOutput, RuntimeCallError<typeof apiEndpoints.workflows.getRun>>;
  readonly listWorkflowRuns: (
    query: ListWorkflowRunsQuery,
  ) => Effect.Effect<
    ListWorkflowRunsOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.listRuns>
  >;
  /** The structure of one verified build the run has used. */
  readonly getWorkflowStructure: (
    runId: number,
    artifactHash: string,
  ) => Effect.Effect<
    GetWorkflowStructureOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.getStructure>
  >;
  readonly listWorkflowEvents: (
    runId: number,
    query: ListWorkflowEventsQuery,
  ) => Effect.Effect<
    ListWorkflowEventsOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.listEvents>
  >;
  /** One execution in full, with every operation it performed. */
  readonly getWorkflowExecution: (
    executionId: number,
  ) => Effect.Effect<
    GetWorkflowExecutionOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.getExecution>
  >;
  readonly listWorkflowCheckpoints: (
    runId: number,
    query: ListWorkflowCheckpointsQuery,
  ) => Effect.Effect<
    ListWorkflowCheckpointsOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.listCheckpoints>
  >;
  readonly getWorkflowCheckpoint: (
    checkpointId: number,
  ) => Effect.Effect<
    GetWorkflowCheckpointOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.getCheckpoint>
  >;
  /**
   * The bytes of one saved checkpoint file.
   *
   * The content requester rather than the typed requester, because the success body is not the JSON
   * envelope every other route returns. A failure still is, so a non-OK response is decoded exactly
   * as the typed requester decodes one and the caller sees the same error shape.
   */
  readonly fetchWorkflowCheckpointFile: (
    checkpointId: number,
    path: string,
  ) => Effect.Effect<
    Blob,
    RuntimeContentCallError<typeof workflowContentEndpoints.getCheckpointFile>
  >;
  /** The URL a download action points at. No request is made; anchors and previews use it. */
  readonly workflowCheckpointFileUrl: (
    checkpointId: number,
    path: string,
    options?: { readonly download?: boolean },
  ) => Effect.Effect<string, RuntimeUrlUnavailable>;
  readonly listWorkflowDescriptors: (
    input: ListWorkflowDescriptorsInput,
  ) => Effect.Effect<
    ListWorkflowDescriptorsOutput,
    RuntimeCallError<typeof apiEndpoints.workflows.descriptors>
  >;
  readonly startWorkflow: (
    input: StartWorkflowInput,
  ) => Effect.Effect<StartWorkflowOutput, RuntimeCallError<typeof apiEndpoints.workflows.start>>;
  readonly getControlPlane: () => Effect.Effect<
    ControlPlaneSnapshot,
    RuntimeCallError<typeof apiEndpoints.controlPlane.get>
  >;
  readonly refreshInventory: () => Effect.Effect<
    RefreshInventoryOutput,
    RuntimeCallError<typeof apiEndpoints.controlPlane.refreshInventory>
  >;
  readonly acceptHarnessPolicy: (
    input: AcceptHarnessPolicyInput,
  ) => Effect.Effect<
    AcceptHarnessPolicyOutput,
    RuntimeCallError<typeof apiEndpoints.controlPlane.acceptPolicy>
  >;
  readonly openEditor: (
    worktreeId: number,
    input: OpenEditorInput,
  ) => Effect.Effect<OpenEditorOutput, RuntimeCallError<typeof apiEndpoints.editor.open>>;
  readonly ensureEditorRuntime: (
    editorContextId: number,
    input: EnsureEditorRuntimeInput,
  ) => Effect.Effect<
    EnsureEditorRuntimeOutput,
    RuntimeCallError<typeof apiEndpoints.editor.ensureRuntime>
  >;
  readonly editorDiagnostics: (
    editorContextId: number,
    ptyProcessId: number,
  ) => Effect.Effect<
    EditorDiagnosticsOutput,
    RuntimeCallError<typeof apiEndpoints.editor.diagnostics>
  >;
  readonly retryEditorProvisioning: () => Effect.Effect<
    RetryEditorProvisioningOutput,
    RuntimeCallError<typeof apiEndpoints.editor.retryProvisioning>
  >;
  /**
   * A stable name for the runtime this app is talking to: the normalized runtime URL, since no
   * runtime-issued identifier is on the wire and the app resolves one runtime URL per session.
   */
  readonly runtimeIdentity: () => Effect.Effect<string, RuntimeUrlUnavailable>;
  /**
   * The runtime URL itself, checked to parse. For a client that keeps one URL for its lifetime, such
   * as an embedded Fluidcast player, which builds its own requesters and speech URLs from it.
   */
  readonly resolveRuntimeUrl: () => Effect.Effect<string, RuntimeUrlUnavailable>;
  readonly setAgentInteractionMode: (
    agentSessionId: number,
    input: SetAgentSessionInteractionModeInput,
  ) => Effect.Effect<
    SetAgentSessionInteractionModeOutput,
    RuntimeCallError<typeof apiEndpoints.agentSessions.setInteractionMode>
  >;
  /** One player command; the body is the Fluidcast SDK's encoded `Command`, opaque to contracts. */
  readonly sendFluidcastCommand: (
    fluidcastSessionId: string,
    command: unknown,
  ) => Effect.Effect<null, RuntimeCallError<typeof fluidcastEndpoints.command>>;
}

/**
 * The runtime API as a per-app service. `layer` resolves the runtime URL per request
 * (`resolveRuntimeUrl`): the desktop bridge (`window.isagi.getRuntimeUrl()`), then
 * `VITE_ISAGI_RUNTIME_URL` in Vite development only, then the page's own http(s) origin, else a
 * `RuntimeUrlUnavailable` failure. It reads `window` only when a request runs, so modules
 * that import it load cleanly in node tests.
 */
export class RuntimeApi extends Context.Service<RuntimeApi, RuntimeApiShape>()(
  'isagi/web/RuntimeApi',
) {
  static readonly layer: Layer.Layer<RuntimeApi> = Layer.sync(RuntimeApi, () =>
    makeRuntimeApi(Effect.suspend(() => resolveRuntimeUrl())),
  );
}

/** Never derived from the URL or its parser error, so it cannot echo credentials the URL carries. */
const invalidRuntimeUrlMessage = 'The runtime URL is not a valid URL.';

/**
 * The runtime API against whatever URL `currentRuntimeUrl` yields when each call runs.
 * `RuntimeApi.layer` passes the per-request resolver; tests pass `Effect.succeed(url)`.
 */
export function makeRuntimeApi(
  currentRuntimeUrl: Effect.Effect<string, RuntimeUrlUnavailable>,
): RuntimeApiShape {
  // `@isagi/runtime-client` builds its requesters from an `HttpClient`. Providing the platform `fetch`
  // client per call keeps every method requirement-free, so callers run them exactly as before.
  const withHttpApi = <A, E>(
    use: (api: RuntimeHttpApi['Service']) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | RuntimeUrlUnavailable> =>
    currentRuntimeUrl.pipe(
      Effect.flatMap((runtimeUrl) => RuntimeHttpApi.make(runtimeUrl)),
      Effect.flatMap(use),
      Effect.provide(RuntimeHttpClient),
    );
  const request = <Endpoint extends AnyApiEndpoint>(
    endpoint: Endpoint,
    ...args: ApiEndpointRequestArgs<Endpoint>
  ) => withHttpApi((api) => api.request(endpoint, ...args));
  /**
   * A socket or download URL under the runtime URL; no request is made. A runtime URL `new URL`
   * rejects (an external `localhost:4100`, say) is a runtime this client cannot reach, a typed
   * failure as it is for requests, never a defect. The message is fixed and the parser's error stays
   * in `cause`: a runtime URL can carry credentials, and the parser's message differs by engine
   * (Chromium and Node say `Invalid URL`; other engines may quote the input).
   */
  const atRuntimeUrl = (build: (runtimeUrl: string) => string) =>
    Effect.flatMap(currentRuntimeUrl, (runtimeUrl) =>
      Effect.try({
        try: () => build(runtimeUrl),
        catch: (cause) => new RuntimeUrlUnavailable({ message: invalidRuntimeUrlMessage, cause }),
      }),
    );

  return {
    fetchClientSettings: () => request(apiEndpoints.clientSettings),
    fetchWorkspace: () => request(apiEndpoints.workspace.get),
    fetchDurableSessions: () => request(apiEndpoints.workspace.durableSessions),
    fetchWorktreeCommands: (worktreeId) =>
      request(apiEndpoints.commands.listForWorktree, { worktreeId }),
    fetchCommandLogMetadata: (worktreeId, commandName) =>
      request(apiEndpoints.commands.logMetadata, { worktreeId }, { commandName }),
    resolveCommandLogStreamWebSocketUrl: (worktreeId, commandName) =>
      atRuntimeUrl((runtimeUrl) => {
        const httpUrl = new URL(
          `${apiBasePath}${interpolatePath(commandLogStreamWebSocketEndpoint.path, { worktreeId })}`,
          runtimeUrl,
        );
        httpUrl.searchParams.set('commandName', commandName);
        httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        return httpUrl.toString();
      }),
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
    startPane: (surfaceId, input) => request(apiEndpoints.surfaces.startPane, { surfaceId }, input),
    setSplitWeights: (surfaceId, input) =>
      request(apiEndpoints.surfaces.setSplitWeights, { surfaceId }, input),
    createPaneSession: (worktreeId, input) =>
      request(apiEndpoints.surfaces.createPaneSession, { worktreeId }, input),
    claimPaneSession: (worktreeId, input) =>
      request(apiEndpoints.surfaces.claimPaneSession, { worktreeId }, input),
    resolveAgentSessionPtyWebSocketUrl: (agentSessionId, attachToken) =>
      atRuntimeUrl((runtimeUrl) => {
        const httpUrl = new URL(
          `${apiBasePath}${interpolatePath(agentSessionPtyWebSocketEndpoint.path, { agentSessionId })}`,
          runtimeUrl,
        );
        if (attachToken) httpUrl.searchParams.set('attachToken', attachToken);
        httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        return httpUrl.toString();
      }),
    resolveTerminalSessionPtyWebSocketUrl: (terminalSessionId, attachToken) =>
      atRuntimeUrl((runtimeUrl) => {
        const httpUrl = new URL(
          `${apiBasePath}${interpolatePath(terminalSessionPtyWebSocketEndpoint.path, { terminalSessionId })}`,
          runtimeUrl,
        );
        if (attachToken) httpUrl.searchParams.set('attachToken', attachToken);
        httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        return httpUrl.toString();
      }),
    resolveRuntimeEventsWebSocketUrl: () =>
      atRuntimeUrl((runtimeUrl) => {
        const httpUrl = new URL(`${apiBasePath}${runtimeEventsWebSocketEndpoint.path}`, runtimeUrl);
        httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        return httpUrl.toString();
      }),
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
      atRuntimeUrl((runtimeUrl) =>
        contentEndpointUrl(
          runtimeUrl,
          workflowContentEndpoints.getCheckpointFile,
          { checkpointId },
          { path, ...(options?.download ? { download: true } : {}) },
        ),
      ),
    fetchWorkflowCheckpointFile: (checkpointId, path) =>
      withHttpApi((api) =>
        fetchContent(api, workflowContentEndpoints.getCheckpointFile, { checkpointId }, { path }),
      ),
    listWorkflowDescriptors: (input) => request(apiEndpoints.workflows.descriptors, input),
    startWorkflow: (input) => request(apiEndpoints.workflows.start, input),
    getControlPlane: () => request(apiEndpoints.controlPlane.get),
    refreshInventory: () => request(apiEndpoints.controlPlane.refreshInventory),
    acceptHarnessPolicy: (input) => request(apiEndpoints.controlPlane.acceptPolicy, input),
    openEditor: (worktreeId, input) => request(apiEndpoints.editor.open, { worktreeId }, input),
    ensureEditorRuntime: (editorContextId, input) =>
      request(apiEndpoints.editor.ensureRuntime, { editorContextId }, input),
    // Params, then query — the argument order `ApiEndpointRequestArgs` derives for
    // a params+query endpoint, the same shape `fetchCommandLogMetadata` uses. The
    // incarnation is named because the durable context outlives its incarnations.
    editorDiagnostics: (editorContextId, ptyProcessId) =>
      request(apiEndpoints.editor.diagnostics, { editorContextId }, { ptyProcessId }),
    retryEditorProvisioning: () => request(apiEndpoints.editor.retryProvisioning),
    runtimeIdentity: () => atRuntimeUrl(normalizeRuntimeIdentity),
    resolveRuntimeUrl: () => atRuntimeUrl((runtimeUrl) => new URL(runtimeUrl).href),
    setAgentInteractionMode: (agentSessionId, input) =>
      request(apiEndpoints.agentSessions.setInteractionMode, { agentSessionId }, input),
    sendFluidcastCommand: (fluidcastSessionId, command) =>
      request(fluidcastEndpoints.command, { fluidcastSessionId }, command),
  };
}

/**
 * The runtime URL reduced to a stable identity: origin plus path without trailing slashes, so two
 * spellings of one runtime URL name the same runtime.
 */
export function normalizeRuntimeIdentity(runtimeUrl: string): string {
  try {
    const url = new URL(runtimeUrl);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    // An unparseable value is still a distinct configuration, and using it verbatim keeps two
    // different broken values apart rather than collapsing them onto one namespace.
    return runtimeUrl;
  }
}

/**
 * One content route's bytes, buffered: the web renders or downloads a capture whole. The request and
 * its error decoding are the shared client's, so a failure has the same shape as any other route's.
 * The `Blob` carries the response's content type, as the platform `response.blob()` did.
 */
function fetchContent<Endpoint extends AnyApiContentEndpoint>(
  api: RuntimeHttpApi['Service'],
  endpoint: Endpoint,
  params: Record<string, string | number>,
  query?: ContentQuery,
): Effect.Effect<Blob, RuntimeContentEndpointError<Endpoint>> {
  return api
    .requestContent(endpoint, params, query)
    .pipe(
      Effect.flatMap((content) =>
        content.arrayBuffer.pipe(
          Effect.map((buffer) => new Blob([buffer], { type: content.contentType ?? '' })),
        ),
      ),
    );
}
