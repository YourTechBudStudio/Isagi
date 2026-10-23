import { Cause, Effect, Exit, Option } from 'effect';
import { AsyncResult, type AtomRegistry } from 'effect/reactivity';
import { useEffect, useRef } from 'react';

import type { SurfaceDetail } from '@isagi/contracts';

import { toastCopy } from '../../copy/index.js';
import { isPaletteOpen } from '../palette/store.js';
import { sessionObject } from '../state/channel.js';
import { patch, peek } from '../state/policy.js';
import { useRegistry } from '../state/registry.js';
import { forkApp } from '../state/runtime.js';
import { showToast } from '../toast/index.js';
import { resolveActivePaneId } from './model.js';
import {
  cachedWorkspaceData,
  patchWorkspaceData,
  readFresh,
  surfaceDetailAtom,
} from './queries.js';
import { setWorktreeEnvironmentFocus } from './runtime-data.js';
import {
  activePaneBySurfaceAtom,
  activeSurfaceByWorktreeAtom,
  drawerAtom,
  selectionAtom,
  setActivePane,
  setActiveSurface,
  workflowInspectorOpenAtom,
} from './store.js';

type Registry = AtomRegistry.AtomRegistry;

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

/**
 * The workbench focus router's state, one per app session (registry). Imperative on purpose: focus
 * targets are DOM callbacks and frames are `requestAnimationFrame` handles, nothing renders from it.
 *
 * - focus revisions per worktree: a persistence or detail load only lands if no newer activation
 *   for that worktree started meanwhile (no request is aborted; stale outcomes are ignored);
 * - registered pane focus targets and the pending focus request;
 * - the scheduled focus frames and their revision;
 * - the drawer's focus function while it is open.
 */
interface WorkbenchFocus {
  readonly focusRevisionByWorktreeId: Map<number, number>;
  readonly focusTargetsByPaneKey: Map<string, PaneFocusRegistration[]>;
  pendingFocusKey: string | null;
  scheduledFocusRevision: number;
  scheduledFocusFrames: readonly number[];
  drawerFocusTarget: (() => void) | null;
}

export const workbenchFocusAtom = sessionObject((): WorkbenchFocus => ({
  focusRevisionByWorktreeId: new Map(),
  focusTargetsByPaneKey: new Map(),
  pendingFocusKey: null,
  scheduledFocusRevision: 0,
  scheduledFocusFrames: [],
  drawerFocusTarget: null,
}));

const focusOf = (registry: Registry): WorkbenchFocus => registry.get(workbenchFocusAtom);

/**
 * Activate a surface as a workbench-level user action. The surface switches
 * immediately; once pane detail is known, the surface's active pane becomes the
 * keyboard target and the runtime focus row is persisted with both ids.
 */
export function activateSurface(registry: Registry, input: ActivateSurfaceInput) {
  const revision = nextFocusRevision(registry, input.worktreeId);
  setActiveSurface(registry, input.worktreeId, input.surfaceId);

  const cachedPaneId = resolvePaneIdFromCache(registry, input.surfaceId);
  if (cachedPaneId !== null) {
    activatePaneWithRevision(
      registry,
      { ...input, paneId: cachedPaneId },
      { persist: true },
      revision,
    );
    return;
  }

  // A fresh detail read (the old `fetchQuery({ staleTime: 0 })`), detached from any component.
  forkApp(
    registry,
    Effect.gen(function* () {
      const loaded = yield* Effect.exit(readFresh(surfaceDetailAtom(input.surfaceId)));
      if (!focusRevisionMatches(registry, input.worktreeId, revision)) {
        return;
      }
      if (Exit.isSuccess(loaded)) {
        const paneId = resolvePaneIdFromDetail(loaded.value);
        if (paneId !== null) {
          activatePaneWithRevision(registry, { ...input, paneId }, { persist: true }, revision);
          return;
        }
        persistEnvironmentFocus(registry, { ...input, activePaneId: null }, revision);
        return;
      }
      persistEnvironmentFocus(registry, { ...input, activePaneId: null }, revision);
      yield* Effect.logError(
        '[workspace] surface activation detail load failed',
        Cause.squash(loaded.cause),
      );
    }),
  );
}

