import { create } from "zustand";

import type { CommandId } from "@/lib/commands/commands";

interface CommandLaunchRequest {
  readonly commandId: CommandId;
  readonly nonce: number;
}

export interface CommandPaletteState {
  readonly isOpen: boolean;
  readonly launchRequest: CommandLaunchRequest | null;
  readonly actions: {
    open: () => void;
    close: () => void;
    toggle: () => void;
    launchCommand: (commandId: CommandId) => void;
    clearLaunchRequest: () => void;
  };
}

export const useCommandPaletteStore = create<CommandPaletteState>(set => ({
  isOpen: false,
  launchRequest: null,
  actions: {
    open: () => set({ isOpen: true, launchRequest: null }),
    close: () => set({ isOpen: false, launchRequest: null }),
    toggle: () =>
      set(state => ({
        isOpen: !state.isOpen,
        launchRequest: state.isOpen ? null : state.launchRequest,
      })),
    launchCommand: commandId =>
      set(state => ({
        isOpen: true,
        launchRequest: {
          commandId,
          nonce: (state.launchRequest?.nonce ?? 0) + 1,
        },
      })),
    clearLaunchRequest: () => set({ launchRequest: null }),
  },
}));
