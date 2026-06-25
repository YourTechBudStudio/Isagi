import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';

import type {
  AgentHarness,
  CreateSurfaceOutput,
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  DeleteSurfaceOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  ReconciliationFinding,
  SetSplitWeightsInput,
  SetSplitWeightsOutput,
  SplitPaneInput,
  SurfaceDetail,
  AdvanceWorkflowInput,
  WorkflowStartContext,
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
import { handleReconciliationFindings, scheduleWorkspaceReconcile } from './background-sync.js';
import { reconcileSelection, workspaceDataFromSnapshot, type WorkspaceData } from './model.js';
import {
  activeContextQueryKey,
  commandLogMetadataQueryKey,
  surfaceDetailQueryKey,
  workflowDescriptorsQueryKey,
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
  fetchCommandLogMetadata,
  fetchWorktreeCommands,
  fetchWorkspace,
  formatRuntimeError,
  advanceWorkflow,
  getSurfaceDetail,
  listWorkflowDescriptors,
  launchAgentSession,
  launchTerminalSession,
  openWorktree,
  renameSurfaceTitle,
  restartCommand,
  runCommand,
  clearWorkflow,
  retryWorkflow,
  relocateProject,
  setWorkflowPaused,
  setSplitWeights,
  splitPane,
  startWorkflow,
  stopCommand,
} from './runtime-data.js';
import { showWorktreeSetupFailure } from './setup-failure.js';
import { useWorkspaceStore } from './store.js';

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

export function useCommandLogMetadataQuery(worktreeId: number | null, commandName: string | null) {
  return useQuery({
    queryKey: commandLogMetadataQueryKey(worktreeId, commandName),
    enabled: worktreeId !== null && commandName !== null,
    queryFn: ({ signal }) => {
      if (worktreeId === null || commandName === null) {
        throw new Error('Command log metadata query requires a worktree and command name.');
      }
      return runRuntimeEffect(fetchCommandLogMetadata(worktreeId, commandName), { signal });
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

export function useSetWorkflowPausedMutation(surfaceId: number | null) {
  return useMutation({
    mutationFn: (paused: boolean) => {
      if (surfaceId === null) throw new Error('Workflow pause requires an active surface.');
      return runRuntimeEffect(setWorkflowPaused(surfaceId, { paused }));
    },
  });
}

export function useClearWorkflowMutation(surfaceId: number | null) {
  return useMutation({
    mutationFn: () => {
      if (surfaceId === null) throw new Error('Workflow clear requires an active surface.');
      return runRuntimeEffect(clearWorkflow(surfaceId));
    },
  });
}

export function useRetryWorkflowMutation(surfaceId: number | null) {
  return useMutation({
    mutationFn: () => {
      if (surfaceId === null) throw new Error('Workflow retry requires an active surface.');
      return runRuntimeEffect(retryWorkflow(surfaceId));
    },
  });
}

export function useAdvanceWorkflowMutation() {
  return useMutation({
    mutationFn: (input: {
      readonly runId: number;
      readonly answers?: AdvanceWorkflowInput['answers'];
    }) => runRuntimeEffect(advanceWorkflow(input.runId, { answers: input.answers })),
  });
}

export function useWorkflowDescriptorsQuery(
  context: WorkflowStartContext | null,
  options: { readonly enabled?: boolean | undefined } = {},
) {
  return useQuery({
    queryKey: workflowDescriptorsQueryKey(
      context?.worktreeId ?? null,
      context?.surfaceId ?? null,
      context?.paneId ?? null,
    ),
    enabled: (options.enabled ?? true) && context !== null,
    staleTime: 30_000,
    queryFn: ({ signal }) => {
      if (context === null) {
        throw new Error('Workflow descriptor query requires an active launch context.');
      }
      return runRuntimeEffect(listWorkflowDescriptors({ context }), { signal });
    },
  });
}

export function useStartWorkflowMutation() {
  return useMutation({
    mutationFn: (input: {
      readonly workflowKey: string;
      readonly variables?: Record<string, unknown> | undefined;
      readonly context: WorkflowStartContext;
    }) =>
      runRuntimeEffect(
        startWorkflow({
          workflowKey: input.workflowKey,
          variables: input.variables,
          context: input.context,
        }),
      ),
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
    await client.invalidateQueries({
      queryKey: commandLogMetadataQueryKey(worktreeId, commandName),
    });
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

export async function splitPaneFromPalette(input: {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly split: SplitPaneInput;
  readonly client?: QueryClient | undefined;
}) {
  const client = input.client ?? queryClient;
  try {
    const output = await runRuntimeEffect(splitPane(input.worktreeId, input.split));
    await commitSplitPaneSuccess(client, output);
    return output;
  } catch (error) {
    await client.invalidateQueries({ queryKey: workspaceQueryKey });
    await client.invalidateQueries({ queryKey: surfaceDetailQueryKey(input.surfaceId) });
    throw error;
  }
}

// A resize commit returns the whole surface layout, so an older response landing
// after a newer one would revert the newer resize. We stamp each commit per surface
// and let only the latest one touch the cache: stale successes are dropped and a
// stale failure does not force a refetch that would clobber a newer commit. The
// server stays authoritative and refetch-on-focus backstops any dropped write.
const latestSplitWeightCommitBySurface = new Map<number, number>();

export async function setSplitWeightsFromSurface(input: {
  readonly surfaceId: number;
  readonly weights: SetSplitWeightsInput;
  readonly commit?: (
    surfaceId: number,
    weights: SetSplitWeightsInput,
  ) => Promise<SetSplitWeightsOutput>;
  readonly client?: QueryClient | undefined;
}) {
  const client = input.client ?? queryClient;
  const commit =
    input.commit ?? ((surfaceId, weights) => runRuntimeEffect(setSplitWeights(surfaceId, weights)));
  const commitSeq = (latestSplitWeightCommitBySurface.get(input.surfaceId) ?? 0) + 1;
  latestSplitWeightCommitBySurface.set(input.surfaceId, commitSeq);
  const isLatestCommit = () => latestSplitWeightCommitBySurface.get(input.surfaceId) === commitSeq;
  try {
    const output = await commit(input.surfaceId, input.weights);
    if (isLatestCommit()) {
      client.setQueryData<SurfaceDetail>(surfaceDetailQueryKey(output.surfaceId), (detail) =>
        detail ? { ...detail, layout: output.layout } : detail,
      );
    }
    return output;
  } catch (error) {
    if (isLatestCommit()) {
      await client.invalidateQueries({ queryKey: surfaceDetailQueryKey(input.surfaceId) });
    }
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

export async function commitSplitPaneSuccess(client: QueryClient, output: CreateSurfaceOutput) {
  await client.invalidateQueries({ queryKey: surfaceDetailQueryKey(output.surfaceId) });
  await client.invalidateQueries({ queryKey: workspaceQueryKey });
  activatePane(
    { worktreeId: output.worktreeId, surfaceId: output.surfaceId, paneId: output.paneId },
    { persist: false },
  );
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

export { formatRuntimeError };
