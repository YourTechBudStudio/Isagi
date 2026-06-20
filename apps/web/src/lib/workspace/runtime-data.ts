import { Effect } from 'effect';

import type {
  ActiveContextOutput,
  ActiveContextPersistenceInput,
  AddProjectOutput,
  AgentHarness,
  CreateSurfaceInput,
  CreateSurfaceOutput,
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  DeleteSurfaceOutput,
  DeleteProjectOutput,
  PaneSessionClaimInput,
  PaneSessionClaimOutput,
  PaneSessionCreateInput,
  ListProjectBranchesOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  DeleteWorktreePreflightOutput,
  PathSuggestOutput,
  RenameSurfaceOutput,
  ReconcileWorkspaceInput,
  SetWorktreeEnvironmentFocusInput,
  SplitPaneInput,
  SurfaceDetail,
  WorktreeEnvironmentFocusOutput,
  WorktreeSetupPreflightOutput,
  WorktreeSetupTrustInput,
  WorktreeSetupTrustOutput,
  WorktreeCommandsOutput,
  CommandActionOutput,
  CommandLogMetadataOutput,
  ReconcileWorkspaceOutput,
  RelocateProjectOutput,
  WorkspaceSnapshot,
} from '@isagi/contracts';

import { runtimeErrorCopy } from '../../copy/index.js';
import {
  createRuntimeClient,
  RuntimeApiError,
  RuntimeDecodeError,
  RuntimeTransportError,
  type RuntimeClient,
} from '../runtime/client.js';
import { resolveRuntimeUrl } from '../runtime/resolve.js';
import { unwrapRuntimeFailure } from '../runtime/run.js';

let cachedClient: RuntimeClient | null = null;
let cachedRuntimeUrl: string | null = null;

export class UserVisibleError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'UserVisibleError';
  }
}

export function fetchWorkspace() {
  return getClient().pipe(Effect.flatMap((client) => client.fetchWorkspace()));
}

export function fetchWorktreeCommands(
  worktreeId: number,
): Effect.Effect<WorktreeCommandsOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.fetchWorktreeCommands(worktreeId)));
}

export function fetchCommandLogMetadata(
  worktreeId: number,
  commandName: string,
): Effect.Effect<CommandLogMetadataOutput, Error> {
  return getClient().pipe(
    Effect.flatMap((client) => client.fetchCommandLogMetadata(worktreeId, commandName)),
  );
}

export function runCommand(
  worktreeId: number,
  commandName: string,
): Effect.Effect<CommandActionOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.runCommand(worktreeId, commandName)));
}

export function stopCommand(
  worktreeId: number,
  commandName: string,
): Effect.Effect<CommandActionOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.stopCommand(worktreeId, commandName)));
}

export function restartCommand(
  worktreeId: number,
  commandName: string,
): Effect.Effect<CommandActionOutput, Error> {
  return getClient().pipe(
    Effect.flatMap((client) => client.restartCommand(worktreeId, commandName)),
  );
}

export function fetchActiveContext(): Effect.Effect<ActiveContextOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.fetchActiveContext()));
}

export function updateActiveContext(
  input: ActiveContextPersistenceInput,
): Effect.Effect<ActiveContextOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.updateActiveContext(input)));
}

export function reconcileWorkspace(
  input: ReconcileWorkspaceInput,
): Effect.Effect<ReconcileWorkspaceOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.reconcileWorkspace(input)));
}

export function getSurfaceDetail(surfaceId: number): Effect.Effect<SurfaceDetail, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.getSurfaceDetail(surfaceId)));
}

export function renameSurfaceTitle(
  surfaceId: number,
  title: string,
): Effect.Effect<RenameSurfaceOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.renameSurfaceTitle(surfaceId, title)));
}

export function deleteSurface(surfaceId: number): Effect.Effect<DeleteSurfaceOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.deleteSurface(surfaceId)));
}

export function deleteSurfacePane(
  surfaceId: number,
  paneId: number,
): Effect.Effect<DeleteSurfaceOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.deleteSurfacePane(surfaceId, paneId)));
}

export function setWorktreeEnvironmentFocus(
  worktreeId: number,
  input: SetWorktreeEnvironmentFocusInput,
): Effect.Effect<WorktreeEnvironmentFocusOutput, Error> {
  return getClient().pipe(
    Effect.flatMap((client) => client.setWorktreeEnvironmentFocus(worktreeId, input)),
  );
}

export function createSurface(
  worktreeId: number,
  input: CreateSurfaceInput,
): Effect.Effect<CreateSurfaceOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.createSurface(worktreeId, input)));
}

export function splitPane(
  worktreeId: number,
  input: SplitPaneInput,
): Effect.Effect<CreateSurfaceOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.splitPane(worktreeId, input)));
}

export function createPaneSession(
  worktreeId: number,
  input: PaneSessionCreateInput,
): Effect.Effect<PaneSessionClaimOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.createPaneSession(worktreeId, input)));
}

