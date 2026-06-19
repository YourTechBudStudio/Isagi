import { Effect, Schema } from 'effect';

import {
  apiBasePath,
  apiEndpoints,
  agentSessionPtyWebSocketEndpoint,
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
  type CreateSurfaceOutput,
  type LaunchAgentSurfaceInput,
  type DeleteWorktreeInput,
  type DeleteWorktreeOutput,
  type PaneSessionClaimInput,
  type PaneSessionClaimOutput,
  type PaneSessionCreateInput,
  type SetWorktreeEnvironmentFocusInput,
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
  type WorkspaceSnapshot,
} from '@isagi/contracts';

import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from './errors.js';

type RuntimeEndpointError<Endpoint> =
  | RuntimeApiError<ApiEndpointError<Endpoint> | ApiInfrastructureError>
  | RuntimeDecodeError
  | RuntimeTransportError;

export interface RuntimeClient {
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
    kind: 'agent' | 'terminal',
  ) => Effect.Effect<
    CreateSurfaceOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.createSurface>
  >;
  readonly launchAgentSurface: (
    worktreeId: number,
    input: LaunchAgentSurfaceInput,
  ) => Effect.Effect<
    CreateSurfaceOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.launchAgentSurface>
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
}

export function createRuntimeClient(runtimeUrl: string): RuntimeClient {
  const request = createEndpointRequester(runtimeUrl);

  return {
    fetchWorkspace: () => request(apiEndpoints.workspace.get),
    fetchWorktreeCommands: (worktreeId) =>
      request(apiEndpoints.commands.listForWorktree, { worktreeId }),
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
    createSurface: (worktreeId, kind) =>
      request(apiEndpoints.surfaces.createSurface, { worktreeId }, { kind }),
    launchAgentSurface: (worktreeId, input) =>
      request(apiEndpoints.surfaces.launchAgentSurface, { worktreeId }, input),
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
  };
}

function createEndpointRequester(runtimeUrl: string) {
  return function requestEndpoint<
    Endpoint extends ApiEndpoint<
      Schema.Schema.AnyNoContext | undefined,
      Schema.Schema.AnyNoContext,
      Schema.Schema.AnyNoContext,
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
          const body = endpoint.body ? args[endpoint.params ? 1 : 0] : undefined;
          if (endpoint.body) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
          }
          return fetch(
            new URL(`${apiBasePath}${interpolatePath(endpoint.path, params)}`, runtimeUrl),
            init,
          );
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
