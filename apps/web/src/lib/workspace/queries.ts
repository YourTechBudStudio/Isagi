import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Duration, Effect } from 'effect';

import type {
  ActiveContextPersistenceInput,
  OpenWorktreeInput,
  OpenWorktreeOutput,
  ReconciliationFinding,
  SetActiveContextInput,
} from '@isagi/contracts';

import { queryClient } from '../query/client.js';
import { showToast } from '../toast/index.js';
import { workspaceDataFromSnapshot, type WorkspaceData } from './model.js';
import {
  addProject,
  deleteProject,
  fetchActiveContext,
  fetchWorkspace,
  formatRuntimeError,
  openWorktree,
  reconcileWorkspace,
  relocateProject,
  updateActiveContext,
} from './runtime-data.js';
import { useWorkspaceStore } from './store.js';

export const workspaceQueryKey = ['workspace'] as const;
export const activeContextQueryKey = ['workspace', 'active-context'] as const;

let scheduledActiveContext: ActiveContextPersistenceInput | null = null;
let activeContextInFlight: ActiveContextPersistenceInput | null = null;
let activeContextAbortController: AbortController | null = null;
let activeContextTimer: number | null = null;
const workspaceReconcileInFlightProjectIds = new Set<number | null>();

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
        title: 'Could not remove the project.',
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
          title: 'Could not save the last active worktree.',
          subtitle: 'This session is fine; restart may reopen elsewhere.',
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

function handleReconciliationFindings(findings: readonly ReconciliationFinding[]) {
  if (findings.length === 0) {
    return;
  }

  if (findings.some((finding) => finding.kind === 'project_missing')) {
    showToast({
      id: 'workspace-project-missing',
      kind: 'warning',
      title: 'A project is unavailable.',
      subtitle: 'Open the project row to update or remove it.',
      lifetime: { autoDismiss: false },
    });
  }

  if (findings.some((finding) => finding.kind === 'worktree_missing')) {
    showToast({
      id: 'workspace-worktree-missing',
      kind: 'warning',
      title: 'A worktree is no longer available.',
      subtitle: 'Workspace state was refreshed from Git.',
      lifetime: { autoDismiss: false },
    });
  }
}

export { formatRuntimeError };
