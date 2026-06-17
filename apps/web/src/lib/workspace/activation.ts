import { Effect } from 'effect';
import { useEffect, useRef } from 'react';

import type { SurfaceDetail } from '@isagi/contracts';

import { toastCopy } from '../../copy/index.js';
import { queryClient } from '../query/client.js';
import { showToast } from '../toast/index.js';
import { resolveActivePaneId, type WorkspaceData } from './model.js';
import { surfaceDetailQueryKey, workspaceQueryKey } from './query-keys.js';
import { getSurfaceDetail, setWorktreeEnvironmentFocus } from './runtime-data.js';
import { useWorkspaceStore } from './store.js';

export interface ActivateSurfaceInput {
  readonly worktreeId: number;
  readonly surfaceId: number;
}

export interface ActivatePaneInput extends ActivateSurfaceInput {
  readonly paneId: number;
}

interface ActivateOptions {
  readonly persist?: boolean | undefined;
}

interface PaneFocusTarget {
  readonly priority: number;
  readonly focus: () => void;
}

interface PaneFocusRegistration extends PaneFocusTarget {
  readonly token: symbol;
}

const focusRevisionByWorktreeId = new Map<number, number>();
const focusTargetsByPaneKey = new Map<string, PaneFocusRegistration[]>();
let pendingFocusKey: string | null = null;
let scheduledFocusRevision = 0;
let scheduledFocusFrames: readonly number[] = [];

/**
 * Activate a surface as a workbench-level user action. The surface switches
 * immediately; once pane detail is known, the surface's active pane becomes the
 * keyboard target and the runtime focus row is persisted with both ids.
 */
export function activateSurface(input: ActivateSurfaceInput) {
  const revision = nextFocusRevision(input.worktreeId);
  useWorkspaceStore.getState().setActiveSurface(input.worktreeId, input.surfaceId);

  const cachedPaneId = resolvePaneIdFromCache(input.surfaceId);
  if (cachedPaneId !== null) {
    activatePaneWithRevision({ ...input, paneId: cachedPaneId }, { persist: true }, revision);
    return;
  }

  void queryClient
    .fetchQuery({
      queryKey: surfaceDetailQueryKey(input.surfaceId),
      queryFn: ({ signal }) => Effect.runPromise(getSurfaceDetail(input.surfaceId), { signal }),
      staleTime: 0,
    })
    .then(
      (detail) => {
        if (!focusRevisionMatches(input.worktreeId, revision)) {
          return;
        }
        const paneId = resolvePaneIdFromDetail(detail);
        if (paneId !== null) {
          activatePaneWithRevision({ ...input, paneId }, { persist: true }, revision);
          return;
        }
        persistEnvironmentFocus({ ...input, activePaneId: null }, revision);
      },
      (error: unknown) => {
        if (!focusRevisionMatches(input.worktreeId, revision)) {
          return;
        }
        persistEnvironmentFocus({ ...input, activePaneId: null }, revision);
        console.error('[workspace] surface activation detail load failed', error);
      },
    );
}

/**
 * Activate a pane as a workbench-level user action. This is the semantic path:
 * active pane means keyboard focus belongs to the pane's registered target.
 */
export function activatePane(input: ActivatePaneInput, options: ActivateOptions = {}) {
  const revision = nextFocusRevision(input.worktreeId);
  activatePaneWithRevision(input, { persist: options.persist ?? true }, revision);
}

/**
 * Surface detail can reveal the runtime-restored active pane after navigation or
 * app startup. This syncs local active-pane state and keyboard focus without
 * turning a read into a persistence mutation.
 */
export function syncActivePaneFromSurfaceDetail(input: {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly panes: SurfaceDetail['panes'];
  readonly detailActivePaneId: number | null;
  readonly preferredPaneId?: number | null | undefined;
}) {
  const paneId =
    input.preferredPaneId ??
    resolveActivePaneId(
      input.panes,
      useWorkspaceStore.getState().activePaneBySurfaceId[input.surfaceId],
      input.detailActivePaneId,
    );
  if (paneId === null) {
    return;
  }
  useWorkspaceStore.getState().setActivePane(input.surfaceId, paneId);
  requestPaneFocus(input.surfaceId, paneId);
}

