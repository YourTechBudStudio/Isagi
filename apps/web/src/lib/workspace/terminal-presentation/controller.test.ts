import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Effect } from 'effect';

import { terminalSettingsDefaults } from '@isagi/contracts';

import { ptyCopy, runtimeErrorCopy } from '../../../copy/index.js';
import { RuntimeApiError } from '../../runtime/client.js';
import {
  createTerminalPresentationCache,
  emptyTerminalBufferMeasurement,
  type TerminalAttachmentHandle,
  type TerminalPlacement,
  type TerminalPresentationCache,
  type TerminalViewportMemory,
} from '../terminal-cache/index.js';
import {
  createTerminalPresentationController,
  type TerminalPresentationController,
} from './controller.js';
import { createFakeTerminalEnvironment, type FakeTerminalEnvironment } from './test-environment.js';

const PLACEMENT: TerminalPlacement = { worktreeId: 1, surfaceId: 2, paneId: 3 };
const IDENTITY = { kind: 'agent_session', sessionId: 7 } as const;

describe('terminal presentation controller', () => {
  it('reveals only after the parse and render barriers, then drains held live output once', async () => {
    const harness = await startController();
    openSlot(harness);
    harness.env.socket.emitMessage({ type: 'replay_start', bytes: 12 });
    harness.env.socket.emitMessage({ type: 'output', data: '\u001b[?2026hreplay' });
    harness.env.socket.emitMessage({ type: 'replay_end' });
    harness.env.socket.emitMessage({ type: 'output', data: ' live' });

    assert.equal(harness.controller.getSnapshot().readiness.phase, 'covered');
    assert.deepEqual(harness.env.terminal.written, ['\u001b[?2026hreplay', '']);
    harness.env.terminal.emitRender();
    assert.equal(
      harness.controller.getSnapshot().readiness.phase,
      'covered',
      'a render before the parse callback cannot reveal',
    );

    // Parsing paints. That paint lands before the activation frame has fitted,
    // installed a renderer, restored, or asked for its refresh.
    harness.env.terminal.flushWrites();
    assert.equal(
      harness.controller.getSnapshot().readiness.phase,
      'covered',
      'a paint driven by replay parsing cannot reveal before activation',
    );

    harness.env.runFrames();
    assert.equal(
      harness.controller.getSnapshot().readiness.phase,
      'covered',
      'activation requests a refresh; the reveal waits for its paint',
    );
    harness.env.terminal.emitRender();
    assert.equal(harness.controller.getSnapshot().readiness.phase, 'revealed');
    assert.deepEqual(harness.env.terminal.written, ['\u001b[?2026hreplay', '', ' live']);
    harness.env.terminal.emitRender();
    assert.deepEqual(harness.env.terminal.written, ['\u001b[?2026hreplay', '', ' live']);
    harness.cache.dispose();
  });

  it('restores the remembered viewport at final geometry, never replay observations', async () => {
    const remembered: TerminalViewportMemory = {
      buffer: 'normal',
      followLatest: false,
      viewportY: 4,
      baseY: 6,
      columns: 80,
      rows: [
        { text: 'alpha', wrapped: false },
        { text: 'beta', wrapped: false },
        { text: 'gamma', wrapped: false },
      ],
    };
    const harness = await startController({ initialViewport: remembered });
    openSlot(harness);
    harness.env.socket.emitMessage({ type: 'replay_start', bytes: 6 });
    harness.env.socket.emitMessage({ type: 'output', data: 'replay' });
    // Replay rebuilt a taller buffer and left the fresh terminal wherever the
    // last written line put it — twelve rows below where the user had been.
    harness.env.terminal.setBufferLines(
      [
        ...Array.from({ length: 12 }, (_, index) => `head-${index}`),
        'alpha',
        'beta',
        'gamma',
        ...Array.from({ length: 12 }, (_, index) => `tail-${index}`),
      ],
      24,
    );
    harness.env.socket.emitMessage({ type: 'replay_end' });
    harness.env.terminal.flushWrites();

    assert.equal(
      harness.viewports.length,
      0,
      'a rebuild in progress never overwrites the memory it is aiming at',
    );

    harness.env.runFrames();
    assert.deepEqual(
      harness.env.terminal.scrollLines,
      [12],
      'the remembered three-row signature is found at its new row',
    );
    assert.equal(harness.controller.getSnapshot().readiness.phase, 'covered');

    harness.env.terminal.emitRender();
    assert.equal(harness.controller.getSnapshot().readiness.phase, 'revealed');
    assert.deepEqual(
      harness.viewports.map((viewport) =>
        viewport.buffer === 'normal'
          ? { viewportY: viewport.viewportY, followLatest: viewport.followLatest }
          : null,
      ),
      [{ viewportY: 12, followLatest: false }],
      'the terminal publishes exactly one viewport: the one it was restored to',
    );
    harness.cache.dispose();
  });

  it('keeps a terminal whose stream died mid-replay concealed', async () => {
    const harness = await startController();
    openSlot(harness);
    harness.env.socket.emitMessage({ type: 'replay_start', bytes: 14 });
    harness.env.socket.emitMessage({ type: 'output', data: 'half a session' });
    harness.env.socket.emitMessage({ type: 'error', code: 'stream_superseded' });

    const snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.sealReason, 'superseded');
    assert.deepEqual(snapshot.readiness, {
      phase: 'failed',
      detail: 'superseded · stream_superseded',
    });

    harness.env.terminal.flushWrites();
    harness.env.runFrames();
    harness.env.terminal.emitRender();
    assert.equal(
      harness.controller.getSnapshot().readiness.phase,
      'failed',
      'no later paint can uncover a half-parsed replay',
    );
    harness.cache.dispose();
  });

  it('keeps a terminal that sealed after replay_end but before its paint concealed', async () => {
    const harness = await startController();
    openSlot(harness);
    harness.env.socket.emitMessage({ type: 'replay_start', bytes: 6 });
    harness.env.socket.emitMessage({ type: 'output', data: 'replay' });
    harness.env.socket.emitMessage({ type: 'replay_end' });
    harness.env.socket.emitMessage({ type: 'output', data: ' bye' });
    harness.env.socket.emitMessage({ type: 'exit', exitCode: 0, signal: null });

    const snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.sealReason, 'exited');
    assert.deepEqual(
      snapshot.readiness,
      { phase: 'failed', detail: 'exited' },
      'replay_end means the bytes were handed to xterm, not that any of them parsed',
    );
    assert.deepEqual(
      harness.env.terminal.written,
      ['replay', ''],
      'held live output is dropped rather than written into a terminal nobody will see',
    );

    harness.env.terminal.flushWrites();
    harness.env.runFrames();
    harness.env.terminal.emitRender();
    assert.equal(harness.controller.getSnapshot().readiness.phase, 'failed');
    harness.cache.dispose();
  });

  it('holds cold reconstruction until a fit actually measures the host', async () => {
    const harness = await startController();
    const slot = openSlot(harness);
    harness.env.measurable = false;
    harness.env.socket.emitMessage({ type: 'replay_start', bytes: 6 });
    harness.env.socket.emitMessage({ type: 'output', data: 'replay' });
    harness.env.socket.emitMessage({ type: 'replay_end' });
    harness.env.terminal.flushWrites();
    harness.env.runFrames();

    assert.deepEqual(
      harness.env.terminal.scrollLines,
      [],
      'an unmeasurable host has no final geometry to restore against',
    );
    harness.env.terminal.emitRender();
    assert.equal(
      harness.controller.getSnapshot().readiness.phase,
      'covered',
      'retries run out, but the reveal must not proceed on unfitted geometry',
    );

    // The only event that can make the fit succeed: the slot gets a size.
    harness.env.measurable = true;
    slot.destination.resize();
    harness.env.runFrames();
    assert.deepEqual(harness.env.terminal.scrollLines, [0], 'restoration runs once, once fitted');
    harness.env.terminal.emitRender();
    assert.equal(harness.controller.getSnapshot().readiness.phase, 'revealed');
    harness.cache.dispose();
  });

  it('classifies a session write as output, so it cannot flip a held viewport to following', async () => {
    const remembered: TerminalViewportMemory = {
      buffer: 'normal',
      followLatest: false,
      viewportY: 2,
      baseY: 2,
      columns: 80,
      rows: [
        { text: 'kept', wrapped: false },
        { text: 'in', wrapped: false },
        { text: 'place', wrapped: false },
      ],
    };
    const harness = await startController({ initialViewport: remembered });
    openSlot(harness);
    harness.env.terminal.setBufferLines(['kept', 'in', 'place'], 0);
    harness.env.socket.emitMessage({ type: 'replay_start', bytes: 4 });
    harness.env.socket.emitMessage({ type: 'replay_end' });
    harness.env.terminal.flushWrites();
    harness.env.runFrames();
    harness.env.terminal.emitRender();
    assert.equal(harness.controller.getSnapshot().readiness.phase, 'revealed');
    assert.equal(harness.viewports.at(-1)?.followLatest, false);

    // Live output that clears the screen leaves the viewport sitting at the
    // base row — indistinguishable, from the buffer alone, from a user who
    // scrolled back to the latest line.
    harness.env.socket.emitMessage({ type: 'output', data: '[3J' });
    harness.env.terminal.flushWrites();

    assert.equal(
      harness.viewports.at(-1)?.followLatest,
      false,
      'the terminal did not decide to follow; a program wrote to it',
    );
    harness.cache.dispose();
  });

  it('does not drain if the attachment becomes stale during reveal publication', async () => {
    const harness = await startController();
    openSlot(harness);
    harness.env.socket.emitMessage({ type: 'replay_start', bytes: 1 });
    harness.env.socket.emitMessage({ type: 'output', data: 'replay' });
    harness.env.socket.emitMessage({ type: 'replay_end' });
    harness.env.socket.emitMessage({ type: 'output', data: 'held-live' });
    harness.env.terminal.flushWrites();
    harness.env.runFrames();
    const unsubscribe = harness.controller.subscribe(() => {
      if (harness.controller.getSnapshot().readiness.phase === 'revealed') harness.cache.dispose();
    });

    harness.env.terminal.emitRender();
    unsubscribe();
    assert.deepEqual(harness.env.terminal.written, ['replay', '']);
  });

  it('turns held-live overflow into a concealed recoverable presentation failure', async () => {
    const harness = await startController();
    openSlot(harness);
    harness.env.socket.emitMessage({ type: 'replay_start', bytes: 0 });
    harness.env.socket.emitMessage({ type: 'replay_end' });
    harness.env.socket.emitMessage({ type: 'output', data: 'x'.repeat(8 * 1024 * 1024 + 1) });

    const snapshot = harness.controller.getSnapshot();
    assert.equal(snapshot.sealReason, 'errored');
    assert.equal(snapshot.readiness.phase, 'failed');
    assert.deepEqual(harness.env.terminal.written, ['']);
    harness.env.terminal.flushWrites();
    harness.env.terminal.emitRender();
    assert.equal(harness.controller.getSnapshot().readiness.phase, 'failed');
    harness.cache.dispose();
  });

  it('returns to latest for emitted keyboard bytes but not mouse or binary reports', async () => {
    const harness = await startController();
    const baseline = harness.env.terminal.scrollToBottomCount;

    assert.equal(
      harness.env.terminal.options.scrollOnUserInput,
      false,
      'xterm scrolls before onData and counts mouse reports as user input, so the policy is ours',
    );
    // A mouse report is `wasUserInput` as far as xterm is concerned.
    harness.env.terminal.emitData('\u001b[Mmouse', true);
    harness.env.terminal.emitBinary('\u0000binary');
    assert.equal(harness.env.terminal.scrollToBottomCount, baseline);
    harness.env.terminal.emitKey('a');
    harness.env.terminal.emitData('a', true);
    assert.equal(harness.env.terminal.scrollToBottomCount, baseline + 1);
    assert.deepEqual(
      harness.env.socket.sent
        .map((message) => JSON.parse(message) as { type: string; data?: string })
        .filter((message) => message.type === 'input')
        .map((message) => message.data),
      ['\u001b[Mmouse', '\u0000binary', 'a'],
    );
    harness.cache.dispose();
  });

  it('keeps one terminal, socket, and claim across 100 surface and zen transitions', async () => {
    const harness = await startController();
    const { env, controller } = harness;

    let slot = openSlot(harness);
    for (let index = 0; index < 50; index += 1) {
      // Zen overlap: the destination slot registers before the source releases.
      const destination = openSlot(harness);
      slot.release();
      slot = destination;

      // Surface navigation: the last slot disappears, then the same hot
      // presentation comes back to a new one.
      slot.release();
      await harness.settle();
      slot = openSlot(harness);
    }

    assert.deepEqual(
      {
        claims: env.claims,
        sockets: env.sockets.length,
        terminals: env.terminals.length,
        opens: env.terminal.openCount,
        hostMoves: env.hostMoves,
        webglCreated: env.webglCreated,
        webglDisposed: env.webglDisposed,
      },
      {
        claims: 1,
        sockets: 1,
        terminals: 1,
        opens: 1,
        hostMoves: 101,
        webglCreated: 51,
        webglDisposed: 50,
      },
    );
    assert.equal(controller.getSnapshot().phase, 'attached');

    slot.release();
    await harness.settle();
    assert.equal(env.webglDisposed, 51, 'parking the last slot releases the GPU addon');

    harness.cache.dispose();
    assert.equal(env.terminal.disposeCount, 1);
    assert.equal(env.socket.closeCount, 1);
    assert.equal(env.resizeObservers.filter((observer) => !observer.stopped).length, 0);
    assert.equal(
      harness.attachment.updateMeasurement(emptyTerminalBufferMeasurement),
      'stale',
      'a disposed attachment accepts no further mutations',
    );
  });

  it('sends geometry only for visible slots and only the final size', async () => {
    const harness = await startController();
    const { env } = harness;
    const slot = openSlot(harness);
    await harness.settle();
    env.socket.sent.length = 0;

    // Split drag: three measurements land in the same frame budget.
    env.fitSize = { cols: 100, rows: 30 };
    slot.destination.resize();
    env.fitSize = { cols: 90, rows: 30 };
    slot.destination.resize();
    env.fitSize = { cols: 80, rows: 24 };
    slot.destination.resize();
    env.runFrames();

    assert.deepEqual(env.resizeMessages(), [{ cols: 80, rows: 24 }]);

    // Parked: a layout change behind the scenes must not reach the session.
    slot.release();
    await harness.settle();
    env.socket.sent.length = 0;
    env.fitSize = { cols: 20, rows: 4 };
    slot.destination.resize();
    env.runFrames();

    assert.deepEqual(env.resizeMessages(), []);
    assert.equal(env.terminal.cols, 80, 'a parked terminal keeps its last visible geometry');
    harness.cache.dispose();
  });

  it('focuses only while visible and blurs on park', async () => {
    const harness = await startController();
    const { env, controller } = harness;

    controller.setFocused(true);
    assert.equal(env.terminal.focusCount, 0, 'a controller with no slot never takes focus');

    const slot = openSlot(harness);
    await harness.settle();
    assert.ok(env.terminal.focusCount > 0, 'the visible focused pane takes focus');

    const focusesWhileVisible = env.terminal.focusCount;
    slot.release();
    await harness.settle();
    assert.equal(env.terminal.blurCount, 1);
    env.runFrames();
    assert.equal(env.terminal.focusCount, focusesWhileVisible, 'a parked terminal never refocuses');
    harness.cache.dispose();
  });

  it('does not self-focus on setFocused while pane focus is disallowed', async () => {
    const harness = await startController({ paneFocusAllowed: () => false });
    const { env, controller } = harness;
    openSlot(harness);
    await harness.settle();

    const before = env.terminal.focusCount;
    controller.setFocused(true);
    assert.equal(
      env.terminal.focusCount,
      before,
      'an attached, focused terminal still yields focus to an open overlay',
    );
    harness.cache.dispose();
  });

  it('does not self-focus on activation completion while pane focus is disallowed', async () => {
    let allowed = true;
    const harness = await startController({ paneFocusAllowed: () => allowed });
    const { env, controller } = harness;
    const slot = openSlot(harness);
    await harness.settle();

    controller.setFocused(true);
    await harness.settle();
    const before = env.terminal.focusCount;

    // An overlay opens, then a late activation pass completes. Activation
    // retries across frames, so in production this lands arbitrarily late.
    allowed = false;
    slot.destination.resize();
    await harness.settle();

    assert.equal(
      env.terminal.focusCount,
      before,
      'delayed activation cannot capture keystrokes behind an open overlay',
    );

    // Control: the same activation pass with ownership available does focus,
    // so the assertion above suppressed a call that really would have happened.
    allowed = true;
    slot.destination.resize();
    await harness.settle();
    assert.ok(
      env.terminal.focusCount > before,
      'the suppressed path is a real one: it focuses once ownership allows it',
    );
    harness.cache.dispose();
  });

  it('never gates commanded focus, so an overlay close path can restore the pane', async () => {
    const harness = await startController({ paneFocusAllowed: () => false });
    const { env, controller } = harness;
    openSlot(harness);
    await harness.settle();

    const before = env.terminal.focusCount;
    controller.focus();
    assert.equal(
      env.terminal.focusCount,
      before + 1,
      'commanded focus arrives only through ownership-aware paths and is the recovery mechanism',
    );
    harness.cache.dispose();
  });

  it('evaluates the ownership predicate at focus time, not construction time', async () => {
    let allowed = false;
    const harness = await startController({ paneFocusAllowed: () => allowed });
    const { env, controller } = harness;
    openSlot(harness);
    await harness.settle();

    const before = env.terminal.focusCount;
    controller.setFocused(true);
    assert.equal(env.terminal.focusCount, before, 'denied while the overlay is open');

    // The denied call still recorded `focused`, but recovery is commanded, so
    // a later allowed self-assertion is what proves the predicate is re-read.
    allowed = true;
    controller.setFocused(true);
    assert.equal(env.terminal.focusCount, before + 1, 'allowed once ownership returns');
    harness.cache.dispose();
  });

  it('falls back to the DOM renderer on context loss without churning addons', async () => {
    const harness = await startController();
    const { env, controller } = harness;
    const slot = openSlot(harness);
    await harness.settle();
    assert.equal(env.webglCreated, 1);
    assert.equal(controller.getSnapshot().rendererWarning, null);

    env.loseWebglContext();
    assert.equal(controller.getSnapshot().rendererWarning, ptyCopy.renderer.webglFallback);
    assert.equal(env.webglDisposed, 1);

    // Ordinary resizes keep the DOM fallback: no addon churn against a driver
    // that just took the context away, and the warning stays true.
    slot.destination.resize();
    await harness.settle();
    slot.destination.resize();
    await harness.settle();
    assert.equal(env.webglCreated, 1, 'a resize is not a reason to retry the GPU renderer');
    assert.equal(controller.getSnapshot().rendererWarning, ptyCopy.renderer.webglFallback);

    // A real park/revisit transition earns one fresh attempt.
    slot.release();
    await harness.settle();
    const revisited = openSlot(harness);
    await harness.settle();
    assert.equal(env.webglCreated, 2);
    assert.equal(controller.getSnapshot().rendererWarning, null);

    revisited.release();
    harness.cache.dispose();
  });

  it('interrupts an in-flight claim when the attachment is disposed', async () => {
    const env = createFakeTerminalEnvironment();
    const cache = createTerminalPresentationCache<TerminalPresentationController>({
      settings: terminalSettingsDefaults.cache,
    });
    let observedAbort = false;
    const session = cache.ensureSession(IDENTITY, PLACEMENT);
    const start = session.beginAttachment();
    assert.equal(start.status, 'started');
    if (start.status !== 'started') throw new Error('Expected attachment.');
    const controller = createTerminalPresentationController({
      attachment: start.attachment,
      scrollbackLines: 1000,
      initiallyInteractive: true,
      parkingRoot: env.parkingRoot,
      environment: env,
      onEvent: () => undefined,
      initialViewport: null,
      onViewport: () => undefined,
      paneFocusAllowed: () => true,
      resolveUrl: () => {
        env.claims += 1;
        // A claim that never settles on its own: only interruption ends it.
        return Effect.async<string, Error>(() =>
          Effect.sync(() => {
            observedAbort = true;
          }),
        );
      },
    });

    env.runTasks();
    assert.equal(env.claims, 1);
    controller.dispose();
    await settleMicrotasks();

    assert.ok(observedAbort, 'disposal interrupts the runtime claim rather than abandoning it');
    assert.equal(env.sockets.length, 0, 'an interrupted claim never opens a socket');
    cache.dispose();
  });

  it('shows web-owned copy when the claim fails, never the runtime message', async () => {
    const env = createFakeTerminalEnvironment();
    const cache = createTerminalPresentationCache<TerminalPresentationController>({
      settings: terminalSettingsDefaults.cache,
    });
    const runtimeMessage = 'pty attach failed: exec /bin/zsh: no such file or directory';
    const failure = new RuntimeApiError({
      code: 'session_launch_rejected',
      status: 409,
      message: runtimeMessage,
      requestId: 'req-42',
      data: { reason: 'harness_missing' },
    });
    const session = cache.ensureSession(IDENTITY, PLACEMENT);
    const start = session.beginAttachment();
    if (start.status !== 'started') throw new Error('Expected attachment.');
    const controller = createTerminalPresentationController({
      attachment: start.attachment,
      scrollbackLines: 1000,
      initiallyInteractive: true,
      parkingRoot: env.parkingRoot,
      environment: env,
      onEvent: () => undefined,
      initialViewport: null,
      onViewport: () => undefined,
      paneFocusAllowed: () => true,
      resolveUrl: () => Effect.fail(failure),
    });

    env.runTasks();
    await settleMicrotasks();

    const expected = runtimeErrorCopy.fromApiError(failure.apiError);
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.sealReason, 'errored');
    assert.equal(snapshot.notice?.message, expected);
    const written = env.terminal.written.join('');
    assert.match(written, new RegExp(escapeRegExp(expected)));
    assert.match(written, /session_launch_rejected · request req-42/);
    assert.doesNotMatch(written, /no such file or directory/);
    cache.dispose();
  });
});

