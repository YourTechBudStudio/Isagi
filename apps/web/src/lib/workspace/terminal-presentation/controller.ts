import type { WebglAddon } from '@xterm/addon-webgl';
import { Effect, Schema } from 'effect';

import {
  ptyWebSocketOutputMessageSchema,
  type PtyStreamErrorCode,
  type PtyWebSocketOutputMessage,
} from '@isagi/contracts';

import { ptyCopy, ptySocketErrorCopy } from '../../../copy/index.js';
import { runRuntimeEffect } from '../../runtime/run.js';
import { createPtyStreamTransport } from '../pty-stream/transport.js';
import { formatRuntimeError, formatRuntimeErrorSummary } from '../runtime-data.js';
import { TERMINAL_HOST_CLASS } from '../terminal-appearance.js';
import {
  emptyTerminalBufferMeasurement,
  type TerminalAttachmentHandle,
  type TerminalPresentationResource,
  type TerminalSealReason,
} from '../terminal-cache/index.js';
import { createScopedLifecycle } from '../terminal-cache/scoped-lifecycle.js';
import { createTerminalSlotArbiter } from '../terminal-cache/slot-arbiter.js';
import type { TerminalPresentationEnvironment } from './environment.js';

const SOCKET_OPEN = 1;
const ACTIVATION_RETRY_FRAMES = 12;

export interface TerminalAttachmentSnapshot {
  readonly phase: 'connecting' | 'attached' | 'replaying' | 'sealed';
  readonly notice: {
    readonly kind: 'protocol' | 'transport';
    readonly code?: PtyStreamErrorCode | undefined;
    readonly message?: string | undefined;
  } | null;
  readonly exit: { readonly exitCode: number | null; readonly signal: string | null };
  readonly interactive: boolean;
  readonly rendererWarning: string | null;
  readonly sealReason: TerminalSealReason | null;
}

export type TerminalAttachmentEvent =
  | {
      readonly type: 'sealed';
      readonly reason: TerminalSealReason;
      readonly code?: PtyStreamErrorCode;
    }
  | { readonly type: 'interactive'; readonly interactive: boolean }
  | { readonly type: 'resolve_failed'; readonly error: unknown };

export interface TerminalPresentationController extends TerminalPresentationResource {
  readonly host: HTMLDivElement;
  readonly getSnapshot: () => TerminalAttachmentSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly registerSlot: (destination: HTMLElement) => () => void;
  readonly setFocused: (focused: boolean) => void;
  readonly focus: () => void;
}

export interface CreateTerminalPresentationControllerInput {
  readonly attachment: TerminalAttachmentHandle<TerminalPresentationController>;
  readonly scrollbackLines: number;
  readonly initiallyInteractive: boolean;
  readonly resolveUrl: () => Effect.Effect<string, Error>;
  readonly onEvent: (event: TerminalAttachmentEvent) => void;
  readonly parkingRoot: HTMLElement;
  readonly onCustomKey?:
    | ((event: KeyboardEvent, sendInput: (data: string) => void) => boolean)
    | undefined;
  /**
   * Every browser capability this controller uses. Production passes
   * `browserTerminalEnvironment`; tests pass fakes and drive the real lifecycle.
   */
  readonly environment: TerminalPresentationEnvironment;
}

