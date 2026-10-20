import type { FluidcastHandoffFailure } from '@isagi/contracts';

import { runtimeErrorCopy } from './errors.js';

const terminalStopped = 'The terminal was stopped.';

const startFailedBody = {
  executable_not_found: "Couldn't find the agent's executable.",
  instrumentation_failed: "Couldn't set up the agent's hooks.",
  // A build that timed out and one that broke both land here, so the copy names neither.
  session_build_failed: "The Fluidcast session didn't come up.",
} as const satisfies Record<
  Extract<FluidcastHandoffFailure, { code: 'fluidcast_start_failed' }>['reason'],
  string
>;

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
  /**
   * A switch to Fluidcast that began cleanup and left no Fluidcast session running. Each line says
   * what state the agent was left in, without leaning on the diagnostic shown under it.
   */
  failure: {
    statusLabel: 'switch failed',
    retry: 'Retry',
    back: 'Back to terminal',
    describe: (
      failure: FluidcastHandoffFailure,
    ): { readonly title: string; readonly body: string } => {
      switch (failure.code) {
        case 'terminal_stop_failed':
          return {
            title: "Couldn't stop the terminal",
            body: "It may still be running, so Fluidcast didn't start. Retry stops it and starts Fluidcast; Back to terminal keeps it.",
          };
        case 'fluidcast_session_unreadable':
          return {
            title: "Fluidcast couldn't read this conversation",
            body: `${terminalStopped} The conversation was left as it was, and nothing new was started.`,
          };
        case 'fluidcast_start_failed':
          return {
            title: "Fluidcast didn't start",
            body: `${startFailedBody[failure.reason]} ${terminalStopped}`,
          };
        case 'fluidcast_preparation_failed':
          return {
            title: "Couldn't finish the switch",
            body: 'The terminal was stopped, then something else broke before Fluidcast could start.',
          };
      }
    },
  },
} as const;
