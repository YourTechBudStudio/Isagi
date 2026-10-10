/**
 * Command palette chrome state: whether it is open, what it was opened into, and recents. Frontend
 * interaction state, one per app session (registry). React reads `paletteAtom` with
 * `useAtomValue`; every write goes through the actions below.
 */
import { Atom, type AtomRegistry } from 'effect/reactivity';

import type { ArgValues } from './types.js';

/** Max ids retained for the empty-query recency view. */
const RECENTS_CAP = 12;

export interface PaletteState {
  readonly open: boolean;
  /** When opened straight into an entry's command wizard (e.g. Mod+N -> Add project). */
  readonly autostartEntryId: string | null;
  /** Pre-filled wizard values (e.g. project-specific rail + button). */
  readonly autostartValues: ArgValues;
  /** Recently run entry ids, most-recent-first. Drives the empty-query view. */
  readonly recents: readonly string[];
}

export const paletteAtom = Atom.make<PaletteState>({
  open: false,
  autostartEntryId: null,
  autostartValues: {},
  recents: [],
}).pipe(Atom.keepAlive);

export function openPalette(
  registry: AtomRegistry.AtomRegistry,
  entryId?: string,
  values: ArgValues = {},
): void {
  registry.update(paletteAtom, (state) => ({
    ...state,
    open: true,
    autostartEntryId: entryId ?? null,
    autostartValues: values,
  }));
}

export function closePalette(registry: AtomRegistry.AtomRegistry): void {
  registry.update(paletteAtom, (state) => ({
    ...state,
    open: false,
    autostartEntryId: null,
    autostartValues: {},
  }));
}

export function pushRecent(registry: AtomRegistry.AtomRegistry, entryId: string): void {
  registry.update(paletteAtom, (state) => ({
    ...state,
    recents: [entryId, ...state.recents.filter((id) => id !== entryId)].slice(0, RECENTS_CAP),
  }));
}

/** Whether the palette is open right now; read at event time by focus routing. */
export function isPaletteOpen(registry: AtomRegistry.AtomRegistry): boolean {
  return registry.get(paletteAtom).open;
}

const selectOpen = (state: PaletteState) => state.open;
const selectAutostartEntryId = (state: PaletteState) => state.autostartEntryId;
const selectAutostartValues = (state: PaletteState) => state.autostartValues;
const selectRecents = (state: PaletteState) => state.recents;

/** Stable selectors for `useAtomValue(paletteAtom, selector)`. */
export const paletteSelectors = {
  open: selectOpen,
  autostartEntryId: selectAutostartEntryId,
  autostartValues: selectAutostartValues,
  recents: selectRecents,
} as const;
