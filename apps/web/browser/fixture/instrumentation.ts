import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

import type { TerminalAttachmentMilestone } from '../../src/lib/workspace/terminal-presentation/controller.js';
import {
  browserTerminalEnvironment,
  type TerminalPresentationEnvironment,
} from '../../src/lib/workspace/terminal-presentation/environment.js';
import {
  generateAnsiFixture,
  recipeStages,
  type AnsiRecipe,
  type AnsiRecipeStages,
} from './ansi.js';

export interface FixtureCounters {
  readonly claimAttempts: number;
  readonly terminalsCreated: number;
  readonly terminalsDisposed: number;
  readonly terminalDisposals: readonly number[];
  readonly socketsCreated: number;
  readonly socketsOpened: number;
  readonly socketsClosed: number;
  readonly webglCreated: number;
  readonly webglDisposed: number;
  readonly tasksActive: number;
  readonly framesRequested: number;
  readonly framesActive: number;
  readonly resizeObserversActive: number;
  readonly input: readonly string[];
  readonly milestones: readonly TerminalAttachmentMilestone[];
  readonly replayChunksSubmitted: number;
  readonly lastReplayChunkAt: number | null;
  readonly replayEndAt: number | null;
  readonly relocation: FixtureRelocationProbe;
}

/**
 * Warm acceptance is "interactive within one animation frame after the visible host is
 * measurable", so both ends of that boundary are observed as events rather than inferred from
 * how many frames the controller happened to request.
 */
export interface FixtureRelocationProbe {
  /**
   * Frame ordinal, counted from the probe's start, on which the *host* was first measurable in
   * the destination — the destination has a box and the host lives inside it. The destination's
   * own box is not enough: it can exist a frame before the host is appended, and the controller
   * cannot fit a host that is not there yet.
   */
  readonly measurableFrame: number | null;
  /** Frame ordinal on which the relocated terminal first painted inside that destination. */
  readonly interactiveFrame: number | null;
  readonly measurableAt: number | null;
  readonly interactiveAt: number | null;
  /** Frame ordinals on which controller-owned animation frames ran, for attributing the gap. */
  readonly activationFrames: readonly number[];
  /** Every xterm paint ordinal seen while probing, for attributing the gap. */
  readonly renderFrames: readonly number[];
}

export interface FixtureTerminalState {
  readonly index: number;
  readonly cols: number;
  readonly rows: number;
  readonly buffer: 'normal' | 'alternate';
  readonly viewportY: number;
  readonly baseY: number;
  readonly normalRows: number;
  readonly alternateRows: number;
  readonly selection: string;
  readonly visibleText: string;
  readonly tailText: string;
  readonly estimatedBytes: number;
}

