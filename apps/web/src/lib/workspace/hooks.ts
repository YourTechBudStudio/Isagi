import { useAtomValue } from '@effect/atom-react';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useCallback, useEffect, useMemo } from 'react';

import type { ProjectKind } from '@isagi/contracts';

import { useAppRun, useRegistry } from '../state/registry.js';
import { queryError } from '../state/result.js';
import { showToast } from '../toast/index.js';
import { activateSurface, restoreActivePaneFocus } from './activation.js';
import { applyAttentionToProjects, attentionSourcesAtom } from './attention.js';
import {
  scheduleActiveContextPersistence,
  scheduleWorkspaceReconcile,
  settleMissingProjectsToast,
} from './background-sync.js';
import {
  activeContextFromSelection,
  activeWorktreeId,
  findMissingProject,
  findWorktree,
  selectedProjectId,
} from './model.js';
import { activeContextAtom, formatRuntimeError, useWorkspaceResult } from './queries.js';
import { nextSelectionSync, selectionEquals, selectionSyncAtom } from './selection-sync.js';
import {
  activeSurfaceByWorktreeAtom,
  emptyWorkspaceSelection,
  selectionAtom,
  selectMissingProject,
  selectWorktree,
  setSelection,
} from './store.js';
import type { Surface, Worktree, WorkspaceSelection } from './types.js';
import { useAttachedWorkflowRuns } from './workflow/queries.js';

/**
 * Restore the selection from the persisted active context on startup, and keep it valid as the
 * workspace changes (`nextSelectionSync` decides; this applies).
 */
export function useWorkspaceSelectionSync() {
  const workspace = useWorkspaceResult();
  const activeContext = useAtomValue(activeContextAtom);
  const registry = useRegistry();
  const run = useAppRun();
  const selection = useAtomValue(selectionAtom);
  const activeContextData = Option.getOrUndefined(AsyncResult.value(activeContext));
  const activeContextError = queryError(activeContext) !== null;

  useEffect(() => {
    const sync = registry.get(selectionSyncAtom);
    const decision = nextSelectionSync({
      selection,
      projects: workspace.data?.projects,
      activeContext: activeContextData?.activeContext,
      activeContextError,
      reconciled: sync.reconciledProjectIds,
    });
    for (const toast of decision.toasts) {
      showToast(registry, toast);
    }
    if (decision.reconcileProjectId !== null) {
      sync.reconciledProjectIds.add(decision.reconcileProjectId);
      void run(scheduleWorkspaceReconcile(decision.reconcileProjectId));
    }
    if (decision.next !== null) {
      if (decision.suppressPersistence) {
        sync.suppressedPersistence = decision.next;
      }
      setSelection(registry, decision.next);
    }
  }, [activeContextData, activeContextError, workspace.data, selection, registry, run]);

  const projects = workspace.data?.projects;
  useEffect(() => {
    if (projects) settleMissingProjectsToast(registry, projects);
  }, [projects, registry]);
}

/** Persist the user's selection as the runtime's active context (debounced, latest wins). */
export function usePersistActiveContextSelection() {
  const registry = useRegistry();
  const run = useAppRun();
  const selection = useAtomValue(selectionAtom);

  useEffect(() => {
    const sync = registry.get(selectionSyncAtom);
    const suppressed = sync.suppressedPersistence;
    sync.suppressedPersistence = null;
    if (suppressed && selectionEquals(selection, suppressed)) {
      return;
    }

    const activeContext = activeContextFromSelection(selection);
    if (!activeContext) {
      return;
    }

    void run(scheduleActiveContextPersistence(activeContext));
  }, [selection, registry, run]);
}

export function useWorkspace() {
  const workspace = useWorkspaceResult();
  const registry = useRegistry();
  const selection = useAtomValue(selectionAtom);
  const sourcesByKey = useAtomValue(attentionSourcesAtom);
  const attachedRuns = useAttachedWorkflowRuns();
  const activeSurfaceByWorktreeId = useAtomValue(activeSurfaceByWorktreeAtom);
  const selectWorktreeAndRestoreFocus = useCallback(
    (projectId: number, worktreeId: number) => {
      selectWorktree(registry, projectId, worktreeId);
      restoreActivePaneFocus(registry);
    },
    [registry],
  );
  const selectMissingProjectInRegistry = useCallback(
    (projectId: number) => selectMissingProject(registry, projectId),
    [registry],
  );
  const selectSurfaceAndActivate = useCallback(
    (worktreeId: number, surfaceId: number) => {
      activateSurface(registry, { worktreeId, surfaceId });
    },
    [registry],
  );

  const projects = useMemo(
    () => applyAttentionToProjects(workspace.data?.projects ?? [], sourcesByKey, attachedRuns),
    [workspace.data?.projects, sourcesByKey, attachedRuns],
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
    error: workspace.error !== null ? formatRuntimeError(workspace.error) : null,
    selectWorktree: selectWorktreeAndRestoreFocus,
    selectMissingProject: selectMissingProjectInRegistry,
    selectSurface: selectSurfaceAndActivate,
    activeSurfaceByWorktreeId,
  };
}

export function useActiveWorktree(): Worktree | null {
  const workspace = useWorkspaceResult();
  const sourcesByKey = useAtomValue(attentionSourcesAtom);
  const attachedRuns = useAttachedWorkflowRuns();
  const projects = useMemo(
    () => applyAttentionToProjects(workspace.data?.projects ?? [], sourcesByKey, attachedRuns),
    [workspace.data?.projects, sourcesByKey, attachedRuns],
  );
  const selection = useAtomValue(selectionAtom);
  return findWorktree(projects, activeWorktreeId(selection));
}

/**
 * The selected project's kind, or `null` when no project is selected or the
 * workspace has not produced one yet.
 *
 * Reads the raw workspace query rather than the attention-decorated projection
 * next door, because kind carries no attention state and decorating a projection
 * to answer an immutable question would be work with no cause.
 *
 * `null` is not the same claim as `'folder'`, even though both suppress the ref
 * tag. It means "no kind is known right now" — a transient or unexpected state
 * rather than a proven-impossible one — and callers must treat it as a reason to
 * show nothing, never as a reason to fall back to Git formatting.
 */
export function useActiveProjectKind(): ProjectKind | null {
  const workspace = useWorkspaceResult();
  const selection = useAtomValue(selectionAtom);
  const projectId = selectedProjectId(selection);
  if (projectId === null) {
    return null;
  }
  return workspace.data?.projects.find((project) => project.id === projectId)?.kind ?? null;
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
