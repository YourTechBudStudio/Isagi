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
  type TerminalViewportMemory,
} from '../terminal-cache/index.js';
import { createScopedLifecycle } from '../terminal-cache/scoped-lifecycle.js';
import { createTerminalSlotArbiter } from '../terminal-cache/slot-arbiter.js';
import type { TerminalDiagnosticGauges } from './diagnostics.js';
import type { TerminalPresentationEnvironment } from './environment.js';
import { createTerminalReplayGate, type TerminalReplayGateFailure } from './replay-gate.js';
import {
  captureTerminalViewport,
  createTerminalViewportCausality,
  selectTerminalViewportRestoration,
} from './viewport.js';

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
  readonly readiness:
    | { readonly phase: 'covered' }
    | { readonly phase: 'revealed' }
    | { readonly phase: 'failed'; readonly detail: string };
}

export type TerminalAttachmentEvent =
  | {
      readonly type: 'sealed';
      readonly reason: TerminalSealReason;
      readonly code?: PtyStreamErrorCode;
    }
  | { readonly type: 'interactive'; readonly interactive: boolean }
  | { readonly type: 'resolve_failed'; readonly error: unknown };

export type TerminalAttachmentMilestone =
  | { readonly type: 'parse_barrier_completed'; readonly at: number }
  | { readonly type: 'render_observed'; readonly at: number }
  | { readonly type: 'activation_render_qualified'; readonly at: number }
  | { readonly type: 'reveal_published'; readonly at: number };

