import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

import { loadTerminalFonts, terminalInitOptions } from '../terminal-appearance.js';
import {
  clearTerminalRenderCache,
  measureTerminalFit,
  type TerminalFitSize,
} from '../terminal-geometry.js';

/**
 * Every browser capability the presentation controller reaches for, in one
 * injectable record.
 *
 * The controller orchestrates a long-lived, failure-prone lifecycle — a
 * terminal, a socket, a GPU addon, frames, observers, and a runtime claim — and
 * that orchestration is the part worth testing. Routing the raw capabilities
 * through this seam lets the production controller run against fakes in a
 * DOM-less test process; nothing here holds behavior of its own beyond the
 * default browser wiring below.
 */
export interface TerminalPresentationEnvironment {
  readonly createHost: () => HTMLDivElement;
  /** Options are named, not spelled out: the token-derived dress is a DOM read and belongs here. */
  readonly createTerminal: (options: {
    readonly disableStdin: boolean;
    readonly scrollback: number;
    /** The controller passes `false` and owns return-to-latest itself; see its `onData` handling. */
    readonly scrollOnUserInput: boolean;
  }) => Terminal;
  readonly createWebglAddon: () => WebglAddon;
  readonly openSocket: (url: string) => WebSocket;
  /** Deferral for the operational claim, so a StrictMode probe can cancel it. */
  readonly scheduleTask: (task: () => void) => number;
  readonly cancelTask: (handle: number) => void;
  readonly requestFrame: (frame: () => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly observeResize: (target: Element, onResize: () => void) => () => void;
  readonly fontsReady: () => Promise<void>;
  readonly measureFit: (terminal: Terminal, host: HTMLElement) => TerminalFitSize | null;
  readonly clearRenderCache: (terminal: Terminal) => void;
  readonly monotonicNow: () => number;
}

export const browserTerminalEnvironment: TerminalPresentationEnvironment = {
  createHost: () => document.createElement('div'),
  createTerminal: (options) => new Terminal(terminalInitOptions(options)),
  createWebglAddon: () => new WebglAddon(),
  openSocket: (url) => new WebSocket(url),
  scheduleTask: (task) => window.setTimeout(task, 0),
  cancelTask: (handle) => window.clearTimeout(handle),
  requestFrame: (frame) => window.requestAnimationFrame(frame),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  observeResize: (target, onResize) => {
    const observer = new ResizeObserver(onResize);
    observer.observe(target);
    return () => observer.disconnect();
  },
  fontsReady: loadTerminalFonts,
  measureFit: measureTerminalFit,
  clearRenderCache: clearTerminalRenderCache,
  monotonicNow: () => performance.now(),
};
