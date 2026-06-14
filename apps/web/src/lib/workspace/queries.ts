import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Duration, Effect } from 'effect';

import type {
  ActiveContextPersistenceInput,
  AgentHarness,
  DeleteWorktreeInput,
  DeleteWorktreeOutput,
  DeleteSurfaceOutput,
  LaunchSessionOutput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  ReconciliationFinding,
  SetActiveContextInput,
  SurfaceDeleteWarning,
} from '@isagi/contracts';

import { toastCopy } from '../../copy/index.js';
import { queryClient } from '../query/client.js';
import { showToast } from '../toast/index.js';
import { reconcileSelection, workspaceDataFromSnapshot, type WorkspaceData } from './model.js';
import {
  addProject,
  deleteSurface,
  deleteSurfacePane,
  deleteProject,
  deleteWorktree,
  fetchActiveContext,
  fetchWorkspace,
  formatRuntimeError,
  getSurfaceDetail,
  launchAgentSession,
  launchTerminalSession,
  openWorktree,
  reconcileWorkspace,
  renameSurfaceTitle,
  relocateProject,
  setWorktreeEnvironmentFocus,
  updateActiveContext,
} from './runtime-data.js';
import { showWorktreeSetupFailure } from './setup-failure.js';
import { useWorkspaceStore } from './store.js';

export const workspaceQueryKey = ['workspace'] as const;
export const activeContextQueryKey = ['workspace', 'active-context'] as const;
export const surfaceDetailQueryKey = (surfaceId: number) => ['surface', surfaceId] as const;

let scheduledActiveContext: ActiveContextPersistenceInput | null = null;
let activeContextInFlight: ActiveContextPersistenceInput | null = null;
let activeContextAbortController: AbortController | null = null;
let activeContextTimer: number | null = null;
const workspaceReconcileInFlightProjectIds = new Set<number | null>();
const surfaceFocusRevisionByWorktreeId = new Map<number, number>();

export function useWorkspaceQuery() {
  return useQuery({
    queryKey: workspaceQueryKey,
    queryFn: ({ signal }) =>
      Effect.runPromise(fetchWorkspace().pipe(Effect.map(workspaceDataFromSnapshot)), { signal }),
  });
}

export function useActiveContextQuery() {
  return useQuery({
    queryKey: activeContextQueryKey,
    queryFn: ({ signal }) => Effect.runPromise(fetchActiveContext(), { signal }),
  });
}

export function useSurfaceDetailQuery(surfaceId: number) {
  return useQuery({
    queryKey: surfaceDetailQueryKey(surfaceId),
    queryFn: ({ signal }) => Effect.runPromise(getSurfaceDetail(surfaceId), { signal }),
  });
}

export function useAddProjectMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => Effect.runPromise(addProject(path)),
    onSuccess: (output) => commitAddProjectSuccess(client, { projectId: output.projectId }),
  });
}

export function useDeleteProjectMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (projectId: number) => Effect.runPromise(deleteProject(projectId)),
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
  const output = await Effect.runPromise(addProject(path));
  await commitAddProjectSuccess(queryClient, { projectId: output.projectId });
}

export async function relocateProjectPath(projectId: number, path: string) {
  const output = await Effect.runPromise(relocateProject(projectId, path));
  await commitRelocateProjectSuccess(queryClient, output.findings);
}

export async function openWorktreeFromPalette(projectId: number, input: OpenWorktreeInput) {
  const output = await Effect.runPromise(openWorktree(projectId, input));
  await commitOpenWorktreeSuccess(queryClient, output);
  return output;
}

export async function deleteWorktreeFromPalette(
  projectId: number,
  worktreeId: number,
  input: DeleteWorktreeInput,
) {
  try {
    const output = await Effect.runPromise(deleteWorktree(projectId, worktreeId, input));
    await commitDeleteWorktreeSuccess(queryClient, output);
    return output;
  } catch (error) {
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
    throw error;
  }
}

export async function startAgentSessionFromPalette(worktreeId: number, harness: AgentHarness) {
  const output = await Effect.runPromise(launchAgentSession(worktreeId, harness));
  await commitLaunchSessionSuccess(queryClient, output);
  return output;
}

export async function startTerminalSessionFromPalette(worktreeId: number) {
  const output = await Effect.runPromise(launchTerminalSession(worktreeId));
  await commitLaunchSessionSuccess(queryClient, output);
  return output;
}