export type TerminalAttachmentMilestoneObserver = (event: TerminalAttachmentMilestone) => void;

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
  readonly initialViewport: TerminalViewportMemory | null;
  readonly onViewport: (viewport: TerminalViewportMemory) => void;
  readonly onDiagnostic?:
    | ((event: {
        readonly kind:
          | 'replay_duration'
          | 'reveal_duration'
          | 'webgl_context_loss'
          | 'socket_opened'
          | 'socket_closed';
        readonly value: number;
      }) => void)
    | undefined;
  readonly onGauges?: ((gauges: TerminalDiagnosticGauges) => void) | undefined;
  /** Attachment-local causal observations for finite browser verification. */
  readonly onMilestone?: TerminalAttachmentMilestoneObserver | undefined;
  readonly parkingRoot: HTMLElement;
  readonly onCustomKey?:
    | ((event: KeyboardEvent, sendInput: (data: string) => void) => boolean)
    | undefined;
  /**
   * Every browser capability this controller uses. Production passes
   * `browserTerminalEnvironment`; tests pass fakes and drive the real lifecycle.
   */
  readonly environment: TerminalPresentationEnvironment;
  /**
   * Whether this controller may take DOM focus on its own initiative
   * (`setFocused`, activation completion). Commanded focus via `focus()` is
   * never gated — it only arrives through ownership-aware paths, and it is how
   * an overlay's close path hands focus back. Production injects the shared
   * workbench owner predicate — no focus-owning overlay (palette, drawer) is
   * open — and tests inject fakes. Required so no construction site can
   * silently omit the decision.
   */
  readonly paneFocusAllowed: () => boolean;
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
    // Return-to-latest is a product decision here, not an xterm default: xterm
    // counts mouse reports as user input and scrolls before `onData` fires,
    // which would yank a scrolled-back viewport to the bottom on every click in
    // a mouse-reporting program.
    scrollOnUserInput: false,
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
    readiness: Object.freeze({ phase: 'covered' }),
  });
  const listeners = new Set<() => void>();
  let replayStartedAt: number | null = null;
  let revealStartedAt: number | null = null;
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
  /**
   * The cold viewport this terminal is being rebuilt towards. It stays exactly
   * as the cache remembered it until programmatic restoration lands: replay
   * parsing walks the fresh terminal's own viewport down the buffer, and
   * persisting those observations would erase the very position we are trying
   * to reach — including on a reconstruction that never completes.
   */
  let viewportMemory = input.initialViewport;
  let coldRestorationPending = true;
  const viewportCausality = createTerminalViewportCausality();
  const replayOutputToken = viewportCausality.begin('output');
  let replayOutputScopeOpen = true;
  let renderBarrier: { readonly id: symbol; readonly dispose: () => void } | null = null;
  /** Cold reconstruction, deferred to the activation frame that settles final geometry. */
  let pendingActivationWork: (() => void) | null = null;
  let pendingInsertion = false;
  let insertionResetTask: number | null = null;
  const pendingKeyboardData: string[] = [];

  const current = () => !disposed && input.attachment.isCurrentMutable();
  const observeMilestone = (event: TerminalAttachmentMilestone) => {
    if (!current()) return;
    try {
      input.onMilestone?.(event);
    } catch {
      // Observation is deliberately unable to participate in readiness.
    }
  };
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
    const readiness = concludeReadinessOnSeal(reason, notice);
    replayGate.cancel();
    closeReplayOutputScope();
    cancelRenderBarrier();
    pendingActivationWork = null;
    input.attachment.seal(reason);
    snapshot = Object.freeze({
      ...snapshot,
      phase: 'sealed',
      interactive: false,
      notice,
      sealReason: reason,
      readiness,
    });
    for (const listener of listeners) listener();
    input.onEvent({ type: 'sealed', reason, ...(notice?.code ? { code: notice.code } : {}) });
  };
  const submitInput = (data: string, returnToLatest: boolean) => {
    if (
      !current() ||
      snapshot.sealReason ||
      !snapshot.interactive ||
      socket?.readyState !== SOCKET_OPEN
    )
      return;
    if (returnToLatest) terminal.scrollToBottom();
    transport.sendInput(data);
  };
  const sendKeyboardInput = (data: string) => submitInput(data, true);

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
        input.onDiagnostic?.({ kind: 'webgl_context_loss', value: 1 });
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
      const resizeToken = viewportCausality.begin('resize');
      try {
        env.clearRenderCache(terminal);
        terminal.resize(size.cols, size.rows);
      } finally {
        viewportCausality.end(resizeToken);
      }
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
      const fitted = fit();
      if (!fitted && attempt < ACTIVATION_RETRY_FRAMES) {
        scheduleActivation(attempt + 1);
        return;
      }
      installWebgl();
      // Cold reconstruction belongs exactly here: after the fit that settles
      // final visible geometry and the renderer that will draw it, and before
      // the refresh whose resulting paint is the reveal signal.
      //
      // A host that never measured has no final geometry to restore against, so
      // the work stays queued rather than running against xterm's construction
      // defaults. Retries stop after a bounded number of frames — spinning on an
      // unmeasurable host buys nothing — but the slot's resize observer restarts
      // activation the moment it has a size, which is the only event that can
      // make the fit succeed.
      const activationWork = fitted ? pendingActivationWork : null;
      if (fitted) pendingActivationWork = null;
      activationWork?.();
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
      // Activation retries across frames and installs the renderer first, so
      // this can land arbitrarily late — seconds after an overlay took focus.
      // Self-asserting focus is therefore ownership-gated.
      if (focused && input.paneFocusAllowed()) terminal.focus();
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

  // Typing and pasting deliberately return a scrolled-back viewport to the
  // latest output; a mouse report does not, because the program asked for the
  // click, not for a scroll. xterm's own `scrollOnUserInput` cannot tell the two
  // apart, so it is off (see `createTerminal` above) and the origin is
  // reconstructed here: `onKey` names the bytes a keypress produced, and the
  // capture-phase DOM listeners below name the bytes an insertion produced.
  const inputDisposable = terminal.onData((data) => {
    const keyboardIndex = pendingKeyboardData.indexOf(data);
    const causedByKeyboard = keyboardIndex >= 0;
    if (causedByKeyboard) pendingKeyboardData.splice(keyboardIndex, 1);
    const causedByInsertion = pendingInsertion;
    if (causedByInsertion) {
      pendingInsertion = false;
      if (insertionResetTask !== null) env.cancelTask(insertionResetTask);
      insertionResetTask = null;
    }
    submitInput(data, causedByKeyboard || causedByInsertion);
  });
  const binaryDisposable = terminal.onBinary((data) => submitInput(data, false));
  const keyDisposable = terminal.onKey(({ key }) => pendingKeyboardData.push(key));
  const handleKeyDown = (event: KeyboardEvent) => {
    if (isCopyShortcut(event) && terminal.getSelection()) {
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => undefined);
      return;
    }
    input.onCustomKey?.(event, sendKeyboardInput);
  };
  const handleCopy = (event: ClipboardEvent) => {
    const selection = terminal.getSelection();
    if (!selection) return;
    event.clipboardData?.setData('text/plain', selection);
    event.preventDefault();
  };
  const handleInsertion = () => {
    pendingInsertion = true;
    if (insertionResetTask !== null) env.cancelTask(insertionResetTask);
    insertionResetTask = env.scheduleTask(() => {
      pendingInsertion = false;
      insertionResetTask = null;
    });
  };
  host.addEventListener('keydown', handleKeyDown, true);
  host.addEventListener('copy', handleCopy);
  // Capture, not bubble: xterm's own paste handler calls `stopPropagation()` on
  // the way down, so a bubbling listener never sees a paste at all. `beforeinput`
  // covers the insertions that never produce a key event — IME commits and
  // autocorrect — which xterm turns into input through the textarea instead.
  host.addEventListener('paste', handleInsertion, true);
  host.addEventListener('beforeinput', handleInsertion, true);
  // Scrolls and buffer switches happen *inside* the parse, so whatever scope the
  // write opened is still current and the cause is classified correctly. There
  // is deliberately no `onWriteParsed` capture: it fires after the write
  // callbacks, outside every scope, and would report the session's own output as
  // a user scroll. Each write owns its own post-parse capture instead.
  const scrollDisposable = terminal.onScroll(() => captureViewport());
  const bufferDisposable = terminal.buffer.onBufferChange(() => captureViewport());
  const replayGate = createTerminalReplayGate({ write: writeOutput });
  const disconnectTransport = transport.connect({
    write: (data) => {
      const failure = replayGate.pushOutput(data);
      if (failure) failReplay(failure);
    },
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
          input.onDiagnostic?.({ kind: 'socket_opened', value: 1 });
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
          input.onDiagnostic?.({ kind: 'socket_closed', value: 1 });
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
        replayStartedAt = env.monotonicNow();
        publish({ phase: 'replaying' });
        return;
      case 'replay_end':
        if (replayStartedAt !== null) {
          input.onDiagnostic?.({
            kind: 'replay_duration',
            value: Math.max(0, env.monotonicNow() - replayStartedAt),
          });
          replayStartedAt = null;
        }
        revealStartedAt = env.monotonicNow();
        publish({ phase: 'attached' });
        beginReplayBarrier();
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

  function writeOutput(data: string) {
    if (!current() || snapshot.sealReason) return;
    const token = replayOutputScopeOpen ? null : viewportCausality.begin('output');
    terminal.write(data, () => {
      // The capture is part of the write, not something that follows it. Ending
      // the scope first would classify the session's own output as a user
      // scroll, and a `followLatest: false` terminal would silently become a
      // following one the first time a program cleared the screen.
      try {
        if (current()) captureViewport();
      } finally {
        if (token) viewportCausality.end(token);
      }
    });
  }

  function captureViewport() {
    if (!current()) return;
    input.attachment.updateMeasurement({
      normalCells: terminal.buffer.normal.length * terminal.cols,
      alternateCells: terminal.buffer.alternate.length * terminal.cols,
    });
    input.onGauges?.({
      bufferType: terminal.buffer.active.type === 'alternate' ? 1 : 0,
      normalBufferRows: terminal.buffer.normal.length,
      alternateBufferRows: terminal.buffer.alternate.length,
      terminalColumns: terminal.cols,
      viewportRow: terminal.buffer.active.viewportY,
      baseRow: terminal.buffer.active.baseY,
    });
    // Everything a cold terminal observes before it reaches its remembered
    // viewport is an artefact of the rebuild, not a place the user chose to be.
    if (coldRestorationPending) return;
    const next = captureTerminalViewport({
      buffer: terminal.buffer.active,
      columns: terminal.cols,
      cause: viewportCausality.current(),
      previous: viewportMemory,
    });
    if (!viewportMemoriesEqual(viewportMemory, next)) {
      viewportMemory = next;
      input.onViewport(next);
    }
  }

  /**
   * Move the rebuilt terminal to the viewport the cache remembered, at final
   * geometry, and hand ownership of the memory back to live observation.
   * Idempotent: a reconstruction happens once per attachment.
   */
  function restoreColdViewport() {
    if (!current() || !coldRestorationPending) return;
    const restoreToken = viewportCausality.begin('restore');
    try {
      const restoration = selectTerminalViewportRestoration({
        memory: viewportMemory,
        activeBuffer: terminal.buffer.active,
        columns: terminal.cols,
      });
      if (restoration.type === 'bottom') terminal.scrollToBottom();
      if (restoration.type === 'row') terminal.scrollToLine(restoration.row);
      // Inside the scope: a restoration that lands on the base row looks exactly
      // like a user scrolling to the latest line, and reading it as one would
      // turn a deliberately held viewport into a following one.
      coldRestorationPending = false;
      captureViewport();
    } finally {
      viewportCausality.end(restoreToken);
    }
  }

  /**
   * What a still-covered terminal shows once its stream is gone.
   *
   * Sealing tears down the barriers, so a terminal that has not already revealed
   * can never finish reconstructing: the cover would come off a buffer that was
   * never fully parsed, never restored to the remembered viewport, and never
   * fitted to visible geometry. `replay_end` is no evidence to the contrary — it
   * says the last replay bytes were handed to xterm, not that any of them
   * reached the buffer. So a covered terminal stays covered and offers a
   * recovery instead of a fraction of a session.
   */
  function concludeReadinessOnSeal(
    reason: TerminalSealReason,
    notice: TerminalAttachmentSnapshot['notice'],
  ): TerminalAttachmentSnapshot['readiness'] {
    if (snapshot.readiness.phase !== 'covered') return snapshot.readiness;
    return Object.freeze({
      phase: 'failed' as const,
      detail: notice?.code ? `${reason} · ${notice.code}` : reason,
    });
  }

  function closeReplayOutputScope() {
    if (!replayOutputScopeOpen) return;
    replayOutputScopeOpen = false;
    viewportCausality.end(replayOutputToken);
  }

  function cancelRenderBarrier() {
    renderBarrier?.dispose();
    renderBarrier = null;
  }

  /**
   * Two barriers stand between the last replay byte and a visible terminal, and
   * both have to be passed in order.
   *
   * The parse barrier is an empty write whose callback runs once every byte
   * ahead of it has reached the buffer. The activation barrier is the frame that
   * fits to final visible geometry, installs the renderer, restores the
   * remembered viewport, and asks for a refresh. Only a paint that arrives after
   * all of that is evidence the user would see the rebuilt session rather than a
   * half-parsed one at the wrong size.
   */
  function beginReplayBarrier() {
    if (!current() || !replayGate.beginSettling()) return;
    const barrierId = Symbol('terminal-render-barrier');
    let activationBarrierPassed = false;
    // Subscribe before either barrier: installing a renderer can paint
    // synchronously, and that paint is exactly the one that must not reveal.
    const renderDisposable = terminal.onRender(() => {
      observeMilestone({ type: 'render_observed', at: env.monotonicNow() });
      if (
        !activationBarrierPassed ||
        !current() ||
        renderBarrier?.id !== barrierId ||
        snapshot.sealReason
      )
        return;
      observeMilestone({ type: 'activation_render_qualified', at: env.monotonicNow() });
      cancelRenderBarrier();
      if (!replayGate.reveal()) return;
      if (revealStartedAt !== null) {
        input.onDiagnostic?.({
          kind: 'reveal_duration',
          value: Math.max(0, env.monotonicNow() - revealStartedAt),
        });
        revealStartedAt = null;
      }
      publish({ readiness: Object.freeze({ phase: 'revealed' }) });
      observeMilestone({ type: 'reveal_published', at: env.monotonicNow() });
      if (!current() || snapshot.sealReason) return;
      replayGate.drain();
    });
    renderBarrier = { id: barrierId, dispose: () => renderDisposable.dispose() };
    terminal.write('', () => {
      observeMilestone({ type: 'parse_barrier_completed', at: env.monotonicNow() });
      closeReplayOutputScope();
      if (!current() || renderBarrier?.id !== barrierId || snapshot.sealReason) return;
      pendingActivationWork = () => {
        restoreColdViewport();
        activationBarrierPassed = true;
      };
      scheduleActivation();
    });
  }

  function failReplay(failure: TerminalReplayGateFailure) {
    if (!current() || snapshot.sealReason) return;
    const detail = `${failure.type}: held ${failure.heldBytes} bytes; incoming ${failure.incomingBytes} bytes; limit ${failure.limitBytes} bytes`;
    replayGate.cancel();
    closeReplayOutputScope();
    cancelRenderBarrier();
    pendingActivationWork = null;
    terminal.options.disableStdin = true;
    transport.freeze();
    input.attachment.seal('errored');
    snapshot = Object.freeze({
      ...snapshot,
      phase: 'sealed',
      interactive: false,
      sealReason: 'errored',
      readiness: Object.freeze({ phase: 'failed', detail }),
    });
    for (const listener of listeners) listener();
    input.onEvent({ type: 'sealed', reason: 'errored' });
    socket?.close();
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
      // `focused` is recorded even when the focus call is denied: that retained
      // state is what lets the commanded close-path recovery focus this
      // terminal later, once the owning overlay releases focus.
      focused = next;
      if (next && arbiter.size > 0 && input.paneFocusAllowed()) terminal.focus();
    },
    focus: () => terminal.focus(),
    dispose: () => lifecycle.dispose(),
  };

  lifecycle.addFinalizer(() => {
    disposed = true;
    env.cancelTask(startTimer);
    if (insertionResetTask !== null) env.cancelTask(insertionResetTask);
    claim.abort();
    if (activationFrame !== null) env.cancelFrame(activationFrame);
    stopResizeObserver?.();
    stopResizeObserver = null;
    socket?.close();
    socket = null;
    transport.closeSocket();
    disconnectTransport();
    disposeWebgl();
    replayGate.cancel();
    closeReplayOutputScope();
    cancelRenderBarrier();
    pendingActivationWork = null;
    inputDisposable.dispose();
    binaryDisposable.dispose();
    keyDisposable.dispose();
    scrollDisposable.dispose();
    bufferDisposable.dispose();
    host.removeEventListener('keydown', handleKeyDown, true);
    host.removeEventListener('copy', handleCopy);
    host.removeEventListener('paste', handleInsertion, true);
    host.removeEventListener('beforeinput', handleInsertion, true);
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

function viewportMemoriesEqual(left: TerminalViewportMemory | null, right: TerminalViewportMemory) {
  if (!left || left.buffer !== right.buffer || left.columns !== right.columns) return false;
  if (left.buffer === 'alternate' || right.buffer === 'alternate') return true;
  return (
    left.followLatest === right.followLatest &&
    left.viewportY === right.viewportY &&
    left.baseY === right.baseY &&
    left.rows.length === right.rows.length &&
    left.rows.every(
      (row, index) =>
        row.text === right.rows[index]?.text && row.wrapped === right.rows[index]?.wrapped,
    )
  );
}