export function createTerminalPresentationController(
  input: CreateTerminalPresentationControllerInput,
): TerminalPresentationController {
  const env = input.environment;
  const lifecycle = createScopedLifecycle();
  const host = env.createHost();
  // The host carries the terminal dress itself rather than borrowing it from
  // whichever slot currently holds it: it outlives every slot and spends time
  // parked outside the styled tree entirely.
  host.className = `${TERMINAL_HOST_CLASS} h-full w-full`;
  const terminal = env.createTerminal({
    disableStdin: !input.initiallyInteractive,
    scrollback: input.scrollbackLines,
  });
  lifecycle.addFinalizer(() => terminal.dispose());
  try {
    terminal.open(host);
  } catch (error) {
    lifecycle.dispose();
    throw error;
  }

  let snapshot: TerminalAttachmentSnapshot = Object.freeze({
    phase: 'connecting',
    notice: null,
    exit: Object.freeze({ exitCode: null, signal: null }),
    interactive: input.initiallyInteractive,
    rendererWarning: null,
    sealReason: null,
  });
  const listeners = new Set<() => void>();
  const transport = createPtyStreamTransport();
  transport.beginAttach(input.initiallyInteractive);
  let disposed = false;
  let socket: WebSocket | null = null;
  let webgl: { readonly id: symbol; readonly addon: WebglAddon } | null = null;
  let stopResizeObserver: (() => void) | null = null;
  let activationFrame: number | null = null;
  let webglLostThisActivation = false;
  let focused = false;
  let lastGeometry: { readonly cols: number; readonly rows: number } | null = null;

  const current = () => !disposed && input.attachment.isCurrentMutable();
  const publish = (patch: Partial<TerminalAttachmentSnapshot>) => {
    if (!current()) return;
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of listeners) listener();
  };
  const setInteractive = (interactive: boolean) => {
    transport.setInteractive(interactive);
    terminal.options.disableStdin = !interactive;
    publish({ interactive });
    input.onEvent({ type: 'interactive', interactive });
  };
  const seal = (reason: TerminalSealReason, notice = snapshot.notice) => {
    if (snapshot.sealReason !== null || !current()) return;
    terminal.options.disableStdin = true;
    transport.freeze();
    input.attachment.seal(reason);
    snapshot = Object.freeze({
      ...snapshot,
      phase: 'sealed',
      interactive: false,
      notice,
      sealReason: reason,
    });
    for (const listener of listeners) listener();
    input.onEvent({ type: 'sealed', reason, ...(notice?.code ? { code: notice.code } : {}) });
  };
  const sendInput = (data: string) => {
    if (
      !current() ||
      snapshot.sealReason ||
      !snapshot.interactive ||
      socket?.readyState !== SOCKET_OPEN
    )
      return;
    terminal.scrollToBottom();
    transport.sendInput(data);
  };

  const disposeWebgl = () => {
    const owned = webgl;
    webgl = null;
    owned?.addon.dispose();
  };
  const installWebgl = () => {
    // A context-lost terminal stays on the DOM renderer for the rest of this
    // visible activation. Reinstalling on the next resize would churn addons
    // against a driver that just took the context away, and would silently
    // clear a renderer warning that is still true.
    if (!current() || webgl || webglLostThisActivation) return;
    try {
      const addon = env.createWebglAddon();
      const owned = { id: Symbol('terminal-webgl'), addon };
      webgl = owned;
      addon.onContextLoss(() => {
        if (!current() || webgl?.id !== owned.id) return;
        webglLostThisActivation = true;
        disposeWebgl();
        publish({ rendererWarning: ptyCopy.renderer.webglFallback });
      });
      terminal.loadAddon(addon);
      publish({ rendererWarning: null });
    } catch {
      publish({ rendererWarning: ptyCopy.renderer.webglUnavailable });
    }
  };

  const fit = () => {
    if (!current() || !host.isConnected) return false;
    const size = env.measureFit(terminal, host);
    if (!size) return false;
    if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
      env.clearRenderCache(terminal);
      terminal.resize(size.cols, size.rows);
    }
    lastGeometry = size;
    transport.sendResize(size.cols, size.rows);
    return true;
  };
  const scheduleActivation = (attempt = 0) => {
    if (arbiter.size === 0) return;
    if (activationFrame !== null) env.cancelFrame(activationFrame);
    activationFrame = env.requestFrame(() => {
      activationFrame = null;
      if (!current() || !host.isConnected || arbiter.size === 0) return;
      if (!fit() && attempt < ACTIVATION_RETRY_FRAMES) {
        scheduleActivation(attempt + 1);
        return;
      }
      installWebgl();
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      if (focused) terminal.focus();
    });
  };
  const park = () => {
    if (disposed || arbiter.size > 0) return;
    terminal.blur();
    stopResizeObserver?.();
    stopResizeObserver = null;
    if (activationFrame !== null) env.cancelFrame(activationFrame);
    activationFrame = null;
    disposeWebgl();
    // A park/revisit is a real transition, not a resize: the next activation
    // gets one fresh attempt at the GPU renderer.
    webglLostThisActivation = false;
    input.parkingRoot.append(host);
  };
  const arbiter = createTerminalSlotArbiter(() => queueMicrotask(park));

  const inputDisposable = terminal.onData(sendInput);
  const handleKeyDown = (event: KeyboardEvent) => {
    if (isCopyShortcut(event) && terminal.getSelection()) {
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => undefined);
      return;
    }
    input.onCustomKey?.(event, sendInput);
  };
  const handleCopy = (event: ClipboardEvent) => {
    const selection = terminal.getSelection();
    if (!selection) return;
    event.clipboardData?.setData('text/plain', selection);
    event.preventDefault();
  };
  host.addEventListener('keydown', handleKeyDown, true);
  host.addEventListener('copy', handleCopy);
  const disconnectTransport = transport.connect({
    write: (data) => terminal.write(data),
    setInteractive: (interactive) => {
      terminal.options.disableStdin = !interactive;
    },
    onConnected: scheduleActivation,
  });

  // The claim is operational work that outlives this call: it launches or
  // reclaims a runtime process and mints an attach token. Disposal must be able
  // to interrupt it, not merely ignore its result, so it runs under a signal the
  // lifecycle owns.
  const claim = new AbortController();
  const startTimer = env.scheduleTask(() => {
    if (!current()) return;
    void runRuntimeEffect(input.resolveUrl(), { signal: claim.signal }).then(
      (url) => {
        if (!current()) return;
        const opened = env.openSocket(url);
        socket = opened;
        transport.bindSocket(opened);
        opened.addEventListener('open', () => {
          if (!current() || socket !== opened) return;
          publish({ phase: 'attached' });
          transport.handleOpen();
          if (lastGeometry) transport.sendResize(lastGeometry.cols, lastGeometry.rows);
        });
        opened.addEventListener('message', (event) => {
          if (!current() || socket !== opened || snapshot.sealReason) return;
          const message = decodeMessage(event.data);
          if (!message) {
            seal('errored', {
              kind: 'protocol',
              message: ptySocketErrorCopy.byReason('invalid_message'),
            });
            opened.close();
            return;
          }
          handleMessage(message);
        });
        opened.addEventListener('error', () => {
          if (!current() || socket !== opened) return;
          seal('errored', {
            kind: 'transport',
            message: ptySocketErrorCopy.byReason('socket_unavailable'),
          });
          opened.close();
        });
        opened.addEventListener('close', () => {
          if (!current() || socket !== opened || snapshot.sealReason) return;
          seal('disconnected');
        });
      },
      (error: unknown) => {
        if (!current()) return;
        // The runtime's own message never reaches the user: the notice bar gets
        // web-owned copy, and the terminal line adds the diagnostic code so a
        // failure is still quotable in a bug report.
        terminal.write(ptySocketErrorCopy.connectFailed(formatRuntimeError(error)));
        input.onEvent({ type: 'resolve_failed', error });
        seal('errored', { kind: 'transport', message: formatRuntimeErrorSummary(error) });
      },
    );
  });

  function handleMessage(message: PtyWebSocketOutputMessage) {
    switch (message.type) {
      case 'output':
        transport.pushOutput(message.data);
        return;
      case 'replay_start':
        publish({ phase: 'replaying' });
        return;
      case 'replay_end':
        publish({ phase: 'attached' });
        return;
      case 'exit':
        publish({ exit: Object.freeze({ exitCode: message.exitCode, signal: message.signal }) });
        seal('exited');
        socket?.close();
        return;
      case 'error': {
        const reason =
          message.code === 'session_attachment_moved'
            ? 'moved'
            : message.code === 'stream_superseded'
              ? 'superseded'
              : 'errored';
        seal(reason, { kind: 'protocol', code: message.code, message: message.message });
        socket?.close();
        return;
      }
      case 'session':
        setInteractive(message.status === 'running');
        if (message.status === 'exited') {
          publish({
            exit: Object.freeze({
              exitCode: message.exitCode ?? null,
              signal: message.signal ?? null,
            }),
          });
          seal('exited');
          socket?.close();
        }
    }
  }

  const controller: TerminalPresentationController = {
    host,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    registerSlot(destination) {
      const registration = arbiter.register({
        appendHost() {
          if (disposed) return;
          destination.append(host);
          stopResizeObserver?.();
          stopResizeObserver = env.observeResize(destination, () => scheduleActivation());
          // No font barrier here: preparation already waited for terminal font
          // readiness before this terminal was constructed and measured.
          scheduleActivation();
        },
      });
      return registration.release;
    },
    setFocused(next) {
      focused = next;
      if (next && arbiter.size > 0) terminal.focus();
    },
    focus: () => terminal.focus(),
    dispose: () => lifecycle.dispose(),
  };

  lifecycle.addFinalizer(() => {
    disposed = true;
    env.cancelTask(startTimer);
    claim.abort();
    if (activationFrame !== null) env.cancelFrame(activationFrame);
    stopResizeObserver?.();
    stopResizeObserver = null;
    socket?.close();
    socket = null;
    transport.closeSocket();
    disconnectTransport();
    disposeWebgl();
    inputDisposable.dispose();
    host.removeEventListener('keydown', handleKeyDown, true);
    host.removeEventListener('copy', handleCopy);
    listeners.clear();
    host.remove();
  });

  const installed = input.attachment.installResource(controller, emptyTerminalBufferMeasurement);
  if (installed !== 'applied') {
    controller.dispose();
    throw new Error(`Terminal presentation installation failed: ${installed}`);
  }
  input.attachment.markReady();
  return controller;
}

function decodeMessage(data: unknown): PtyWebSocketOutputMessage | null {
  try {
    return Schema.decodeUnknownSync(ptyWebSocketOutputMessageSchema)(JSON.parse(String(data)));
  } catch {
    return null;
  }
}

function isCopyShortcut(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'c') return false;
  return /mac/i.test(navigator.platform)
    ? event.metaKey && !event.altKey
    : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
}
