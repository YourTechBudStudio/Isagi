import { Effect, Schema } from 'effect';

import {
  apiBasePath,
  apiEndpoints,
  ptySessionWebSocketEndpoint,
  runtimeEventsWebSocketEndpoint,
  apiErrorResponseSchema,
  apiInfrastructureErrorSchema,
  apiSuccessResponseSchema,
  type AgentHarness,
  type ApiEndpoint,
  type ApiEndpointError,
  type ApiEndpointOutput,
  type ApiEndpointParams,
  type ApiEndpointRequestArgs,
  type ApiInfrastructureError,
  type LaunchSessionOutput,
  type SetWorktreeEnvironmentFocusInput,
  type SurfaceDetail,
  type WorktreeEnvironmentFocusOutput,
  type ActiveContextOutput,
  type ActiveContextPersistenceInput,
  type AddProjectOutput,
  type DeleteProjectOutput,
  type ListProjectBranchesOutput,
  type OpenWorktreeInput,
  type OpenWorktreeOutput,
  type PathSuggestOutput,
  type WorktreeSetupPreflightOutput,
  type WorktreeSetupTrustInput,
  type WorktreeSetupTrustOutput,
  type ReconcileWorkspaceInput,
  type ReconcileWorkspaceOutput,
  type RelocateProjectOutput,
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
  readonly setWorktreeEnvironmentFocus: (
    worktreeId: number,
    input: SetWorktreeEnvironmentFocusInput,
  ) => Effect.Effect<
    WorktreeEnvironmentFocusOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.setWorktreeEnvironmentFocus>
  >;
  readonly launchAgentSession: (
    worktreeId: number,
    harness: AgentHarness,
  ) => Effect.Effect<
    LaunchSessionOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.launchAgentSession>
  >;
  readonly launchTerminalSession: (
    worktreeId: number,
  ) => Effect.Effect<
    LaunchSessionOutput,
    RuntimeEndpointError<typeof apiEndpoints.surfaces.launchTerminalSession>
  >;
  readonly resolvePtyWebSocketUrl: (ptySessionId: number) => string;
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
    fetchActiveContext: () => request(apiEndpoints.workspace.getActiveContext),
    updateActiveContext: (input) => request(apiEndpoints.workspace.setActiveContext, input),
    reconcileWorkspace: (input) => request(apiEndpoints.workspace.reconcile, input),
    getSurfaceDetail: (surfaceId) => request(apiEndpoints.surfaces.get, { surfaceId }),
    setWorktreeEnvironmentFocus: (worktreeId, input) =>
      request(apiEndpoints.surfaces.setWorktreeEnvironmentFocus, { worktreeId }, input),
    launchAgentSession: (worktreeId, harness) =>
      request(apiEndpoints.surfaces.launchAgentSession, { worktreeId }, { harness }),
    launchTerminalSession: (worktreeId) =>
      request(apiEndpoints.surfaces.launchTerminalSession, { worktreeId }),
    resolvePtyWebSocketUrl: (ptySessionId) => {
      const httpUrl = new URL(
        `${apiBasePath}${interpolatePath(ptySessionWebSocketEndpoint.path, { ptySessionId })}`,
        runtimeUrl,
      );
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
