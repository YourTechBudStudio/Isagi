import { useCallback, useEffect, useMemo } from 'react';

import { toastCopy } from '../../copy/index.js';
import { showToast } from '../toast/index.js';
import { activateSurface, restoreActivePaneFocus } from './activation.js';
import { applyAttentionToProjects, useAttentionStore } from './attention.js';
import {
  scheduleActiveContextPersistence,
  scheduleWorkspaceReconcileForProject,
} from './background-sync.js';
import {
  activeContextFromSelection,
  activeWorktreeId,
  findMissingProject,
  findWorktree,
  reconcileSelection,
  selectedProjectId,
  selectionFromActiveContext,
} from './model.js';
import { formatRuntimeError, useActiveContextQuery, useWorkspaceQuery } from './queries.js';
import { emptyWorkspaceSelection, useWorkspaceStore } from './store.js';
import type { Surface, Worktree, WorkspaceSelection } from './types.js';
import { useWorkflowSurfaceStore } from './workflow-surface.js';

let suppressedPersistenceSelection: WorkspaceSelection | null = null;
const restorationReconciledProjectIds = new Set<number>();

export function useWorkspaceSelectionSync() {
  const workspace = useWorkspaceQuery();
  const activeContext = useActiveContextQuery();
  const selection = useWorkspaceStore((state) => state.selection);
  const setSelection = useWorkspaceStore((state) => state.setSelection);

  useEffect(() => {
    if (!workspace.data) {
      return;
    }

    const restoredActiveContext = activeContext.data?.activeContext;
    if (selection.kind === 'empty' && !restoredActiveContext && !activeContext.error) {
      return;
    }

    const activeContextLoadFailed = selection.kind === 'empty' && Boolean(activeContext.error);

    if (activeContextLoadFailed) {
      showToast({
        id: 'active-context-load-failed',
        kind: 'warning',
        title: toastCopy.activeContextLoadFailed.title,
        subtitle: toastCopy.activeContextLoadFailed.subtitle,
      });
    }

    const next =
      selection.kind === 'empty'
        ? selectionFromActiveContext(
            workspace.data.projects,
            restoredActiveContext ?? { projectId: null, worktreeId: null },
          )
        : reconcileSelection(workspace.data.projects, selection);

    const restoredProjectId = selection.kind === 'empty' ? restoredActiveContext?.projectId : null;
    if (restoredProjectId && !restorationReconciledProjectIds.has(restoredProjectId)) {
      restorationReconciledProjectIds.add(restoredProjectId);
      scheduleWorkspaceReconcileForProject(restoredProjectId);
    }

    if (!selectionEquals(selection, next)) {
      if (selection.kind === 'empty') {
        suppressedPersistenceSelection = next;
      }

      if (selection.kind === 'worktree' && next.kind === 'worktree') {
        showToast({
          id: `active-worktree-recovered:${selection.worktreeId}`,
          kind: 'warning',
          title: toastCopy.activeWorktreeRecovered.title,
          subtitle: toastCopy.activeWorktreeRecovered.subtitle,
          lifetime: { autoDismiss: false },
        });
      }
      setSelection(next);
    }
  }, [activeContext.data, activeContext.error, workspace.data, selection, setSelection]);
}

export function usePersistActiveContextSelection() {
  const selection = useWorkspaceStore((state) => state.selection);

  useEffect(() => {
    if (
      suppressedPersistenceSelection &&
      selectionEquals(selection, suppressedPersistenceSelection)
    ) {
      suppressedPersistenceSelection = null;
      return;
    }
    suppressedPersistenceSelection = null;

    const activeContext = activeContextFromSelection(selection);
    if (!activeContext) {
      return;
    }

    scheduleActiveContextPersistence(activeContext);
  }, [selection]);
}

