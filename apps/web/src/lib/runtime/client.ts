import { Effect, Schema } from 'effect';

import {
  apiBasePath,
  apiEndpoints,
  agentSessionPtyWebSocketEndpoint,
  commandLogStreamWebSocketEndpoint,
  workflowEventsStreamWebSocketEndpoint,
  terminalSessionPtyWebSocketEndpoint,
  runtimeEventsWebSocketEndpoint,
  apiErrorResponseSchema,
  apiInfrastructureErrorSchema,
  apiSuccessResponseSchema,
  type ApiEndpoint,
  type ApiEndpointError,
  type ApiEndpointOutput,
  type ApiEndpointParams,
  type ApiEndpointRequestArgs,
  type ApiInfrastructureError,
  type AcceptHarnessPolicyInput,
  type AcceptHarnessPolicyOutput,
  type ControlPlaneSnapshot,
  type RefreshInventoryOutput,
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
  type ListWorkflowDescriptorsInput,
  type ListWorkflowDescriptorsOutput,
  type StartWorkflowInput,
  type StartWorkflowOutput,
  type WorkflowRunControlOutput,
  type WorkspaceSnapshot,
} from '@isagi/contracts';

import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from './errors.js';

type RuntimeEndpointError<Endpoint> =
  | RuntimeApiError<ApiEndpointError<Endpoint> | ApiInfrastructureError>
  | RuntimeDecodeError
  | RuntimeTransportError;

export interface RuntimeClient {
  readonly fetchClientSettings: () => Effect.Effect<
    ClientSettingsOutput,
    RuntimeEndpointError<typeof apiEndpoints.clientSettings>
  >;
  readonly fetchWorkspace: () => Effect.Effect<
    WorkspaceSnapshot,
    RuntimeEndpointError<typeof apiEndpoints.workspace.get>
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
  readonly resolveWorkflowEventsStreamWebSocketUrl: (
    runId: number,
    options?: { readonly includeChildren?: boolean | undefined },
  ) => string;
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
  readonly clearWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.clear>
  >;
  readonly retryWorkflow: (
    runId: number,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.retry>
  >;
  readonly advanceWorkflow: (
    runId: number,
    input: AdvanceWorkflowInput,
  ) => Effect.Effect<
    WorkflowRunControlOutput,
    RuntimeEndpointError<typeof apiEndpoints.workflows.advance>
  >;
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
}

export function createRuntimeClient(runtimeUrl: string): RuntimeClient {
  const request = createEndpointRequester(runtimeUrl);

  return {
    fetchClientSettings: () => request(apiEndpoints.clientSettings),
    fetchWorkspace: () => request(apiEndpoints.workspace.get),
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
    resolveWorkflowEventsStreamWebSocketUrl: (runId, options = {}) => {
      const httpUrl = new URL(
        `${apiBasePath}${interpolatePath(workflowEventsStreamWebSocketEndpoint.path, { runId })}`,
        runtimeUrl,
      );
      if (options.includeChildren) httpUrl.searchParams.set('includeChildren', 'true');
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
    clearWorkflow: (runId) => request(apiEndpoints.workflows.clear, { runId }),
    retryWorkflow: (runId) => request(apiEndpoints.workflows.retry, { runId }),
    advanceWorkflow: (runId, input) => request(apiEndpoints.workflows.advance, { runId }, input),
    listWorkflowDescriptors: (input) => request(apiEndpoints.workflows.descriptors, input),
    startWorkflow: (input) => request(apiEndpoints.workflows.start, input),
    getControlPlane: () => request(apiEndpoints.controlPlane.get),
    refreshInventory: () => request(apiEndpoints.controlPlane.refreshInventory),
    acceptHarnessPolicy: (input) => request(apiEndpoints.controlPlane.acceptPolicy, input),
  };
}

function createEndpointRequester(runtimeUrl: string) {
  return function requestEndpoint<
    Endpoint extends ApiEndpoint<
      Schema.Schema.AnyNoContext | undefined,
      Schema.Schema.AnyNoContext,
      Schema.Schema.AnyNoContext,
      Schema.Schema.AnyNoContext | undefined,
      Schema.Schema.AnyNoContext | undefined
    >,
  >(
    endpoint: Endpoint,
    ...args: ApiEndpointRequestArgs<Endpoint>
  ): Effect.Effect<ApiEndpointOutput<Endpoint>, RuntimeEndpointError<Endpoint>> {
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) => {
          const init: RequestInit = { method: endpoint.method, signal };
          const params = endpoint.params ? (args[0] as ApiEndpointParams<Endpoint>) : undefined;
          const query = endpoint.query ? args[endpoint.params ? 1 : 0] : undefined;
          const body = endpoint.body
            ? args[(endpoint.params ? 1 : 0) + (endpoint.query ? 1 : 0)]
            : undefined;
          if (endpoint.body) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
          }
          const url = new URL(
            `${apiBasePath}${interpolatePath(endpoint.path, params)}`,
            runtimeUrl,
          );
          appendQuery(url, query);
          return fetch(url, init);
        },
        catch: (cause) =>
          new RuntimeTransportError(`Could not reach runtime endpoint ${endpoint.id}.`, cause),
      });

      const payload = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: (cause) => new RuntimeDecodeError(endpoint.id, cause),
      });

      if (!response.ok) {
        const decoded = yield* decode(
          apiErrorResponseSchema(endpoint.errors),
          payload,
          endpoint.id,
        ).pipe(
          Effect.catchAll(() =>
            decode(apiErrorResponseSchema(apiInfrastructureErrorSchema), payload, endpoint.id),
          ),
        );
        return yield* Effect.fail(new RuntimeApiError(decoded.error));
      }

      const decoded = yield* decode(
        apiSuccessResponseSchema(endpoint.output),
        payload,
        endpoint.id,
      );
      return decoded.data as ApiEndpointOutput<Endpoint>;
    });
  };
}

function appendQuery(url: URL, query: unknown) {
  if (!query || typeof query !== 'object') {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
}

function interpolatePath(path: string, params: unknown) {
  if (!params || typeof params !== 'object') {
    return path;
  }

  return Object.entries(params).reduce(
    (nextPath, [key, value]) => nextPath.replace(`:${key}`, encodeURIComponent(String(value))),
    path,
  );
}

function decode<Decoded, Encoded>(
  schema: Schema.Schema<Decoded, Encoded, never>,
  value: unknown,
  endpointId: string,
) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: (cause) => new RuntimeDecodeError(endpointId, cause),
  });
}

export { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError };
export type { RuntimeClientError } from './errors.js';