/**
 * Return keyboard focus to the active pane after focus-capturing chrome closes.
 */
export function restoreActivePaneFocus() {
  const target = resolveActivePaneTarget();
  if (!target) {
    return;
  }
  requestPaneFocus(target.surfaceId, target.paneId);
}

export function cancelWorkbenchFocusPersistence(worktreeId: number) {
  nextFocusRevision(worktreeId);
}

export function registerPaneFocusTarget(input: {
  readonly surfaceId: number;
  readonly paneId: number;
  readonly priority?: number | undefined;
  readonly focus: () => void;
}) {
  const key = paneKey(input.surfaceId, input.paneId);
  const registration: PaneFocusRegistration = {
    token: Symbol(`pane-focus-${key}`),
    priority: input.priority ?? 0,
    focus: input.focus,
  };
  const registrations = focusTargetsByPaneKey.get(key) ?? [];
  focusTargetsByPaneKey.set(key, [...registrations, registration]);

  if (pendingFocusKey === key || activePaneKey() === key) {
    requestPaneFocus(input.surfaceId, input.paneId);
  }

  return () => {
    const current = focusTargetsByPaneKey.get(key);
    if (!current) {
      return;
    }
    const next = current.filter((candidate) => candidate.token !== registration.token);
    if (next.length === 0) {
      focusTargetsByPaneKey.delete(key);
    } else {
      focusTargetsByPaneKey.set(key, next);
    }
  };
}

export function usePaneFocusTarget(input: {
  readonly surfaceId: number;
  readonly paneId: number;
  readonly priority?: number | undefined;
  readonly enabled?: boolean | undefined;
  readonly focus: () => void;
}) {
  const focusRef = useRef(input.focus);
  focusRef.current = input.focus;

  useEffect(() => {
    if (input.enabled === false) {
      return;
    }
    return registerPaneFocusTarget({
      surfaceId: input.surfaceId,
      paneId: input.paneId,
      priority: input.priority,
      focus: () => focusRef.current(),
    });
  }, [input.enabled, input.paneId, input.priority, input.surfaceId]);
}

function activatePaneWithRevision(
  input: ActivatePaneInput,
  options: Required<ActivateOptions>,
  revision: number,
) {
  const store = useWorkspaceStore.getState();
  store.setActiveSurface(input.worktreeId, input.surfaceId);
  store.setActivePane(input.surfaceId, input.paneId);
  requestPaneFocus(input.surfaceId, input.paneId);
  if (options.persist) {
    persistEnvironmentFocus({ ...input, activePaneId: input.paneId }, revision);
  }
}

function requestPaneFocus(surfaceId: number, paneId: number) {
  const key = paneKey(surfaceId, paneId);
  pendingFocusKey = key;
  scheduleFocus(key);
}

function scheduleFocus(key: string) {
  scheduledFocusRevision += 1;
  const revision = scheduledFocusRevision;
  cancelScheduledFocusFrames();

  const run = () => {
    if (revision !== scheduledFocusRevision) {
      return;
    }
    const target = bestTargetForKey(key);
    if (!target) {
      pendingFocusKey = key;
      return;
    }
    pendingFocusKey = null;
    target.focus();
  };

  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    run();
    return;
  }

  let firstFrame = 0;
  let secondFrame = 0;
  firstFrame = window.requestAnimationFrame(() => {
    scheduledFocusFrames = scheduledFocusFrames.filter((frame) => frame !== firstFrame);
    secondFrame = window.requestAnimationFrame(() => {
      scheduledFocusFrames = scheduledFocusFrames.filter((frame) => frame !== secondFrame);
      run();
    });
    scheduledFocusFrames = [...scheduledFocusFrames, secondFrame];
  });
  scheduledFocusFrames = [firstFrame];
}