/**
 * Activate a pane as a workbench-level user action. This is the semantic path:
 * active pane means keyboard focus belongs to the pane's registered target.
 */
export function activatePane(
  registry: Registry,
  input: ActivatePaneInput,
  options: ActivateOptions = {},
) {
  const revision = nextFocusRevision(registry, input.worktreeId);
  activatePaneWithRevision(registry, input, { persist: options.persist ?? true }, revision);
}

/**
 * Surface detail can reveal the runtime-restored active pane after navigation or
 * app startup. This syncs local active-pane state and keyboard focus without
 * turning a read into a persistence mutation.
 */
export function syncActivePaneFromSurfaceDetail(
  registry: Registry,
  input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly panes: SurfaceDetail['panes'];
    readonly detailActivePaneId: number | null;
    readonly preferredPaneId?: number | null | undefined;
  },
) {
  const paneId =
    input.preferredPaneId ??
    resolveActivePaneId(
      input.panes,
      registry.get(activePaneBySurfaceAtom)[input.surfaceId],
      input.detailActivePaneId,
    );
  if (paneId === null) {
    return;
  }
  setActivePane(registry, input.surfaceId, paneId);
  requestPaneFocus(registry, input.surfaceId, paneId);
}

/**
 * Return keyboard focus to the active pane after focus-capturing chrome closes.
 */
export function restoreActivePaneFocus(registry: Registry) {
  const target = resolveActivePaneTarget(registry);
  if (!target) {
    return;
  }
  requestPaneFocus(registry, target.surfaceId, target.paneId);
}

/**
 * Register the commands drawer's keyboard-focus function while the drawer is
 * mounted open. Last registration wins; the returned unregister clears only its
 * own registration, mirroring `registerPaneFocusTarget`'s token discipline so a
 * late cleanup cannot strand a newer target.
 */
export function registerDrawerFocusTarget(registry: Registry, focus: () => void): () => void {
  const state = focusOf(registry);
  state.drawerFocusTarget = focus;
  return () => {
    if (state.drawerFocusTarget === focus) {
      state.drawerFocusTarget = null;
    }
  };
}

/**
 * Route keyboard focus to the current workbench owner after focus-capturing
 * chrome closes: the open drawer when present, else the active pane.
 *
 * When the drawer is open but its target has not registered yet (it mounted in
 * the same commit), this does nothing on purpose — the drawer's own
 * focus-on-open effect lands focus, whereas a pane restore here would schedule a
 * deferred focus that steals it back and misdirects keystrokes to a hidden PTY.
 *
 * The rule is owner-based, not handoff-based: if the drawer is open for any
 * reason, pane restoration is wrong. `drawer.open` in the store is synchronous
 * and authoritative even before the drawer component's effects run.
 *
 * `restorePaneFocus` is a unit-test seam only; production callers pass nothing.
 */
export function restoreWorkbenchFocus(
  registry: Registry,
  restorePaneFocus: () => void = () => restoreActivePaneFocus(registry),
) {
  if (registry.get(drawerAtom).open) {
    focusOf(registry).drawerFocusTarget?.();
    return;
  }
  restorePaneFocus();
}

/**
 * Whether the active pane may take keyboard focus right now: true only when no
 * focus-owning overlay is open. The command palette owns focus while open (its
 * focus effect asserts it in every view, the busy panel included); the commands
 * drawer owns it when open with the palette closed; the workflow inspector owns
 * it while open, even after a click on the bar below it dropped focus to the
 * body (a disabled-while-pending control), because a terminal that took focus
 * then would swallow the Escape that closes the inspector and receive keys typed
 * at it.
 *
 * One fact, two enforcement points: the focus scheduler below, and the terminal
 * presentation controller's self-asserting focus calls. Read at focus time,
 * never cached, so it is always current.
 */
export function paneFocusAllowed(registry: Registry): boolean {
  return (
    !isPaletteOpen(registry) &&
    !registry.get(drawerAtom).open &&
    !registry.get(workflowInspectorOpenAtom)
  );
}

export function cancelWorkbenchFocusPersistence(registry: Registry, worktreeId: number) {
  nextFocusRevision(registry, worktreeId);
}

