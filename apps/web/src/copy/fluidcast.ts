import { runtimeErrorCopy } from './errors.js';

// Copy for an agent pane switched between its terminal and the Fluidcast player.
export const fluidcastCopy = {
  toggle: {
    toFluidcast: 'Switch to Fluidcast',
    toTerminal: 'Switch to terminal',
  },
  paletteLabel: 'Switch active pane between terminal and Fluidcast',
  /** The palette's answer when the active pane is not an agent. */
  notAnAgentPane: "The active pane isn't an agent, so there's nothing to switch to Fluidcast.",
  /** The pane's body when there is no runtime URL to point the player at. */
  runtimeUnreachable: runtimeErrorCopy.transport,
} as const;