interface Harness {
  readonly env: FakeTerminalEnvironment;
  readonly cache: TerminalPresentationCache<TerminalPresentationController>;
  readonly controller: TerminalPresentationController;
  readonly attachment: TerminalAttachmentHandle<TerminalPresentationController>;
  /** Every viewport the controller asked the cache to remember, in order. */
  readonly viewports: readonly TerminalViewportMemory[];
  readonly settle: () => Promise<void>;
}

async function startController(
  options: {
    readonly initialViewport?: TerminalViewportMemory;
    /** Ownership gate for self-asserting focus; defaults to "allowed". */
    readonly paneFocusAllowed?: () => boolean;
  } = {},
): Promise<Harness> {
  const env = createFakeTerminalEnvironment();
  const cache = createTerminalPresentationCache<TerminalPresentationController>({
    settings: terminalSettingsDefaults.cache,
  });
  const session = cache.ensureSession(IDENTITY, PLACEMENT);
  const start = session.beginAttachment();
  if (start.status !== 'started') throw new Error('Expected attachment.');
  const viewports: TerminalViewportMemory[] = [];
  const controller = createTerminalPresentationController({
    attachment: start.attachment,
    scrollbackLines: 1000,
    initiallyInteractive: true,
    parkingRoot: env.parkingRoot,
    environment: env,
    onEvent: () => undefined,
    initialViewport: options.initialViewport ?? null,
    onViewport: (viewport) => {
      viewports.push(viewport);
      session.updateViewport(viewport);
    },
    paneFocusAllowed: options.paneFocusAllowed ?? (() => true),
    resolveUrl: () => {
      env.claims += 1;
      return Effect.succeed('ws://runtime.test/pty/7');
    },
  });

  env.runTasks();
  await settleMicrotasks();
  env.socket.open();

  const settle = async () => {
    await settleMicrotasks();
    env.runFrames();
    await settleMicrotasks();
    env.runFrames();
  };
  await settle();
  return { env, cache, controller, attachment: start.attachment, viewports, settle };
}

function openSlot(harness: Harness) {
  const destination = harness.env.createSlot();
  const release = harness.controller.registerSlot(destination.element);
  harness.env.runFrames();
  return { destination, release };
}

async function settleMicrotasks() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