function cancelScheduledFocusFrames() {
  if (typeof window === 'undefined' || typeof window.cancelAnimationFrame !== 'function') {
    scheduledFocusFrames = [];
    return;
  }
  for (const frame of scheduledFocusFrames) {
    window.cancelAnimationFrame(frame);
  }
  scheduledFocusFrames = [];
}

function bestTargetForKey(key: string) {
  const targets = focusTargetsByPaneKey.get(key);
  if (!targets?.length) {
    return null;
  }
  return [...targets].sort((left, right) => right.priority - left.priority)[0] ?? null;
}

function persistEnvironmentFocus(
  input: ActivateSurfaceInput & { readonly activePaneId: number | null },
  revision: number,
) {
  void Effect.runPromise(
    setWorktreeEnvironmentFocus(input.worktreeId, {
      activeSurfaceId: input.surfaceId,
      activePaneId: input.activePaneId,
    }),
  ).then(
    () => {
      if (!focusRevisionMatches(input.worktreeId, revision)) {
        return;
      }
      commitPersistedEnvironmentFocus(input);
    },
    (error: unknown) => {
      if (!focusRevisionMatches(input.worktreeId, revision)) {
        return;
      }
      showToast({
        id: `surface-focus-persist-failed:${input.worktreeId}`,
        kind: 'warning',
        title: toastCopy.surfaceFocusPersistFailed.title,
        subtitle: toastCopy.surfaceFocusPersistFailed.subtitle,
      });
      console.error('[workspace] surface focus persistence failed', error);
    },
  );
}

function commitPersistedEnvironmentFocus(
  input: ActivateSurfaceInput & { readonly activePaneId: number | null },
) {
  queryClient.setQueryData<WorkspaceData>(workspaceQueryKey, (data) => {
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

  queryClient.setQueryData<SurfaceDetail>(surfaceDetailQueryKey(input.surfaceId), (detail) =>
    detail ? { ...detail, activePaneId: input.activePaneId } : detail,
  );
}

function resolvePaneIdFromCache(surfaceId: number) {
  const storePaneId = useWorkspaceStore.getState().activePaneBySurfaceId[surfaceId];
  if (storePaneId !== undefined) {
    return storePaneId;
  }
  const detail = queryClient.getQueryData<SurfaceDetail>(surfaceDetailQueryKey(surfaceId));
  return detail ? resolvePaneIdFromDetail(detail) : null;
}

function resolvePaneIdFromDetail(detail: SurfaceDetail) {
  return resolveActivePaneId(detail.panes, null, detail.activePaneId);
}

function resolveActivePaneTarget(): ActivatePaneInput | null {
  const store = useWorkspaceStore.getState();
  if (store.selection.kind !== 'worktree') {
    return null;
  }
  const worktreeId = store.selection.worktreeId;
  const data = queryClient.getQueryData<WorkspaceData>(workspaceQueryKey);
  const worktree = data?.projects
    .filter((project) => project.status === 'present')
    .flatMap((project) => project.worktrees)
    .find((candidate) => candidate.id === worktreeId);
  if (!worktree) {
    return null;
  }
  const surfaceId = store.activeSurfaceByWorktreeId[worktreeId] ?? worktree.activeSurfaceId;
  if (surfaceId === null || surfaceId === undefined) {
    return null;
  }
  const paneId = resolvePaneIdFromCache(surfaceId);
  return paneId === null ? null : { worktreeId, surfaceId, paneId };
}

function activePaneKey() {
  const target = resolveActivePaneTarget();
  return target ? paneKey(target.surfaceId, target.paneId) : null;
}

function paneKey(surfaceId: number, paneId: number) {
  return `${surfaceId}:${paneId}`;
}

function nextFocusRevision(worktreeId: number) {
  const revision = (focusRevisionByWorktreeId.get(worktreeId) ?? 0) + 1;
  focusRevisionByWorktreeId.set(worktreeId, revision);
  return revision;
}

function focusRevisionMatches(worktreeId: number, revision: number) {
  return focusRevisionByWorktreeId.get(worktreeId) === revision;
}
