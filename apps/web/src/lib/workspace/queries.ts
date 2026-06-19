import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Duration, Effect } from 'effect';

import type {
  ActiveContextPersistenceInput,
  AgentHarness,
  CreateSurfaceOutput,
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  DeleteSurfaceOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  ReconciliationFinding,
  SetActiveContextInput,
} from '@isagi/contracts';

import { toastCopy } from '../../copy/index.js';
import { queryClient } from '../query/client.js';
import { runRuntimeEffect } from '../runtime/run.js';
import { showToast } from '../toast/index.js';
import {
  activatePane,
  cancelWorkbenchFocusPersistence,
  restoreActivePaneFocus,
} from './activation.js';
import { reconcileSelection, workspaceDataFromSnapshot, type WorkspaceData } from './model.js';
import {
  activeContextQueryKey,
  commandLogsQueryKey,
  surfaceDetailQueryKey,
  workspaceQueryKey,
  worktreeCommandsQueryKey,
} from './query-keys.js';
import {
  addProject,
  deleteSurface,
  deleteSurfacePane,
  deleteProject,
  deleteWorktree,
  fetchActiveContext,
  fetchCommandLogs,
  fetchWorktreeCommands,
  fetchWorkspace,
  formatRuntimeError,
  getSurfaceDetail,
  launchAgentSession,
  launchTerminalSession,
  openWorktree,
  reconcileWorkspace,
  renameSurfaceTitle,
  restartCommand,
  runCommand,
  relocateProject,
  stopCommand,
  updateActiveContext,
} from './runtime-data.js';
import { showWorktreeSetupFailure } from './setup-failure.js';
import { useWorkspaceStore } from './store.js';

let scheduledActiveContext: ActiveContextPersistenceInput | null = null;
let activeContextInFlight: ActiveContextPersistenceInput | null = null;
let activeContextAbortController: AbortController | null = null;
let activeContextTimer: number | null = null;
const workspaceReconcileInFlightProjectIds = new Set<number | null>();

export function useWorkspaceQuery() {
  return useQuery({
    queryKey: workspaceQueryKey,
    queryFn: ({ signal }) =>
      runRuntimeEffect(fetchWorkspace().pipe(Effect.map(workspaceDataFromSnapshot)), { signal }),
  });
}

export function useWorktreeCommandsQuery(worktreeId: number | null) {
  return useQuery({
    queryKey: worktreeCommandsQueryKey(worktreeId),
    enabled: worktreeId !== null,
    queryFn: ({ signal }) => {
      if (worktreeId === null) {
        throw new Error('Worktree command query requires an active worktree.');
      }
      return runRuntimeEffect(fetchWorktreeCommands(worktreeId), { signal });
    },
  });
}

export function useCommandLogsQuery(worktreeId: number | null, commandName: string | null) {
  return useQuery({
    queryKey: commandLogsQueryKey(worktreeId, commandName),
    enabled: worktreeId !== null && commandName !== null,
    queryFn: ({ signal }) => {
      if (worktreeId === null || commandName === null) {
        throw new Error('Command logs query requires a worktree and command name.');
      }
      return runRuntimeEffect(fetchCommandLogs(worktreeId, commandName), { signal });
    },
  });
}

export function useRunCommandMutation(worktreeId: number | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (commandName: string) => {
      if (worktreeId === null) throw new Error('Command run requires an active worktree.');
      return runRuntimeEffect(runCommand(worktreeId, commandName));
    },
    onSettled: async (_output, _error, commandName) => {
      await invalidateCommandQueries(client, worktreeId, commandName);
    },
  });
}

export function useStopCommandMutation(worktreeId: number | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (commandName: string) => {
      if (worktreeId === null) throw new Error('Command stop requires an active worktree.');
      return runRuntimeEffect(stopCommand(worktreeId, commandName));
    },
    onSettled: async (_output, _error, commandName) => {
      await invalidateCommandQueries(client, worktreeId, commandName);
    },
  });
}

export function useRestartCommandMutation(worktreeId: number | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (commandName: string) => {
      if (worktreeId === null) throw new Error('Command restart requires an active worktree.');
      return runRuntimeEffect(restartCommand(worktreeId, commandName));
    },
    onSettled: async (_output, _error, commandName) => {
      await invalidateCommandQueries(client, worktreeId, commandName);
    },
  });
}

export function useActiveContextQuery() {
  return useQuery({
    queryKey: activeContextQueryKey,
    queryFn: ({ signal }) => runRuntimeEffect(fetchActiveContext(), { signal }),
  });
}

