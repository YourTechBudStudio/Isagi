import { create } from "zustand";

export interface CommandPaletteState {
  isOpen: boolean;
  actions: {
    open: () => void;
    close: () => void;
    toggle: () => void;
  };
}

const useCommandPaletteStore = create<CommandPaletteState>(set => ({
  isOpen: false,
  actions: {
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
    toggle: () => set(state => ({ isOpen: !state.isOpen })),
  },
}));

export const useCommandPaletteIsOpen = () =>
  useCommandPaletteStore(state => state.isOpen);
export const useCommandPaletteActions = () =>
  useCommandPaletteStore(state => state.actions);
