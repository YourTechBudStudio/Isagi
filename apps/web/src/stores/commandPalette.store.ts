import { create } from "zustand";

export interface CommandPaletteState {
  isOpen: boolean;
  actions: {
    open: () => void;
    close: () => void;
    toggle: () => void;
  };
}

export const useCommandPaletteStore = create<CommandPaletteState>(set => ({
  isOpen: false,
  actions: {
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
    toggle: () => set(state => ({ isOpen: !state.isOpen })),
  },
}));
