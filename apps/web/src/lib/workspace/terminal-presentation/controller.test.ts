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
} from '../terminal-cache/index.js';
import {
  createTerminalPresentationController,
  type TerminalPresentationController,
} from './controller.js';
import { createFakeTerminalEnvironment, type FakeTerminalEnvironment } from './test-environment.js';

const PLACEMENT: TerminalPlacement = { worktreeId: 1, surfaceId: 2, paneId: 3 };
const IDENTITY = { kind: 'agent_session', sessionId: 7 } as const;

describe('terminal presentation controller', () => {
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
  readonly settle: () => Promise<void>;
}

async function startController(): Promise<Harness> {
  const env = createFakeTerminalEnvironment();
  const cache = createTerminalPresentationCache<TerminalPresentationController>({
    settings: terminalSettingsDefaults.cache,
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
  return { env, cache, controller, attachment: start.attachment, settle };
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
