import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

import type { TerminalFitSize } from '../terminal-geometry.js';
import type { TerminalPresentationEnvironment } from './environment.js';

/**
 * Fakes for every browser capability the presentation controller uses, so the
 * production controller can be driven through its real lifecycle in a DOM-less
 * test process. Frames and tasks are queues the test drains by hand: activation,
 * parking, and geometry are all frame-ordered, and a test that cannot order
 * frames cannot tell "resized once at the end" from "resized on every drag tick".
 */
export interface FakeTerminalEnvironment extends TerminalPresentationEnvironment {
  /** Runtime claims the test attributed to this environment. */
  claims: number;
  /** What `measureFit` reports next. */
  fitSize: TerminalFitSize;
  /** When set, `createTerminal` throws with this message instead of building one. */
  terminalCreationFailure: string | null;
  /** Release the font barrier `fontsReady()` is holding. */
  readonly resolveFonts: () => void;
  readonly parkingRoot: HTMLElement;
  readonly terminals: readonly FakeTerminal[];
  readonly terminal: FakeTerminal;
  readonly sockets: readonly FakeSocket[];
  readonly socket: FakeSocket;
  readonly resizeObservers: readonly FakeResizeObserver[];
  /** Appends of the terminal host into a visible slot. */
  readonly hostMoves: number;
  /** Appends of the terminal host into the inert parking root. */
  readonly parkMoves: number;
  readonly webglCreated: number;
  readonly webglDisposed: number;
  readonly createSlot: () => FakeSlot;
  /** Drop the GPU context under the live addon, as a driver reset would. */
  readonly loseWebglContext: () => void;
  readonly runFrames: () => void;
  readonly runTasks: () => void;
  readonly resizeMessages: () => readonly TerminalFitSize[];
}

export interface FakeSlot {
  readonly element: HTMLElement;
  /** Fire the slot's resize observer, as a split drag or window resize would. */
  readonly resize: () => void;
}

export interface FakeTerminal {
  readonly options: { disableStdin: boolean };
  readonly written: string[];
  readonly cols: number;
  readonly rows: number;
  readonly openCount: number;
  readonly disposeCount: number;
  readonly focusCount: number;
  readonly blurCount: number;
  readonly refreshCount: number;
}

export interface FakeSocket {
  readonly sent: string[];
  readonly closeCount: number;
  readonly open: () => void;
  readonly emitMessage: (payload: unknown) => void;
}

export interface FakeResizeObserver {
  readonly stopped: boolean;
}

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