export async function renameSurfaceTitleFromPalette(surfaceId: number, title: string) {
  try {
    const output = await Effect.runPromise(renameSurfaceTitle(surfaceId, title));
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
    const output = await Effect.runPromise(deleteSurface(input.surfaceId));
    await commitDeleteSurfaceSuccess(queryClient, {
      worktreeId: input.worktreeId,
      surfaceId: input.surfaceId,
      output,
      operation: 'surface',
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
    const output = await Effect.runPromise(deleteSurfacePane(input.surfaceId, input.paneId));
    await commitDeleteSurfaceSuccess(queryClient, {
      worktreeId: input.worktreeId,
      surfaceId: input.surfaceId,
      paneId: input.paneId,
      output,
      operation: 'pane',
    });
    return output;
  } catch (error) {
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
    throw error;
  }
}

export function selectSurfaceAndPersistFocus(worktreeId: number, surfaceId: number) {
  const revision = nextSurfaceFocusRevision(worktreeId);
  useWorkspaceStore.getState().selectSurface(worktreeId, surfaceId);

  void Effect.runPromise(
    setWorktreeEnvironmentFocus(worktreeId, {
      activeSurfaceId: surfaceId,
      activePaneId: null,
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(5),
        onTimeout: () => new Error('Surface focus persistence timed out.'),
      }),
    ),
  ).then(
    () => {
      if (surfaceFocusRevisionByWorktreeId.get(worktreeId) !== revision) {
        return;
      }
      commitPersistedSurfaceFocus(queryClient, { worktreeId, surfaceId });
    },
    (error: unknown) => {
      if (surfaceFocusRevisionByWorktreeId.get(worktreeId) !== revision) {
        return;
      }
      showToast({
        id: `surface-focus-persist-failed:${worktreeId}`,
        kind: 'warning',
        title: toastCopy.surfaceFocusPersistFailed.title,
        subtitle: toastCopy.surfaceFocusPersistFailed.subtitle,
      });
      console.error('[workspace] surface focus persistence failed', error);
    },
  );
}

function nextSurfaceFocusRevision(worktreeId: number) {
  const revision = (surfaceFocusRevisionByWorktreeId.get(worktreeId) ?? 0) + 1;
  surfaceFocusRevisionByWorktreeId.set(worktreeId, revision);
  return revision;
}

function commitPersistedSurfaceFocus(
  client: QueryClient,
  input: { readonly worktreeId: number; readonly surfaceId: number },
) {
  client.setQueryData<WorkspaceData>(workspaceQueryKey, (data) => {
    if (!data) {
      return data;
    }
    return {
      projects: data.projects.map((project) => {
        if (project.status !== 'present') {
          return project;
        }
        return {
          ...project,
          worktrees: project.worktrees.map((worktree) =>
            worktree.id === input.worktreeId &&
            worktree.surfaces.some((surface) => surface.id === input.surfaceId)
              ? { ...worktree, activeSurfaceId: input.surfaceId }
              : worktree,
          ),
        };
      }),
    };
  });
}

export async function commitOpenWorktreeSuccess(
  client: QueryClient,
  output: OpenWorktreeOutput,
  fetchWorkspaceData: (signal?: AbortSignal | undefined) => Promise<WorkspaceData> = (signal) =>
    Effect.runPromise(fetchWorkspace().pipe(Effect.map(workspaceDataFromSnapshot)), { signal }),
) {
  await client.fetchQuery({
    queryKey: workspaceQueryKey,
    queryFn: ({ signal }) => fetchWorkspaceData(signal),
    staleTime: 0,
  });
  useWorkspaceStore.getState().selectWorktree(output.projectId, output.worktreeId);
  if (output.status === 'created_setup_failed') {
    showWorktreeSetupFailure(output);
  }
}

export async function commitLaunchSessionSuccess(
  client: QueryClient,
  output: LaunchSessionOutput,
  fetchWorkspaceData: (signal?: AbortSignal | undefined) => Promise<WorkspaceData> = (signal) =>
    Effect.runPromise(fetchWorkspace().pipe(Effect.map(workspaceDataFromSnapshot)), { signal }),
) {
  await client.fetchQuery({
    queryKey: workspaceQueryKey,
    queryFn: ({ signal }) => fetchWorkspaceData(signal),
    staleTime: 0,
  });
  useWorkspaceStore.getState().selectSurface(output.worktreeId, output.surfaceId);
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
    readonly operation: 'pane' | 'surface';
    readonly fetchWorkspaceData?: (signal?: AbortSignal | undefined) => Promise<WorkspaceData>;
  },
) {
  const fetchWorkspaceData =
    input.fetchWorkspaceData ??
    ((signal?: AbortSignal | undefined) =>
      Effect.runPromise(fetchWorkspace().pipe(Effect.map(workspaceDataFromSnapshot)), { signal }));

  await client.fetchQuery({
    queryKey: workspaceQueryKey,
    queryFn: ({ signal }) => fetchWorkspaceData(signal),
    staleTime: 0,
  });

  const store = useWorkspaceStore.getState();
  if (input.output.deletedSurfaceId === input.surfaceId) {
    nextSurfaceFocusRevision(input.worktreeId);
    client.removeQueries({ queryKey: surfaceDetailQueryKey(input.surfaceId), exact: true });
    store.forgetSurface(input.worktreeId, input.surfaceId);
    store.forgetPane(input.surfaceId);
  } else if (input.paneId !== undefined) {
    store.forgetPane(input.surfaceId, input.paneId);
    await client.invalidateQueries({ queryKey: surfaceDetailQueryKey(input.surfaceId) });
  }

  showCleanupWarning(input.operation, input.surfaceId, input.output.warnings);
}

export async function commitDeleteWorktreeSuccess(
  client: QueryClient,
  output: DeleteWorktreeOutput,
  fetchWorkspaceData: (signal?: AbortSignal | undefined) => Promise<WorkspaceData> = (signal) =>
    Effect.runPromise(fetchWorkspace().pipe(Effect.map(workspaceDataFromSnapshot)), { signal }),
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
    return;
  }

  store.setSelection(
    reconcileSelection(data.projects, {
      kind: 'worktree',
      projectId: output.projectId,
      worktreeId: output.selectedWorktreeId,
    }),
  );
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

  void Effect.runPromise(
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

  void Effect.runPromise(reconcileWorkspace(input))
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

function showCleanupWarning(
  operation: 'pane' | 'surface',
  surfaceId: number,
  warnings: readonly SurfaceDeleteWarning[],
) {
  if (warnings.length === 0) {
    return;
  }

  const copy =
    operation === 'pane' ? toastCopy.paneCleanupPending : toastCopy.surfaceCleanupPending;
  showToast({
    id: `${operation}-cleanup-pending:${surfaceId}`,
    kind: 'warning',
    title: copy.title,
    subtitle: copy.subtitle,
  });
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
