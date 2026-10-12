/**
 * Workbench interaction state the client owns: which environment is selected, which surface and
 * pane are active, the commands drawer, the workflow inspector and zen mode. One set per app session
 * (registry).
 *
 * React reads the atoms with `useAtomValue`; every write goes through the `(registry, ...)` actions
 * below, so the transitions stay in one place.
 */
import { Atom, type AtomRegistry } from 'effect/reactivity';

import type { WorkspaceSelection } from './types.js';

export interface DrawerState {
  readonly open: boolean;
  readonly selectedCommandId: string | null;
}

export const emptyWorkspaceSelection: WorkspaceSelection = { kind: 'empty' };

export const selectionAtom = Atom.make<WorkspaceSelection>(emptyWorkspaceSelection).pipe(
  Atom.keepAlive,
);

/** Surface id the user last activated per worktree id. */
export const activeSurfaceByWorktreeAtom = Atom.make<Readonly<Record<number, number>>>({}).pipe(
  Atom.keepAlive,
);

/** Pane id the user last activated per surface id. */
export const activePaneBySurfaceAtom = Atom.make<Readonly<Record<number, number>>>({}).pipe(
  Atom.keepAlive,
);

export const drawerAtom = Atom.make<DrawerState>({ open: false, selectedCommandId: null }).pipe(
  Atom.keepAlive,
);

export const zenAtom = Atom.make(false).pipe(Atom.keepAlive);

/**
 * Whether the workflow inspector is open over the active surface's run.
 *
 * Registry state rather than the workflow bar's local state because pane focus reads it: an open
 * inspector owns keyboard focus the way the drawer does, so the focus router and the terminal's
 * self-asserting focus calls must be able to see it (`paneFocusAllowed`). Still not a route: it opens
 * only from the bar of the surface its run is attached to.
 */
export const workflowInspectorOpenAtom = Atom.make(false).pipe(Atom.keepAlive);

type Registry = AtomRegistry.AtomRegistry;

export function setSelection(registry: Registry, selection: WorkspaceSelection): void {
  registry.set(selectionAtom, selection);
}

export function selectWorktree(registry: Registry, projectId: number, worktreeId: number): void {
  registry.set(selectionAtom, { kind: 'worktree', projectId, worktreeId });
}

/** Selects a missing project and closes the drawer, as one transition. */
export function selectMissingProject(registry: Registry, projectId: number): void {
  Atom.batch(() => {
    registry.set(selectionAtom, { kind: 'missingProject', projectId });
    registry.set(drawerAtom, { open: false, selectedCommandId: null });
  });
}

export function setActiveSurface(registry: Registry, worktreeId: number, surfaceId: number): void {
  registry.update(activeSurfaceByWorktreeAtom, (current) => ({
    ...current,
    [worktreeId]: surfaceId,
  }));
}

export function setActivePane(registry: Registry, surfaceId: number, paneId: number): void {
  registry.update(activePaneBySurfaceAtom, (current) => ({ ...current, [surfaceId]: paneId }));
}

/** Forgets the worktree's active surface, but only while it is still `surfaceId`. */
export function forgetSurface(registry: Registry, worktreeId: number, surfaceId: number): void {
  registry.update(activeSurfaceByWorktreeAtom, (current) => {
    if (current[worktreeId] !== surfaceId) {
      return current;
    }
    const next = { ...current };
    delete next[worktreeId];
    return next;
  });
}

/** Forgets the surface's active pane; with `paneId`, only while it is still that pane. */
export function forgetPane(registry: Registry, surfaceId: number, paneId?: number): void {
  registry.update(activePaneBySurfaceAtom, (current) => {
    const storedPaneId = current[surfaceId];
    if (storedPaneId === undefined || (paneId !== undefined && storedPaneId !== paneId)) {
      return current;
    }
    const next = { ...current };
    delete next[surfaceId];
    return next;
  });
}

export function setZen(registry: Registry, zen: boolean): void {
  registry.set(zenAtom, zen);
}

export function toggleZen(registry: Registry): void {
  registry.update(zenAtom, (zen) => !zen);
}

export function setWorkflowInspectorOpen(registry: Registry, open: boolean): void {
  registry.set(workflowInspectorOpenAtom, open);
}

/** Opens the drawer, selecting `commandId` when given and keeping the selection otherwise. */
export function openDrawer(registry: Registry, commandId?: string): void {
  registry.update(drawerAtom, (drawer) => ({
    open: true,
    selectedCommandId: commandId ?? drawer.selectedCommandId,
  }));
}

export function closeDrawer(registry: Registry): void {
  registry.update(drawerAtom, (drawer) => ({ ...drawer, open: false }));
}

export function selectCommand(registry: Registry, commandId: string): void {
  registry.update(drawerAtom, (drawer) => ({ ...drawer, selectedCommandId: commandId }));
}