export function claimPaneSession(
  worktreeId: number,
  input: PaneSessionClaimInput,
): Effect.Effect<PaneSessionClaimOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.claimPaneSession(worktreeId, input)));
}

export function launchAgentSession(
  worktreeId: number,
  harness: AgentHarness,
): Effect.Effect<CreateSurfaceOutput, Error> {
  return createSurface(worktreeId, { initialPane: { kind: 'agent_session', harness } });
}

export function launchTerminalSession(
  worktreeId: number,
): Effect.Effect<CreateSurfaceOutput, Error> {
  return createSurface(worktreeId, { initialPane: { kind: 'terminal_session' } });
}

export function resolveAgentSessionPtyWebSocketUrl(
  agentSessionId: number,
  attachToken?: string,
): Effect.Effect<string, Error> {
  return getClient().pipe(
    Effect.map((client) => client.resolveAgentSessionPtyWebSocketUrl(agentSessionId, attachToken)),
  );
}

export function resolveTerminalSessionPtyWebSocketUrl(
  terminalSessionId: number,
  attachToken?: string,
): Effect.Effect<string, Error> {
  return getClient().pipe(
    Effect.map((client) =>
      client.resolveTerminalSessionPtyWebSocketUrl(terminalSessionId, attachToken),
    ),
  );
}

export function resolveCommandLogStreamWebSocketUrl(
  worktreeId: number,
  commandName: string,
): Effect.Effect<string, Error> {
  return getClient().pipe(
    Effect.map((client) => client.resolveCommandLogStreamWebSocketUrl(worktreeId, commandName)),
  );
}

export function resolveRuntimeEventsWebSocketUrl(): Effect.Effect<string, Error> {
  return getClient().pipe(Effect.map((client) => client.resolveRuntimeEventsWebSocketUrl()));
}

export function addProject(path: string): Effect.Effect<AddProjectOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.addProject(path)));
}

export function relocateProject(
  projectId: number,
  path: string,
): Effect.Effect<RelocateProjectOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.relocateProject(projectId, path)));
}

export function deleteProject(projectId: number): Effect.Effect<DeleteProjectOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.deleteProject(projectId)));
}

export function listProjectBranches(
  projectId: number,
): Effect.Effect<ListProjectBranchesOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.listProjectBranches(projectId)));
}

export function preflightWorktreeSetup(
  projectId: number,
): Effect.Effect<WorktreeSetupPreflightOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.preflightWorktreeSetup(projectId)));
}

export function trustWorktreeSetup(
  projectId: number,
  input: WorktreeSetupTrustInput,
): Effect.Effect<WorktreeSetupTrustOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.trustWorktreeSetup(projectId, input)));
}

export function openWorktree(
  projectId: number,
  input: OpenWorktreeInput,
): Effect.Effect<OpenWorktreeOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.openWorktree(projectId, input)));
}

export function preflightDeleteWorktree(
  projectId: number,
  worktreeId: number,
): Effect.Effect<DeleteWorktreePreflightOutput, Error> {
  return getClient().pipe(
    Effect.flatMap((client) => client.preflightDeleteWorktree(projectId, worktreeId)),
  );
}

export function deleteWorktree(
  projectId: number,
  worktreeId: number,
  input: DeleteWorktreeInput,
): Effect.Effect<DeleteWorktreeOutput, Error> {
  return getClient().pipe(
    Effect.flatMap((client) => client.deleteWorktree(projectId, worktreeId, input)),
  );
}

export function suggestProjectPaths(
  input: string,
  limit = 25,
): Effect.Effect<PathSuggestOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.suggestProjectPaths(input, limit)));
}

function getClient() {
  return resolveRuntimeUrl().pipe(
    Effect.map((runtimeUrl) => {
      if (!cachedClient || cachedRuntimeUrl !== runtimeUrl) {
        cachedClient = createRuntimeClient(runtimeUrl);
        cachedRuntimeUrl = runtimeUrl;
      }
      return cachedClient;
    }),
  );
}

function runtimeErrorCopyFor(error: unknown, options: { readonly diagnostic: boolean }) {
  const failure = unwrapRuntimeFailure(error);
  if (failure instanceof UserVisibleError) {
    return failure.userMessage;
  }
  if (failure instanceof RuntimeApiError) {
    const summary = runtimeErrorCopy.fromApiError(failure.apiError);
    return options.diagnostic
      ? `${summary} (${runtimeErrorCopy.diagnostic(failure.apiError)})`
      : summary;
  }
  if (failure instanceof RuntimeTransportError) {
    return runtimeErrorCopy.transport;
  }
  if (failure instanceof RuntimeDecodeError) {
    return runtimeErrorCopy.decode;
  }
  return runtimeErrorCopy.unknown;
}

export function formatRuntimeError(error: unknown) {
  return runtimeErrorCopyFor(error, { diagnostic: true });
}

export function formatRuntimeErrorSummary(error: unknown) {
  return runtimeErrorCopyFor(error, { diagnostic: false });
}

export type { WorkspaceSnapshot };
