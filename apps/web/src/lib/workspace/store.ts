import { create } from 'zustand';

import type { WorkspaceSelection } from './types.js';

interface DrawerState {
  readonly open: boolean;
  readonly selectedCommandId: string | null;
}

interface WorkspaceStore {
  selection: WorkspaceSelection;
  activeSurfaceByWorktreeId: Readonly<Record<number, number>>;
  activePaneBySurfaceId: Readonly<Record<number, number>>;
  drawer: DrawerState;
  zen: boolean;

  setSelection: (selection: WorkspaceSelection) => void;
  selectWorktree: (projectId: number, worktreeId: number) => void;
  selectMissingProject: (projectId: number) => void;
  selectSurface: (worktreeId: number, surfaceId: number) => void;
  focusPane: (surfaceId: number, paneId: number) => void;
  forgetSurface: (worktreeId: number, surfaceId: number) => void;
  forgetPane: (surfaceId: number, paneId?: number) => void;
  setZen: (zen: boolean) => void;
  toggleZen: () => void;
  openDrawer: (commandId?: string) => void;
  closeDrawer: () => void;
  selectCommand: (commandId: string) => void;
}

export const emptyWorkspaceSelection: WorkspaceSelection = { kind: 'empty' };

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  selection: emptyWorkspaceSelection,
  activeSurfaceByWorktreeId: {},
  activePaneBySurfaceId: {},
  drawer: { open: false, selectedCommandId: null },
  zen: false,

  setSelection: (selection) => set({ selection }),
  selectWorktree: (projectId, worktreeId) =>
    set({
      selection: { kind: 'worktree', projectId, worktreeId },
    }),
  selectMissingProject: (projectId) =>
    set({
      selection: { kind: 'missingProject', projectId },
      drawer: { open: false, selectedCommandId: null },
    }),
  selectSurface: (worktreeId, surfaceId) =>
    set((state) => ({
      activeSurfaceByWorktreeId: {
        ...state.activeSurfaceByWorktreeId,
        [worktreeId]: surfaceId,
      },
    })),
  focusPane: (surfaceId, paneId) =>
    set((state) => ({
      activePaneBySurfaceId: {
        ...state.activePaneBySurfaceId,
        [surfaceId]: paneId,
      },
    })),
  forgetSurface: (worktreeId, surfaceId) =>
    set((state) => {
      if (state.activeSurfaceByWorktreeId[worktreeId] !== surfaceId) {
        return {};
      }
      const next = { ...state.activeSurfaceByWorktreeId };
      delete next[worktreeId];
      return { activeSurfaceByWorktreeId: next };
    }),
  forgetPane: (surfaceId, paneId) =>
    set((state) => {
      const storedPaneId = state.activePaneBySurfaceId[surfaceId];
      if (storedPaneId === undefined || (paneId !== undefined && storedPaneId !== paneId)) {
        return {};
      }
      const next = { ...state.activePaneBySurfaceId };
      delete next[surfaceId];
      return { activePaneBySurfaceId: next };
    }),

  setZen: (zen) => set({ zen }),
  toggleZen: () => set((state) => ({ zen: !state.zen })),

  openDrawer: (commandId) =>
    set((state) => ({
      drawer: {
        open: true,
        selectedCommandId: commandId ?? state.drawer.selectedCommandId,
      },
    })),

  closeDrawer: () => set((state) => ({ drawer: { ...state.drawer, open: false } })),

  selectCommand: (commandId) =>
    set((state) => ({ drawer: { ...state.drawer, selectedCommandId: commandId } })),
}));
