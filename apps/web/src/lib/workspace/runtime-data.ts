import { Effect } from 'effect';

import type {
  ActiveContextOutput,
  ActiveContextPersistenceInput,
  AddProjectOutput,
  AgentHarness,
  DeleteProjectOutput,
  LaunchSessionOutput,
  ListProjectBranchesOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  PathSuggestOutput,
  ReconcileWorkspaceInput,
  SetWorktreeEnvironmentFocusInput,
  SurfaceDetail,
  WorktreeEnvironmentFocusOutput,
  WorktreeSetupPreflightOutput,
  WorktreeSetupTrustInput,
  WorktreeSetupTrustOutput,
  ReconcileWorkspaceOutput,
  RelocateProjectOutput,
  WorkspaceSnapshot,
} from '@isagi/contracts';

import { createRuntimeClient, RuntimeApiError, type RuntimeClient } from '../runtime/client.js';
import { resolveRuntimeUrl } from '../runtime/resolve.js';

let cachedClient: RuntimeClient | null = null;
let cachedRuntimeUrl: string | null = null;

export function fetchWorkspace() {
  return getClient().pipe(Effect.flatMap((client) => client.fetchWorkspace()));
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

export function setWorktreeEnvironmentFocus(
  worktreeId: number,
  input: SetWorktreeEnvironmentFocusInput,
): Effect.Effect<WorktreeEnvironmentFocusOutput, Error> {
  return getClient().pipe(
    Effect.flatMap((client) => client.setWorktreeEnvironmentFocus(worktreeId, input)),
  );
}

export function launchAgentSession(
  worktreeId: number,
  harness: AgentHarness,
): Effect.Effect<LaunchSessionOutput, Error> {
  return getClient().pipe(
    Effect.flatMap((client) => client.launchAgentSession(worktreeId, harness)),
  );
}

export function launchTerminalSession(
  worktreeId: number,
): Effect.Effect<LaunchSessionOutput, Error> {
  return getClient().pipe(Effect.flatMap((client) => client.launchTerminalSession(worktreeId)));
}

export function resolvePtyWebSocketUrl(ptySessionId: number): Effect.Effect<string, Error> {
  return getClient().pipe(Effect.map((client) => client.resolvePtyWebSocketUrl(ptySessionId)));
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

export function formatRuntimeError(error: unknown) {
  if (error instanceof RuntimeApiError) {
    return `${error.apiError.message} (${error.apiError.code}, request ${error.apiError.requestId})`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export type { WorkspaceSnapshot };
