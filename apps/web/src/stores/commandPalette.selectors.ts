import { useCommandPaletteStore } from "./commandPalette.store";

export const useCommandPaletteIsOpen = () =>
  useCommandPaletteStore(state => state.isOpen);

export const useCommandPaletteLaunchRequest = () =>
  useCommandPaletteStore(state => state.launchRequest);

export const useCommandPaletteActions = () =>
  useCommandPaletteStore(state => state.actions);

export const getCommandPaletteState = () => useCommandPaletteStore.getState();
