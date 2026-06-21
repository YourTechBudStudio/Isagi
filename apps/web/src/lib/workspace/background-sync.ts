import type { QueryClient } from '@tanstack/react-query';
import { Duration, Effect } from 'effect';

import type {
  ActiveContextPersistenceInput,
  ReconciliationFinding,
  SetActiveContextInput,
} from '@isagi/contracts';

import { toastCopy } from '../../copy/index.js';
import { queryClient } from '../query/client.js';
import { runRuntimeEffect } from '../runtime/run.js';
import { showToast } from '../toast/index.js';
import { activeContextQueryKey, workspaceQueryKey } from './query-keys.js';
import { reconcileWorkspace, updateActiveContext } from './runtime-data.js';

let scheduledActiveContext: ActiveContextPersistenceInput | null = null;
let activeContextInFlight: ActiveContextPersistenceInput | null = null;
let activeContextAbortController: AbortController | null = null;
let activeContextTimer: number | null = null;
const workspaceReconcileInFlightProjectIds = new Set<number | null>();

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

export function handleReconciliationFindings(findings: readonly ReconciliationFinding[]) {
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