export async function invalidateCommandQueries(
  client: QueryClient,
  worktreeId: number | null,
  commandName?: string | null,
) {
  await client.invalidateQueries({ queryKey: worktreeCommandsQueryKey(worktreeId), exact: true });
  if (commandName) {
    await client.invalidateQueries({ queryKey: commandLogsQueryKey(worktreeId, commandName) });
  }
}

export function useSurfaceDetailQuery(surfaceId: number) {
  return useQuery({
    queryKey: surfaceDetailQueryKey(surfaceId),
    queryFn: ({ signal }) => runRuntimeEffect(getSurfaceDetail(surfaceId), { signal }),
  });
}

export function useAddProjectMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => runRuntimeEffect(addProject(path)),
    onSuccess: (output) => commitAddProjectSuccess(client, { projectId: output.projectId }),
  });
}

export function useDeleteProjectMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (projectId: number) => runRuntimeEffect(deleteProject(projectId)),
    onError: (error, projectId) => {
      showToast({
        id: `delete-project-failed:${projectId}`,
        kind: 'warning',
        title: toastCopy.projectDeleteFailed.title,
        subtitle: formatRuntimeError(error),
      });
      console.error('[workspace] project deletion failed', error);
    },
    onSuccess: () => commitDeleteProjectSuccess(client),
  });
}

export async function addProjectPath(path: string) {
  const output = await runRuntimeEffect(addProject(path));
  await commitAddProjectSuccess(queryClient, { projectId: output.projectId });
}

export async function relocateProjectPath(projectId: number, path: string) {
  const output = await runRuntimeEffect(relocateProject(projectId, path));
  await commitRelocateProjectSuccess(queryClient, output.findings);
}

export async function openWorktreeFromPalette(projectId: number, input: OpenWorktreeInput) {
  const output = await runRuntimeEffect(openWorktree(projectId, input));
  await commitOpenWorktreeSuccess(queryClient, output);
  return output;
}

export async function deleteWorktreeFromPalette(
  projectId: number,
  worktreeId: number,
  input: DeleteWorktreeInput,
) {
  try {
    const output = await runRuntimeEffect(deleteWorktree(projectId, worktreeId, input));
    await commitDeleteWorktreeSuccess(queryClient, output);
    return output;
  } catch (error) {
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
    throw error;
  }
}

export async function startAgentSessionFromPalette(
  worktreeId: number,
  harness: AgentHarness,
  launch: typeof launchAgentSession = launchAgentSession,
  client: QueryClient = queryClient,
) {
  try {
    const output = await runRuntimeEffect(launch(worktreeId, harness));
    await commitLaunchSessionSuccess(client, output);
    return output;
  } catch (error) {
    await commitLaunchSessionFailure(client);
    throw error;
  }
}

export async function startTerminalSessionFromPalette(worktreeId: number) {
  const output = await runRuntimeEffect(launchTerminalSession(worktreeId));
  await commitLaunchSessionSuccess(queryClient, output);
  return output;
}

export async function renameSurfaceTitleFromPalette(surfaceId: number, title: string) {
  try {
    const output = await runRuntimeEffect(renameSurfaceTitle(surfaceId, title));
    await commitRenameSurfaceSuccess(queryClient, output.surfaceId);
    return output;
  } catch (error) {
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
    throw error;
  }
}

export async function deleteSurfaceFromPalette(input: {
  readonly worktreeId: number;
  readonly surfaceId: number;
}) {
  try {
    const output = await runRuntimeEffect(deleteSurface(input.surfaceId));
    await commitDeleteSurfaceSuccess(queryClient, {
      worktreeId: input.worktreeId,
      surfaceId: input.surfaceId,
      output,
    });
    return output;
  } catch (error) {
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
    throw error;
  }
}

export async function deleteSurfacePaneFromPalette(input: {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId: number;
}) {
  try {
    const output = await runRuntimeEffect(deleteSurfacePane(input.surfaceId, input.paneId));
    await commitDeleteSurfaceSuccess(queryClient, {
      worktreeId: input.worktreeId,
      surfaceId: input.surfaceId,
      paneId: input.paneId,
      output,
    });
    return output;
  } catch (error) {
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
    throw error;
  }
}