export function createInstrumentedEnvironment(input: {
  readonly renderer: 'dom' | 'webgl';
  readonly recipe: AnsiRecipe;
  readonly bytes: number;
  readonly automatic: boolean;
}) {
  let counters: FixtureCounters = initialCounters();
  const listeners = new Set<() => void>();
  const sockets: FixtureSocket[] = [];
  const terminals: Terminal[] = [];
  const activeTasks = new Set<number>();
  const activeFrames = new Set<number>();
  let stopRelocationProbe: (() => void) | null = null;
  /** Set while a relocation probe is running, so controller frames can be attributed to it. */
  let probe: {
    ordinal: number;
    running: boolean;
    activationFrames: number[];
    renderFrames: number[];
  } | null = null;
  const publish = (patch: Partial<FixtureCounters>) => {
    counters = Object.freeze({ ...counters, ...patch });
    for (const listener of listeners) listener();
  };
  const environment: TerminalPresentationEnvironment = {
    ...browserTerminalEnvironment,
    createTerminal(options) {
      const terminal = browserTerminalEnvironment.createTerminal(options);
      terminals.push(terminal);
      const terminalIndex = terminals.length - 1;
      publish({ terminalsCreated: counters.terminalsCreated + 1 });
      observeDisposal(terminal, () =>
        publish({
          terminalsDisposed: counters.terminalsDisposed + 1,
          terminalDisposals: [...counters.terminalDisposals, terminalIndex],
        }),
      );
      return terminal;
    },
    createWebglAddon() {
      if (input.renderer === 'dom') throw new Error('fixture-forced-dom-renderer');
      const addon = browserTerminalEnvironment.createWebglAddon();
      publish({ webglCreated: counters.webglCreated + 1 });
      observeDisposal(addon, () => publish({ webglDisposed: counters.webglDisposed + 1 }));
      return addon;
    },
    openSocket() {
      const socket = new FixtureSocket({
        onOpen: () => publish({ socketsOpened: counters.socketsOpened + 1 }),
        onClose: () => publish({ socketsClosed: counters.socketsClosed + 1 }),
        onInput: (data) => publish({ input: [...counters.input, data] }),
      });
      sockets.push(socket);
      publish({ socketsCreated: counters.socketsCreated + 1 });
      if (input.automatic) {
        queueMicrotask(() => {
          socket.open();
          sendReplay(socket, input.recipe, input.bytes);
        });
      }
      return socket as unknown as WebSocket;
    },
    // Outstanding work is tracked per handle, not as a bare count. Callers legitimately cancel
    // handles that have already fired — the controller always cancels its start timer during
    // disposal — and a count-only ledger would let that stale cancel consume some *other*
    // pending task's entry, so teardown could report zero with work still scheduled.
    scheduleTask(task) {
      let handle = -1;
      handle = browserTerminalEnvironment.scheduleTask(() => {
        if (activeTasks.delete(handle)) publish({ tasksActive: activeTasks.size });
        task();
      });
      activeTasks.add(handle);
      publish({ tasksActive: activeTasks.size });
      return handle;
    },
    cancelTask(handle) {
      browserTerminalEnvironment.cancelTask(handle);
      if (activeTasks.delete(handle)) publish({ tasksActive: activeTasks.size });
    },
    requestFrame(frame) {
      let handle = -1;
      handle = browserTerminalEnvironment.requestFrame(() => {
        if (activeFrames.delete(handle)) publish({ framesActive: activeFrames.size });
        if (probe?.running) probe.activationFrames.push(probe.ordinal);
        frame();
      });
      activeFrames.add(handle);
      publish({
        framesRequested: counters.framesRequested + 1,
        framesActive: activeFrames.size,
      });
      return handle;
    },
    cancelFrame(handle) {
      browserTerminalEnvironment.cancelFrame(handle);
      if (activeFrames.delete(handle)) publish({ framesActive: activeFrames.size });
    },
    observeResize(target, onResize) {
      publish({ resizeObserversActive: counters.resizeObserversActive + 1 });
      const stop = browserTerminalEnvironment.observeResize(target, onResize);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        stop();
        publish({ resizeObserversActive: counters.resizeObserversActive - 1 });
      };
    },
  };

  const currentSocket = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error('fixture socket has not been created');
    return socket;
  };
  const sendReplay = (socket: FixtureSocket, recipe: AnsiRecipe, bytes: number) => {
    socket.message({ type: 'replay_start', bytes });
    for (const chunk of generateAnsiFixture(recipe, bytes)) {
      socket.message({ type: 'output', data: chunk, replay: true });
      publish({
        replayChunksSubmitted: counters.replayChunksSubmitted + 1,
        lastReplayChunkAt: performance.now(),
      });
    }
    socket.message({ type: 'replay_end' });
    publish({ replayEndAt: performance.now() });
    socket.message({ type: 'session', status: 'running' });
  };

  return {
    environment,
    claimAttempt() {
      publish({ claimAttempts: counters.claimAttempts + 1 });
    },
    observeMilestone(event: TerminalAttachmentMilestone) {
      publish({ milestones: [...counters.milestones, event] });
    },
    openSocket: () => currentSocket().open(),
    startReplay: () => currentSocket().message({ type: 'replay_start', bytes: input.bytes }),
    sendReplayChunks() {
      for (const chunk of generateAnsiFixture(input.recipe, input.bytes)) {
        currentSocket().message({ type: 'output', data: chunk, replay: true });
        publish({
          replayChunksSubmitted: counters.replayChunksSubmitted + 1,
          lastReplayChunkAt: performance.now(),
        });
      }
    },
    endReplay() {
      currentSocket().message({ type: 'replay_end' });
      publish({ replayEndAt: performance.now() });
      currentSocket().message({ type: 'session', status: 'running' });
    },
    sendLive(data: string) {
      currentSocket().message({ type: 'output', data });
    },
    sendAnsi(data: string) {
      currentSocket().message({ type: 'output', data });
    },
    sendRecipeStage(stage: keyof AnsiRecipeStages) {
      currentSocket().message({ type: 'output', data: recipeStages(input.recipe)[stage] });
    },
    startRelocationProbe(destinationSelector: string) {
      stopRelocationProbe?.();
      publish({ relocation: idleRelocationProbe() });
      const state = {
        ordinal: 0,
        running: true,
        activationFrames: [] as number[],
        renderFrames: [] as number[],
      };
      probe = state;
      let measurableFrame: number | null = null;
      let interactiveSeen = false;
      const destination = () => document.querySelector(destinationSelector);
      const renderDisposables = terminals.map((terminal) =>
        // The relocated terminal painting *inside* the destination is the interactivity event:
        // it can only happen after the activation frame fitted the host to the new box.
        terminal.onRender(() => {
          if (!state.running) return;
          state.renderFrames.push(state.ordinal);
          if (interactiveSeen || measurableFrame === null) return;
          const node = destination();
          if (!node || !terminal.element || !node.contains(terminal.element)) return;
          interactiveSeen = true;
          publish({
            relocation: {
              ...counters.relocation,
              interactiveFrame: state.ordinal,
              interactiveAt: performance.now(),
              activationFrames: [...state.activationFrames],
              renderFrames: [...state.renderFrames],
            },
          });
        }),
      );
      const tick = () => {
        if (!state.running) return;
        state.ordinal += 1;
        if (measurableFrame === null) {
          const node = destination();
          const box = node?.getBoundingClientRect();
          // Measurability belongs to the *host*, not merely to the slot that will hold it: a
          // destination with a box but no host in it is nothing the controller can fit.
          const hosted = node?.querySelector('.xterm');
          if (hosted && box && box.width > 0 && box.height > 0) {
            measurableFrame = state.ordinal;
            publish({
              relocation: {
                ...counters.relocation,
                measurableFrame: state.ordinal,
                measurableAt: performance.now(),
              },
            });
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      stopRelocationProbe = () => {
        state.running = false;
        if (probe === state) probe = null;
        for (const disposable of renderDisposables) disposable.dispose();
        stopRelocationProbe = null;
      };
    },
    stopRelocationProbe() {
      stopRelocationProbe?.();
    },
    loseWebglContext() {
      const canvases = document.querySelectorAll('canvas');
      for (const canvas of canvases) {
        const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        const extension = context?.getExtension('WEBGL_lose_context');
        if (extension) {
          extension.loseContext();
          return true;
        }
      }
      return false;
    },
    closeSockets() {
      for (const socket of sockets) socket.close();
    },
    inspectTerminals(): FixtureTerminalState[] {
      return terminals.flatMap((terminal, index) => {
        if (terminal.element?.dataset.fixtureDisposed) return [];
        const buffer = terminal.buffer.active;
        const lines: string[] = [];
        for (let row = buffer.viewportY; row < buffer.viewportY + terminal.rows; row += 1) {
          lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
        }
        const tail: string[] = [];
        for (let row = Math.max(0, buffer.length - 50); row < buffer.length; row += 1) {
          tail.push(buffer.getLine(row)?.translateToString(true) ?? '');
        }
        return [
          {
            index,
            cols: terminal.cols,
            rows: terminal.rows,
            buffer: buffer.type === 'alternate' ? 'alternate' : 'normal',
            viewportY: buffer.viewportY,
            baseY: buffer.baseY,
            normalRows: terminal.buffer.normal.length,
            alternateRows: terminal.buffer.alternate.length,
            selection: terminal.getSelection(),
            visibleText: lines.join('\n'),
            tailText: tail.join('\n'),
            estimatedBytes:
              1024 * 1024 +
              48 *
                terminal.cols *
                (terminal.buffer.normal.length + terminal.buffer.alternate.length),
          },
        ];
      });
    },
    getSnapshot: () => counters,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function initialCounters(): FixtureCounters {
  return Object.freeze({
    claimAttempts: 0,
    terminalsCreated: 0,
    terminalsDisposed: 0,
    terminalDisposals: Object.freeze([]),
    socketsCreated: 0,
    socketsOpened: 0,
    socketsClosed: 0,
    webglCreated: 0,
    webglDisposed: 0,
    tasksActive: 0,
    framesRequested: 0,
    framesActive: 0,
    resizeObserversActive: 0,
    input: Object.freeze([]),
    milestones: Object.freeze([]),
    replayChunksSubmitted: 0,
    lastReplayChunkAt: null,
    replayEndAt: null,
    relocation: idleRelocationProbe(),
  });
}

function idleRelocationProbe(): FixtureRelocationProbe {
  return Object.freeze({
    measurableFrame: null,
    interactiveFrame: null,
    measurableAt: null,
    interactiveAt: null,
    activationFrames: Object.freeze([]),
    renderFrames: Object.freeze([]),
  });
}

function observeDisposal(resource: Terminal | WebglAddon, onDispose: () => void) {
  const original = resource.dispose.bind(resource);
  let disposed = false;
  resource.dispose = () => {
    if (!disposed) {
      disposed = true;
      if ('element' in resource && resource.element) resource.element.dataset.fixtureDisposed = '';
      onDispose();
    }
    original();
  };
}

class FixtureSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = 'blob';
  private closed = false;

  constructor(
    private readonly input: {
      readonly onOpen: () => void;
      readonly onClose: () => void;
      readonly onInput: (data: string) => void;
    },
  ) {
    super();
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.input.onInput(String(data));
  }

  open() {
    if (this.closed || this.readyState === FixtureSocket.OPEN) return;
    this.readyState = FixtureSocket.OPEN;
    this.input.onOpen();
    this.dispatchEvent(new Event('open'));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FixtureSocket.CLOSED;
    this.input.onClose();
    this.dispatchEvent(new CloseEvent('close'));
  }

  message(value: unknown) {
    if (!this.closed)
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
}