export function createFakeTerminalEnvironment(): FakeTerminalEnvironment {
  const terminals: FakeTerminalImpl[] = [];
  const sockets: FakeSocketImpl[] = [];
  const observers: FakeResizeObserverImpl[] = [];
  const frames = new Map<number, () => void>();
  const tasks = new Map<number, () => void>();
  const contextLossListeners = new Map<object, () => void>();
  let nextHandle = 0;
  let webglCreated = 0;
  let webglDisposed = 0;
  let hostMoves = 0;
  let parkMoves = 0;

  let releaseFonts = () => undefined as void;
  const fonts = new Promise<void>((resolve) => {
    releaseFonts = resolve;
  });

  const parkingRoot = new FakeElement('parking', () => {
    parkMoves += 1;
  });

  const env: FakeTerminalEnvironment = {
    claims: 0,
    fitSize: { cols: 80, rows: 24 },
    parkingRoot: parkingRoot.asElement(),
    terminals,
    get terminal() {
      const first = terminals[0];
      if (!first) throw new Error('No terminal was created.');
      return first;
    },
    sockets,
    get socket() {
      const first = sockets[0];
      if (!first) throw new Error('No socket was opened.');
      return first;
    },
    resizeObservers: observers,
    get hostMoves() {
      return hostMoves;
    },
    get parkMoves() {
      return parkMoves;
    },
    get webglCreated() {
      return webglCreated;
    },
    get webglDisposed() {
      return webglDisposed;
    },

    terminalCreationFailure: null,
    resolveFonts: () => releaseFonts(),

    createHost: () => new FakeElement('host').asElement() as HTMLDivElement,
    createTerminal: () => {
      if (env.terminalCreationFailure) throw new Error(env.terminalCreationFailure);
      const terminal = new FakeTerminalImpl();
      terminals.push(terminal);
      return terminal.asTerminal();
    },
    createWebglAddon: () => {
      webglCreated += 1;
      const addon = {
        onContextLoss: (listener: () => void) => {
          contextLossListeners.set(addon, listener);
          return { dispose: () => undefined };
        },
        dispose: () => {
          webglDisposed += 1;
          contextLossListeners.delete(addon);
        },
      };
      return addon as unknown as WebglAddon;
    },
    openSocket: () => {
      const socket = new FakeSocketImpl();
      sockets.push(socket);
      return socket.asSocket();
    },
    scheduleTask: (task) => {
      const handle = ++nextHandle;
      tasks.set(handle, task);
      return handle;
    },
    cancelTask: (handle) => {
      tasks.delete(handle);
    },
    requestFrame: (frame) => {
      const handle = ++nextHandle;
      frames.set(handle, frame);
      return handle;
    },
    cancelFrame: (handle) => {
      frames.delete(handle);
    },
    observeResize: (target, onResize) => {
      const observer = new FakeResizeObserverImpl(target, onResize);
      observers.push(observer);
      return () => observer.stop();
    },
    fontsReady: () => fonts,
    measureFit: () => env.fitSize,
    clearRenderCache: () => undefined,

    createSlot: () => {
      const element = new FakeElement('slot', () => {
        hostMoves += 1;
      });
      const target = element.asElement();
      return {
        element: target,
        resize: () => {
          for (const observer of observers) {
            if (!observer.stopped && observer.target === target) observer.fire();
          }
        },
      };
    },
    loseWebglContext: () => {
      for (const listener of [...contextLossListeners.values()]) listener();
    },
    runFrames: () => {
      // Activation reschedules itself, so drain generation by generation with a
      // hard stop rather than looping on a queue that refills.
      for (let generation = 0; generation < 32 && frames.size > 0; generation += 1) {
        const pending = [...frames.entries()];
        frames.clear();
        for (const [, frame] of pending) frame();
      }
    },
    runTasks: () => {
      const pending = [...tasks.values()];
      tasks.clear();
      for (const task of pending) task();
    },
    resizeMessages: () =>
      env.socket.sent
        .map((raw) => JSON.parse(raw) as { type: string; cols: number; rows: number })
        .filter((message) => message.type === 'resize')
        .map((message) => ({ cols: message.cols, rows: message.rows })),
  };

  return env;
}

class FakeElement {
  className = '';
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];

  constructor(
    readonly kind: 'host' | 'slot' | 'parking',
    private readonly onAppend?: () => void,
  ) {}

  get isConnected() {
    return this.kind === 'host' ? this.parentElement !== null : true;
  }

  append(child: FakeElement) {
    if (child.parentElement) child.parentElement.remove(child);
    child.parentElement = this;
    this.children.push(child);
    this.onAppend?.();
  }

  remove(child?: FakeElement) {
    if (!child) {
      this.parentElement?.remove(this);
      return;
    }
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child.parentElement === this) child.parentElement = null;
  }

  addEventListener() {
    return undefined;
  }

  removeEventListener() {
    return undefined;
  }

  asElement(): HTMLElement {
    return this as unknown as HTMLElement;
  }
}

class FakeTerminalImpl {
  readonly options = { disableStdin: false };
  readonly written: string[] = [];
  readonly element = {};
  cols = 80;
  rows = 24;
  openCount = 0;
  disposeCount = 0;
  focusCount = 0;
  blurCount = 0;
  refreshCount = 0;

  open() {
    this.openCount += 1;
  }

  dispose() {
    this.disposeCount += 1;
  }

  onData() {
    return { dispose: () => undefined };
  }

  loadAddon() {
    return undefined;
  }

  write(data: string) {
    this.written.push(data);
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  refresh() {
    this.refreshCount += 1;
  }

  focus() {
    this.focusCount += 1;
  }

  blur() {
    this.blurCount += 1;
  }

  scrollToBottom() {
    return undefined;
  }

  getSelection() {
    return '';
  }

  asTerminal(): Terminal {
    return this as unknown as Terminal;
  }
}

class FakeSocketImpl {
  readyState = SOCKET_CONNECTING;
  readonly sent: string[] = [];
  closeCount = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === SOCKET_CLOSED) return;
    this.readyState = SOCKET_CLOSED;
    this.closeCount += 1;
    this.emit('close', {});
  }

  open() {
    this.readyState = SOCKET_OPEN;
    this.emit('open', {});
  }

  emitMessage(payload: unknown) {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  asSocket(): WebSocket {
    return this as unknown as WebSocket;
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeResizeObserverImpl {
  stopped = false;

  constructor(
    readonly target: Element,
    private readonly onResize: () => void,
  ) {}

  fire() {
    if (!this.stopped) this.onResize();
  }

  stop() {
    this.stopped = true;
  }
}