export function registerPaneFocusTarget(
  registry: Registry,
  input: {
    readonly surfaceId: number;
    readonly paneId: number;
    readonly priority?: number | undefined;
    readonly focus: () => void;
  },
) {
  const state = focusOf(registry);
  const key = paneKey(input.surfaceId, input.paneId);
  const registration: PaneFocusRegistration = {
    token: Symbol(`pane-focus-${key}`),
    priority: input.priority ?? 0,
    focus: input.focus,
  };
  const registrations = state.focusTargetsByPaneKey.get(key) ?? [];
  state.focusTargetsByPaneKey.set(key, [...registrations, registration]);

  if (state.pendingFocusKey === key || activePaneKey(registry) === key) {
    requestPaneFocus(registry, input.surfaceId, input.paneId);
  }

  return () => {
    const current = state.focusTargetsByPaneKey.get(key);
    if (!current) {
      return;
    }
    const next = current.filter((candidate) => candidate.token !== registration.token);
    if (next.length === 0) {
      state.focusTargetsByPaneKey.delete(key);
    } else {
      state.focusTargetsByPaneKey.set(key, next);
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
  const registry = useRegistry();
  const focusRef = useRef(input.focus);
  focusRef.current = input.focus;

  useEffect(() => {
    if (input.enabled === false) {
      return;
    }
    return registerPaneFocusTarget(registry, {
      surfaceId: input.surfaceId,
      paneId: input.paneId,
      priority: input.priority,
      focus: () => focusRef.current(),
    });
  }, [registry, input.enabled, input.paneId, input.priority, input.surfaceId]);
}

function activatePaneWithRevision(
  registry: Registry,
  input: ActivatePaneInput,
  options: Required<ActivateOptions>,
  revision: number,
) {
  setActiveSurface(registry, input.worktreeId, input.surfaceId);
  setActivePane(registry, input.surfaceId, input.paneId);
  requestPaneFocus(registry, input.surfaceId, input.paneId);
  if (options.persist) {
    persistEnvironmentFocus(registry, { ...input, activePaneId: input.paneId }, revision);
  }
}

function requestPaneFocus(registry: Registry, surfaceId: number, paneId: number) {
  const key = paneKey(surfaceId, paneId);
  focusOf(registry).pendingFocusKey = key;
  scheduleFocus(registry, key);
}

function scheduleFocus(registry: Registry, key: string) {
  const state = focusOf(registry);
  state.scheduledFocusRevision += 1;
  const revision = state.scheduledFocusRevision;
  cancelScheduledFocusFrames(state);

  const run = () => {
    if (revision !== state.scheduledFocusRevision) {
      return;
    }
    // Ownership is checked at fire time, not request time: that is what defeats
    // the steal. A palette row's `run()` may request pane focus while the
    // palette is still up; by the time the deferred callback runs an overlay
    // owns focus and the request dies here. `pendingFocusKey` is cleared so a
    // later pane registration cannot resurrect an obsolete request — each
    // overlay's own close path is the correctly ordered way pane focus returns.
    // The revision check above must stay first, so a stale callback never
    // clears a newer request's pending key.
    if (!paneFocusAllowed(registry)) {
      state.pendingFocusKey = null;
      return;
    }
    const target = bestTargetForKey(state, key);
    if (!target) {
      state.pendingFocusKey = key;
      return;
    }
    state.pendingFocusKey = null;
    target.focus();
  };

  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    run();
    return;
  }

  let firstFrame = 0;
  let secondFrame = 0;
  firstFrame = window.requestAnimationFrame(() => {
    state.scheduledFocusFrames = state.scheduledFocusFrames.filter((frame) => frame !== firstFrame);
    secondFrame = window.requestAnimationFrame(() => {
      state.scheduledFocusFrames = state.scheduledFocusFrames.filter(
        (frame) => frame !== secondFrame,
      );
      run();
    });
    state.scheduledFocusFrames = [...state.scheduledFocusFrames, secondFrame];
  });
  state.scheduledFocusFrames = [firstFrame];
}

function cancelScheduledFocusFrames(state: WorkbenchFocus) {
  if (typeof window === 'undefined' || typeof window.cancelAnimationFrame !== 'function') {
    state.scheduledFocusFrames = [];
    return;
  }
  for (const frame of state.scheduledFocusFrames) {
    window.cancelAnimationFrame(frame);
  }
  state.scheduledFocusFrames = [];
}

function bestTargetForKey(state: WorkbenchFocus, key: string) {
  const targets = state.focusTargetsByPaneKey.get(key);
  if (!targets?.length) {
    return null;
  }
  return [...targets].sort((left, right) => right.priority - left.priority)[0] ?? null;
}

/**
 * Persist the worktree's focus row. The write is never aborted (uninterruptible, detached from
 * components); only a stale outcome is ignored, by the worktree's focus revision. Success patches
 * the held workspace and surface detail in place; a failure of the latest activation toasts.
 */
function persistEnvironmentFocus(
  registry: Registry,
  input: ActivateSurfaceInput & { readonly activePaneId: number | null },
  revision: number,
) {
  forkApp(
    registry,
    Effect.gen(function* () {
      const persisted = yield* Effect.exit(
        Effect.uninterruptible(
          setWorktreeEnvironmentFocus(input.worktreeId, {
            activeSurfaceId: input.surfaceId,
            activePaneId: input.activePaneId,
          }),
        ),
      );
      if (!focusRevisionMatches(registry, input.worktreeId, revision)) {
        return;
      }
      if (Exit.isSuccess(persisted)) {
        commitPersistedEnvironmentFocus(registry, input);
        return;
      }
      showToast(registry, {
        id: `surface-focus-persist-failed:${input.worktreeId}`,
        kind: 'warning',
        title: toastCopy.surfaceFocusPersistFailed.title,
        subtitle: toastCopy.surfaceFocusPersistFailed.subtitle,
      });
      yield* Effect.logError(
        '[workspace] surface focus persistence failed',
        Cause.squash(persisted.cause),
      );
    }),
  );
}

function commitPersistedEnvironmentFocus(
  registry: Registry,
  input: ActivateSurfaceInput & { readonly activePaneId: number | null },
) {
  patchWorkspaceData(registry, (data) => ({
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
  }));

  patch(registry, surfaceDetailAtom(input.surfaceId), (detail) => ({
    ...detail,
    activePaneId: input.activePaneId,
  }));
}

function resolvePaneIdFromCache(registry: Registry, surfaceId: number) {
  const storePaneId = registry.get(activePaneBySurfaceAtom)[surfaceId];
  if (storePaneId !== undefined) {
    return storePaneId;
  }
  const detail = Option.getOrUndefined(
    Option.flatMap(peek(registry, surfaceDetailAtom(surfaceId)), AsyncResult.value),
  );
  return detail ? resolvePaneIdFromDetail(detail) : null;
}

function resolvePaneIdFromDetail(detail: SurfaceDetail) {
  return resolveActivePaneId(detail.panes, null, detail.activePaneId);
}

function resolveActivePaneTarget(registry: Registry): ActivatePaneInput | null {
  const selection = registry.get(selectionAtom);
  if (selection.kind !== 'worktree') {
    return null;
  }
  const worktreeId = selection.worktreeId;
  const data = cachedWorkspaceData(registry);
  const worktree = data?.projects
    .filter((project) => project.status === 'present')
    .flatMap((project) => project.worktrees)
    .find((candidate) => candidate.id === worktreeId);
  if (!worktree) {
    return null;
  }
  const surfaceId =
    registry.get(activeSurfaceByWorktreeAtom)[worktreeId] ?? worktree.activeSurfaceId;
  if (surfaceId === null || surfaceId === undefined) {
    return null;
  }
  const paneId = resolvePaneIdFromCache(registry, surfaceId);
  return paneId === null ? null : { worktreeId, surfaceId, paneId };
}

function activePaneKey(registry: Registry) {
  const target = resolveActivePaneTarget(registry);
  return target ? paneKey(target.surfaceId, target.paneId) : null;
}

function paneKey(surfaceId: number, paneId: number) {
  return `${surfaceId}:${paneId}`;
}

function nextFocusRevision(registry: Registry, worktreeId: number) {
  const revisions = focusOf(registry).focusRevisionByWorktreeId;
  const revision = (revisions.get(worktreeId) ?? 0) + 1;
  revisions.set(worktreeId, revision);
  return revision;
}

function focusRevisionMatches(registry: Registry, worktreeId: number, revision: number) {
  return focusOf(registry).focusRevisionByWorktreeId.get(worktreeId) === revision;
}
