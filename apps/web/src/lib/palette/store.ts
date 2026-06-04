import { create } from 'zustand';

import type { ArgValues } from './types.js';

/** Max ids retained for the empty-query recency view. */
const RECENTS_CAP = 12;

interface PaletteStore {
  open: boolean;
  /** When opened straight into a command's wizard (e.g. Mod+N → New worktree). */
  autostartCommandId: string | null;
  /** Pre-filled wizard values (e.g. project-specific rail + button). */
  autostartValues: ArgValues;
  /** Recently run entry ids, most-recent-first. Drives the empty-query view. */
  recents: readonly string[];

  openPalette: (commandId?: string, values?: ArgValues) => void;
  closePalette: () => void;
  pushRecent: (entryId: string) => void;
}

export const usePaletteStore = create<PaletteStore>((set) => ({
  open: false,
  autostartCommandId: null,
  autostartValues: {},
  recents: [],

  openPalette: (commandId, values = {}) =>
    set({ open: true, autostartCommandId: commandId ?? null, autostartValues: values }),
  closePalette: () => set({ open: false, autostartCommandId: null, autostartValues: {} }),
  pushRecent: (entryId) =>
    set((state) => ({
      recents: [entryId, ...state.recents.filter((id) => id !== entryId)].slice(0, RECENTS_CAP),
    })),
}));