export async function commitOpenWorktreeSuccess(
  client: QueryClient,
  output: OpenWorktreeOutput,
  fetchWorkspaceData: (signal?: AbortSignal | undefined) => Promise<WorkspaceData> = (signal) =>
    runRuntimeEffect(fetchWorkspace().pipe(Effect.map(workspaceDataFromSnapshot)), { signal }),
) {
  await client.fetchQuery({
    queryKey: workspaceQueryKey,
    queryFn: ({ signal }) => fetchWorkspaceData(signal),
    staleTime: 0,
  });
  useWorkspaceStore.getState().selectWorktree(output.projectId, output.worktreeId);
  restoreActivePaneFocus();
  if (output.status === 'created_setup_failed') {
    showWorktreeSetupFailure(output);
  }
}

export async function commitLaunchSessionSuccess(
  client: QueryClient,
  output: CreateSurfaceOutput,
  fetchWorkspaceData: (signal?: AbortSignal | undefined) => Promise<WorkspaceData> = (signal) =>
    runRuntimeEffect(fetchWorkspace().pipe(Effect.map(workspaceDataFromSnapshot)), { signal }),
) {
  await client.fetchQuery({
    queryKey: workspaceQueryKey,
    queryFn: ({ signal }) => fetchWorkspaceData(signal),
    staleTime: 0,
  });
  activatePane(
    { worktreeId: output.worktreeId, surfaceId: output.surfaceId, paneId: output.paneId },
    { persist: false },
  );
}

export async function commitLaunchSessionFailure(client: QueryClient) {
  await client.invalidateQueries({ queryKey: workspaceQueryKey });
}

export async function commitRenameSurfaceSuccess(client: QueryClient, surfaceId: number) {
  await client.invalidateQueries({ queryKey: workspaceQueryKey });
  await client.invalidateQueries({ queryKey: surfaceDetailQueryKey(surfaceId) });
}

export async function commitDeleteSurfaceSuccess(
  client: QueryClient,
  input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly paneId?: number | undefined;
    readonly output: DeleteSurfaceOutput;
    readonly fetchWorkspaceData?: (signal?: AbortSignal | undefined) => Promise<WorkspaceData>;
  },
) {
  const fetchWorkspaceData =
    input.fetchWorkspaceData ??
    ((signal?: AbortSignal | undefined) =>
      runRuntimeEffect(fetchWorkspace().pipe(Effect.map(workspaceDataFromSnapshot)), { signal }));

  await client.fetchQuery({
    queryKey: workspaceQueryKey,
    queryFn: ({ signal }) => fetchWorkspaceData(signal),
    staleTime: 0,
  });

  const store = useWorkspaceStore.getState();
  if (input.output.deletedSurfaceId === input.surfaceId) {
    cancelWorkbenchFocusPersistence(input.worktreeId);
    client.removeQueries({ queryKey: surfaceDetailQueryKey(input.surfaceId), exact: true });
    store.forgetSurface(input.worktreeId, input.surfaceId);
    store.forgetPane(input.surfaceId);
  } else if (input.paneId !== undefined) {
    store.forgetPane(input.surfaceId, input.paneId);
    await client.invalidateQueries({ queryKey: surfaceDetailQueryKey(input.surfaceId) });
  }
}

export async function commitDeleteWorktreeSuccess(
  client: QueryClient,
  output: DeleteWorktreeOutput,
  fetchWorkspaceData: (signal?: AbortSignal | undefined) => Promise<WorkspaceData> = (signal) =>
    runRuntimeEffect(fetchWorkspace().pipe(Effect.map(workspaceDataFromSnapshot)), { signal }),
) {
  const data = await client.fetchQuery({
    queryKey: workspaceQueryKey,
    queryFn: ({ signal }) => fetchWorkspaceData(signal),
    staleTime: 0,
  });

  const project = data.projects.find((candidate) => candidate.id === output.projectId);
  const selected = project?.worktrees.find(
    (candidate) => candidate.id === output.selectedWorktreeId,
  );
  const store = useWorkspaceStore.getState();
  if (project && selected) {
    store.selectWorktree(project.id, selected.id);
    restoreActivePaneFocus();
    return;
  }

  store.setSelection(
    reconcileSelection(data.projects, {
      kind: 'worktree',
      projectId: output.projectId,
      worktreeId: output.selectedWorktreeId,
    }),
  );
  restoreActivePaneFocus();
}

export async function commitAddProjectSuccess(
  client: QueryClient,
  options: { readonly projectId?: number | null; readonly reconcile?: boolean } = {},
) {
  await client.invalidateQueries({ queryKey: workspaceQueryKey });
  if (options.reconcile ?? true) {
    scheduleWorkspaceReconcile(client, { projectId: options.projectId ?? null });
  }
}