export function useWorkspace() {
  const workspace = useWorkspaceQuery();
  const selection = useWorkspaceStore((state) => state.selection);
  const sourcesByKey = useAttentionStore((state) => state.sourcesByKey);
  const workflowSummariesBySurfaceId = useWorkflowSurfaceStore(
    (state) => state.summariesBySurfaceId,
  );
  const activeSurfaceByWorktreeId = useWorkspaceStore((state) => state.activeSurfaceByWorktreeId);
  const selectWorktree = useWorkspaceStore((state) => state.selectWorktree);
  const selectMissingProject = useWorkspaceStore((state) => state.selectMissingProject);
  const selectWorktreeAndRestoreFocus = useCallback(
    (projectId: number, worktreeId: number) => {
      selectWorktree(projectId, worktreeId);
      restoreActivePaneFocus();
    },
    [selectWorktree],
  );
  const selectSurfaceAndActivate = useCallback((worktreeId: number, surfaceId: number) => {
    activateSurface({ worktreeId, surfaceId });
  }, []);

  const projects = useMemo(
    () =>
      applyAttentionToProjects(
        workspace.data?.projects ?? [],
        sourcesByKey,
        workflowSummariesBySurfaceId,
      ),
    [workspace.data?.projects, sourcesByKey, workflowSummariesBySurfaceId],
  );
  const currentActiveWorktreeId = activeWorktreeId(selection);
  const currentSelectedProjectId = selectedProjectId(selection);
  const activeWorktree = findWorktree(projects, currentActiveWorktreeId);
  const activeMissingProject =
    selection.kind === 'missingProject'
      ? findMissingProject(projects, selection.projectId)
      : findMissingProject(projects, currentSelectedProjectId);
  const activeSurface = useMemo(
    () => findWorkspaceActiveSurface(activeWorktree, activeSurfaceByWorktreeId),
    [activeWorktree, activeSurfaceByWorktreeId],
  );

  return {
    projects,
    selection,
    activeWorktreeId: currentActiveWorktreeId,
    selectedProjectId: currentSelectedProjectId,
    activeWorktree,
    activeMissingProject,
    activeSurface,
    loading: workspace.isPending,
    error: workspace.error ? formatRuntimeError(workspace.error) : null,
    selectWorktree: selectWorktreeAndRestoreFocus,
    selectMissingProject,
    selectSurface: selectSurfaceAndActivate,
    activeSurfaceByWorktreeId,
  };
}

export function useActiveWorktree(): Worktree | null {
  const workspace = useWorkspaceQuery();
  const sourcesByKey = useAttentionStore((state) => state.sourcesByKey);
  const workflowSummariesBySurfaceId = useWorkflowSurfaceStore(
    (state) => state.summariesBySurfaceId,
  );
  const projects = useMemo(
    () =>
      applyAttentionToProjects(
        workspace.data?.projects ?? [],
        sourcesByKey,
        workflowSummariesBySurfaceId,
      ),
    [workspace.data?.projects, sourcesByKey, workflowSummariesBySurfaceId],
  );
  const selection = useWorkspaceStore((state) => state.selection);
  return findWorktree(projects, activeWorktreeId(selection));
}

export function workspaceSelectionIsEmpty(selection: WorkspaceSelection) {
  return selectionEquals(selection, emptyWorkspaceSelection);
}

function findWorkspaceActiveSurface(
  worktree: Worktree | null,
  activeSurfaceByWorktreeId: Readonly<Record<number, number>>,
): Surface | null {
  if (!worktree) {
    return null;
  }

  const activeSurfaceId = activeSurfaceByWorktreeId[worktree.id] ?? worktree.activeSurfaceId;
  return worktree.surfaces.find((surface) => surface.id === activeSurfaceId) ?? null;
}

function selectionEquals(left: WorkspaceSelection, right: WorkspaceSelection) {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case 'empty':
      return true;
    case 'missingProject':
      return left.projectId === (right as typeof left).projectId;
    case 'worktree':
      return (
        left.projectId === (right as typeof left).projectId &&
        left.worktreeId === (right as typeof left).worktreeId
      );
  }
}
