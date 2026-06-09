import { create } from 'zustand';

import type { WorkspaceSelection } from './types.js';

interface DrawerState {
  readonly open: boolean;
  readonly selectedCommandId: string | null;
}

interface WorkspaceStore {
  selection: WorkspaceSelection;
  activeSurfaceByWorktreeId: Readonly<Record<number, number>>;
  drawer: DrawerState;
  zen: boolean;

  setSelection: (selection: WorkspaceSelection) => void;
  selectWorktree: (projectId: number, worktreeId: number) => void;
  selectMissingProject: (projectId: number) => void;
  selectSurface: (worktreeId: number, surfaceId: number) => void;
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