export async function commitRelocateProjectSuccess(
  client: QueryClient,
  findings: readonly ReconciliationFinding[],
) {
  handleReconciliationFindings(findings);
  await client.invalidateQueries({ queryKey: workspaceQueryKey });
}

export async function commitDeleteProjectSuccess(client: QueryClient) {
  await client.invalidateQueries({ queryKey: workspaceQueryKey });
}

export function scheduleActiveContextPersistence(activeContext: SetActiveContextInput) {
  scheduledActiveContext = {
    activeContext,
    revision: nextActiveContextRevision(),
  };

  if (activeContextTimer !== null) {
    window.clearTimeout(activeContextTimer);
  }

  activeContextAbortController?.abort(new Error('Superseded by a newer active context.'));

  activeContextTimer = window.setTimeout(() => {
    activeContextTimer = null;
    flushActiveContextPersistence();
  }, 180);
}

function flushActiveContextPersistence() {
  if (activeContextInFlight || !scheduledActiveContext) {
    return;
  }

  const activeContext = scheduledActiveContext;
  const abortController = new AbortController();
  scheduledActiveContext = null;
  activeContextInFlight = activeContext;
  activeContextAbortController = abortController;

  void runRuntimeEffect(
    updateActiveContext(activeContext).pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(5),
        onTimeout: () => new Error('Active context persistence timed out.'),
      }),
    ),
    { signal: abortController.signal },
  )
    .then(
      () => {
        void queryClient.invalidateQueries({ queryKey: activeContextQueryKey });
        if (scheduledActiveContext || activeContext.activeContext.projectId === null) {
          return;
        }
        scheduleWorkspaceReconcile(queryClient, {
          projectId: activeContext.activeContext.projectId,
        });
      },
      (error: unknown) => {
        if (scheduledActiveContext) {
          return;
        }
        showToast({
          id: 'active-context-persist-failed',
          kind: 'warning',
          title: toastCopy.activeContextPersistFailed.title,
          subtitle: toastCopy.activeContextPersistFailed.subtitle,
        });
        console.error('[workspace] active context persistence failed', error);
      },
    )
    .finally(() => {
      if (activeContextAbortController === abortController) {
        activeContextAbortController = null;
      }
      activeContextInFlight = null;
      flushActiveContextPersistence();
    });
}

export function scheduleWorkspaceReconcileForProject(projectId: number) {
  scheduleWorkspaceReconcile(queryClient, { projectId });
}

export function scheduleWorkspaceReconcile(
  client: QueryClient = queryClient,
  input: { readonly projectId: number | null } = { projectId: null },
) {
  if (workspaceReconcileInFlightProjectIds.has(input.projectId)) {
    return;
  }

  workspaceReconcileInFlightProjectIds.add(input.projectId);

  void runRuntimeEffect(reconcileWorkspace(input))
    .then(
      async (output) => {
        handleReconciliationFindings(output.findings);
        await client.invalidateQueries({ queryKey: workspaceQueryKey });
      },
      (error: unknown) => {
        console.error('[workspace] reconciliation failed', error);
      },
    )
    .finally(() => {
      workspaceReconcileInFlightProjectIds.delete(input.projectId);
    });
}

let lastActiveContextRevision = Date.now();

function nextActiveContextRevision() {
  lastActiveContextRevision = Math.max(Date.now(), lastActiveContextRevision + 1);
  return lastActiveContextRevision;
}

function handleReconciliationFindings(findings: readonly ReconciliationFinding[]) {
  if (findings.length === 0) {
    return;
  }

  const missingProjects = findings.filter((finding) => finding.kind === 'project_missing');
  if (missingProjects.length > 0) {
    showToast({
      id: 'workspace-project-missing',
      kind: 'warning',
      title: toastCopy.reconciliation.missingProjectsTitle(missingProjects),
      subtitle: toastCopy.reconciliation.missingProjectsSubtitle(missingProjects),
      lifetime: { autoDismiss: false },
    });
  }

  const missingWorktrees = findings.filter((finding) => finding.kind === 'worktree_missing');
  if (missingWorktrees.length > 0) {
    showToast({
      id: 'workspace-worktree-missing',
      kind: 'warning',
      title: toastCopy.reconciliation.missingWorktreesTitle(missingWorktrees),
      subtitle: toastCopy.reconciliation.missingWorktreesSubtitle(missingWorktrees),
      lifetime: { autoDismiss: false },
    });
  }
}

export { formatRuntimeError };
