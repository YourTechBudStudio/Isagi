import type { WebglAddon } from '@xterm/addon-webgl';
import type { IBuffer, IBufferNamespace, Terminal } from '@xterm/xterm';

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
  /**
   * Whether `measureFit` can measure at all. A slot with no laid-out size — a
   * pane behind a collapsed split, a host mid-mount — reports nothing, and
   * geometry-dependent work has to wait rather than assume defaults.
   */
  measurable: boolean;
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
  readonly options: { disableStdin: boolean; scrollOnUserInput: boolean };
  readonly written: string[];
  readonly cols: number;
  readonly rows: number;
  readonly openCount: number;
  readonly disposeCount: number;
  readonly focusCount: number;
  readonly blurCount: number;
  readonly refreshCount: number;
  readonly scrollToBottomCount: number;
  readonly scrollLines: readonly number[];
  readonly viewportY: number;
  /**
   * Emit bytes as xterm would. `wasUserInput` is xterm's own classification —
   * true for keys, pastes, and mouse reports alike — and, when
   * `scrollOnUserInput` is on, xterm scrolls to the bottom *before* `onData`
   * fires. Modelling that ordering is the only way a test can tell an owned
   * return-to-latest policy from xterm's indiscriminate one.
   */
  readonly emitData: (data: string, wasUserInput?: boolean) => void;
  readonly emitBinary: (data: string) => void;
  readonly emitKey: (key: string) => void;
  readonly emitRender: () => void;
  /** Parse everything written so far, then paint — as xterm's parser schedules. */
  readonly flushWrites: () => void;
  /** Replace the normal buffer's contents, as replay output would. */
  readonly setBufferLines: (lines: readonly string[], viewportY?: number) => void;
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
    measurable: true,
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
    monotonicNow: () => 0,
    createTerminal: (options) => {
      if (env.terminalCreationFailure) throw new Error(env.terminalCreationFailure);
      const terminal = new FakeTerminalImpl(options.scrollOnUserInput);
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
    measureFit: () => (env.measurable ? env.fitSize : null),
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
  readonly options: { disableStdin: boolean; scrollOnUserInput: boolean };
  readonly written: string[] = [];
  readonly element = {};
  cols = 80;
  rows = 24;
  openCount = 0;
  disposeCount = 0;
  focusCount = 0;
  blurCount = 0;
  refreshCount = 0;
  scrollToBottomCount = 0;
  readonly scrollLines: number[] = [];
  private readonly events = new Map<string, Set<(value: never) => void>>();
  private readonly writeCallbacks: Array<() => void> = [];
  private readonly activeBuffer = new FakeBuffer();
  readonly buffer = {
    active: this.activeBuffer.asBuffer(),
    normal: this.activeBuffer.asBuffer(),
    alternate: new FakeBuffer('alternate').asBuffer(),
    onBufferChange: (listener: (buffer: IBuffer) => void) =>
      this.listen('buffer', listener as (value: never) => void),
  } as IBufferNamespace;

  constructor(scrollOnUserInput: boolean) {
    this.options = { disableStdin: false, scrollOnUserInput };
  }

  get viewportY() {
    return this.activeBuffer.viewportY;
  }

  open() {
    this.openCount += 1;
  }

  dispose() {
    this.disposeCount += 1;
  }

  onData(listener: (data: string) => void) {
    return this.listen('data', listener as (value: never) => void);
  }

  onBinary(listener: (data: string) => void) {
    return this.listen('binary', listener as (value: never) => void);
  }

  onKey(listener: (event: { key: string; domEvent: KeyboardEvent }) => void) {
    return this.listen('key', listener as (value: never) => void);
  }

  onRender(listener: (event: { start: number; end: number }) => void) {
    return this.listen('render', listener as (value: never) => void);
  }

  onScroll(listener: (viewportY: number) => void) {
    return this.listen('scroll', listener as (value: never) => void);
  }

  onWriteParsed(listener: () => void) {
    return this.listen('parsed', listener as (value: never) => void);
  }

  loadAddon() {
    return undefined;
  }

  write(data: string, callback?: () => void) {
    this.written.push(data);
    if (callback) this.writeCallbacks.push(callback);
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
    this.scrollToBottomCount += 1;
    this.activeBuffer.viewportY = this.activeBuffer.baseY;
    this.emit('scroll', this.activeBuffer.baseY as never);
  }

  scrollToLine(line: number) {
    this.scrollLines.push(line);
    this.activeBuffer.viewportY = line;
    this.emit('scroll', line as never);
  }

  getSelection() {
    return '';
  }

  emitData(data: string, wasUserInput = false) {
    if (wasUserInput && this.options.scrollOnUserInput) this.scrollToBottom();
    this.emit('data', data as never);
  }

  setBufferLines(lines: readonly string[], viewportY = 0) {
    this.activeBuffer.lines = [...lines];
    this.activeBuffer.baseY = Math.max(0, this.activeBuffer.length - this.rows);
    this.activeBuffer.viewportY = viewportY;
  }

  emitBinary(data: string) {
    this.emit('binary', data as never);
  }

  emitKey(key: string) {
    this.emit('key', { key, domEvent: {} as KeyboardEvent } as never);
  }

  emitRender() {
    this.emit('render', { start: 0, end: this.rows - 1 } as never);
  }

  flushWrites() {
    const callbacks = this.writeCallbacks.splice(0);
    for (const callback of callbacks) callback();
    this.emit('parsed', undefined as never);
    // Parsing dirties rows, and xterm's renderer paints them. A reveal barrier
    // that only ever saw hand-driven paints would never meet the one replay
    // itself produces, which is the paint most likely to arrive too early.
    this.emitRender();
  }

  asTerminal(): Terminal {
    return this as unknown as Terminal;
  }

  private listen(type: string, listener: (value: never) => void) {
    const listeners = this.events.get(type) ?? new Set();
    listeners.add(listener);
    this.events.set(type, listeners);
    return { dispose: () => listeners.delete(listener) };
  }

  private emit(type: string, value: never) {
    for (const listener of this.events.get(type) ?? []) listener(value);
  }
}

class FakeBuffer {
  readonly cursorX = 0;
  readonly cursorY = 0;
  viewportY = 0;
  baseY = 0;
  lines: string[] = [];

  constructor(readonly type: 'normal' | 'alternate' = 'normal') {}

  get length() {
    return Math.max(24, this.lines.length);
  }

  getLine(row: number) {
    if (row < 0 || row >= this.length) return undefined;
    const text = this.lines[row] ?? '';
    return {
      isWrapped: false,
      length: text.length,
      getCell: () => undefined,
      translateToString: () => text,
    };
  }

  asBuffer(): IBuffer {
    return this as unknown as IBuffer;
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
