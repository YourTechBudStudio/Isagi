import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { terminalSettingsDefaults, type ApiError } from '@isagi/contracts';
import { RuntimeApiError, RuntimeTransportError } from '@isagi/runtime-client';

import { createTerminalPresentationCache } from '../terminal-cache/index.js';
import {
  decideTerminalAttachment,
  presentationOutlivedIncarnation,
  rejoinRefusal,
  type DecidedTerminalAttachment,
  type TerminalAttachmentDecision,
} from './attachment-decision.js';
import type { TerminalPresentationController } from './controller.js';
import { startTerminalPresentation } from './start-presentation.js';
import { createFakeTerminalEnvironment, type FakeSocket } from './test-environment.js';

const PLACEMENT = { worktreeId: 1, surfaceId: 2, paneId: 3 } as const;
const IDENTITY = { kind: 'agent_session', sessionId: 7 } as const;
const IDENTITY_KEY = 'agent_session:7';

/**
 * The real cache and the real controller over fake browser capabilities, so the decision is
 * checked against presentations that were actually bound by a socket and sealed by its stream.
 */
function setup(t: TestContext) {
  const env = createFakeTerminalEnvironment();
  env.resolveFonts();
  const cache = createTerminalPresentationCache<TerminalPresentationController>({
    settings: terminalSettingsDefaults.cache,
  });
  t.after(() => cache.dispose());
  const session = cache.ensureSession(IDENTITY, PLACEMENT);
  /**
   * The runtime's side of an automatic re-attach: the claim names the incarnation it expects, and
   * anything but that live process is refused without a launch.
   */
  const runtime = { liveIncarnation: null as string | null, refusals: 0 };
  const readCached = () => {
    const existing = session.acquireVisibility(PLACEMENT);
    if (existing.status !== 'acquired') return null;
    existing.lease.release();
    return existing.resource;
  };

  /** One mounted pane: what `useTerminalAttachmentResource` keeps across renders. */
  const mountPane = () => {
    let previous: DecidedTerminalAttachment | null = null;
    let shown: TerminalPresentationController | null = null;
    return {
      get shown() {
        return shown;
      },
      async request(input: {
        readonly processIncarnation: string | null;
        readonly attachmentRequest?: number;
      }): Promise<TerminalAttachmentDecision<TerminalPresentationController>['type'] | 'refused'> {
        const attachmentRequest = input.attachmentRequest ?? 0;
        const request = {
          requestKey: `${IDENTITY_KEY}:${input.processIncarnation ?? 'none'}:${attachmentRequest}`,
          identityKey: IDENTITY_KEY,
          attachmentRequest,
          processIncarnation: input.processIncarnation,
        };
        const decision = decideTerminalAttachment({
          previous,
          request,
          mountedOutlived:
            shown !== null &&
            presentationOutlivedIncarnation(shown.getSnapshot(), input.processIncarnation),
          readCached,
        });
        if (decision.type === 'keep') return decision.type;
        if (decision.type === 'reuse') {
          previous = { ...request, replacedOutlived: false };
          shown = decision.resource;
          return decision.type;
        }
        previous = { ...request, replacedOutlived: decision.replacesOutlived };
        // Claim first, dispose after: a refused automatic re-attach keeps what the pane shows.
        if (
          decision.expectedIncarnation !== null &&
          decision.expectedIncarnation !== runtime.liveIncarnation
        ) {
          runtime.refusals += 1;
          return 'refused';
        }
        const start = session.beginAttachment();
        if (start.status !== 'started') throw new Error('Expected attachment.');
        const result = await startTerminalPresentation({
          attachment: start.attachment,
          scrollbackLines: 1000,
          initiallyInteractive: true,
          parkingRoot: env.parkingRoot,
          environment: env,
          initialViewport: null,
          onViewport: () => undefined,
          onEvent: () => undefined,
          paneFocusAllowed: () => true,
          resolveUrl: async () => {
            env.claims += 1;
            return 'ws://runtime.test/pty/7';
          },
          isCancelled: () => false,
        });
        if (result.status !== 'started') throw new Error('Expected a prepared controller.');
        shown = result.controller;
        return decision.type;
      },
    };
  };

  /** Let the newest controller claim, then have the runtime bind its socket to `incarnation`. */
  const connect = async (processIncarnation: string): Promise<FakeSocket> => {
    env.runTasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = env.sockets.at(-1);
    if (!socket) throw new Error('No socket was opened.');
    socket.open();
    socket.emitMessage({ type: 'session', status: 'running', processIncarnation });
    return socket;
  };

  return { env, runtime, mountPane, connect };
}

describe('terminal attachment decision', () => {
  it('records the process incarnation the socket binds the presentation to', async (t) => {
    const { mountPane, connect } = setup(t);
    const pane = mountPane();
    await pane.request({ processIncarnation: 'pty:100' });
    assert.equal(pane.shown?.getSnapshot().processIncarnation, null, 'unbound until it says');

    await connect('pty:100');

    assert.equal(pane.shown?.getSnapshot().processIncarnation, 'pty:100');
  });

  it('attaches to the new process when a pane remounts after its process was replaced', async (t) => {
    const { env, runtime, mountPane, connect } = setup(t);
    const terminalMode = mountPane();
    await terminalMode.request({ processIncarnation: 'pty:100' });
    const socket = await connect('pty:100');
    // Switching to Fluidcast stops the PTY; the pane unmounts with the sealed terminal cached.
    socket.emitMessage({ type: 'exit', exitCode: 0, signal: null });
    const stale = terminalMode.shown;
    assert.equal(stale?.getSnapshot().sealReason, 'exited');

    // Switching back resumes the session in a new PTY, and a fresh pane mounts at epoch 0.
    runtime.liveIncarnation = 'pty:101';
    const remounted = mountPane();
    assert.equal(await remounted.request({ processIncarnation: 'pty:101' }), 'attach');
    await connect('pty:101');

    assert.equal(env.claims, 2);
    assert.notEqual(remounted.shown, stale);
    assert.equal(remounted.shown?.getSnapshot().processIncarnation, 'pty:101');
    assert.equal(env.terminals[0]?.disposeCount, 1, 'the outlived presentation is released');
  });

  it('re-attaches a mounted pane once the runtime projects a new incarnation', async (t) => {
    const { env, runtime, mountPane, connect } = setup(t);
    const pane = mountPane();
    await pane.request({ processIncarnation: 'pty:100' });
    const socket = await connect('pty:100');
    // The runtime goes away; its restore relaunches every pane-bound session.
    socket.close();
    assert.equal(pane.shown?.getSnapshot().sealReason, 'disconnected');
    assert.equal(await pane.request({ processIncarnation: 'pty:100' }), 'keep');

    runtime.liveIncarnation = 'pty:101';
    assert.equal(await pane.request({ processIncarnation: 'pty:101' }), 'attach');
    await connect('pty:101');

    assert.equal(env.claims, 2);
    assert.equal(pane.shown?.getSnapshot().phase, 'attached');
  });

  it('keeps the final output when a stale projection still names the exited process', async (t) => {
    const { env, mountPane, connect } = setup(t);
    const pane = mountPane();
    await pane.request({ processIncarnation: 'pty:100' });
    const socket = await connect('pty:100');
    socket.emitMessage({ type: 'exit', exitCode: 0, signal: null });
    const sealed = pane.shown;

    // A claim here would relaunch a process that exited on its own, without anyone asking.
    const remounted = mountPane();
    assert.equal(await remounted.request({ processIncarnation: 'pty:100' }), 'reuse');

    assert.equal(env.claims, 1);
    assert.equal(remounted.shown, sealed);
    assert.equal(remounted.shown?.getSnapshot().sealReason, 'exited');
  });

  for (const code of ['stream_superseded', 'session_attachment_moved'] as const) {
    it(`never takes back an attachment another pane took over (${code})`, async (t) => {
      const { env, mountPane, connect } = setup(t);
      const pane = mountPane();
      await pane.request({ processIncarnation: 'pty:100' });
      const socket = await connect('pty:100');
      socket.emitMessage({ type: 'error', code });
      const taken = pane.shown;

      // Same process: nothing outlived. A process the new holder launched since: still theirs.
      assert.equal(await pane.request({ processIncarnation: 'pty:100' }), 'keep');
      assert.equal(await mountPane().request({ processIncarnation: 'pty:101' }), 'reuse');

      assert.equal(env.claims, 1);
      assert.equal(taken?.getSnapshot().phase, 'sealed');
    });
  }

  it('trusts a live socket over a projection that names another incarnation', async (t) => {
    const { env, mountPane, connect } = setup(t);
    const pane = mountPane();
    // Reconnect on a stale projection: the claim launches a process the projection has not seen.
    await pane.request({ processIncarnation: 'pty:100', attachmentRequest: 1 });
    await connect('pty:101');
    assert.equal(
      await pane.request({ processIncarnation: 'pty:100', attachmentRequest: 1 }),
      'keep',
    );

    assert.equal(
      await pane.request({ processIncarnation: 'pty:101', attachmentRequest: 1 }),
      'reuse',
    );
    assert.equal(env.claims, 1);
  });

  it('re-attaches once when the stream ends after the projection moved on', async (t) => {
    const { env, runtime, mountPane, connect } = setup(t);
    const pane = mountPane();
    await pane.request({ processIncarnation: 'pty:100' });
    const socket = await connect('pty:100');
    runtime.liveIncarnation = 'pty:101';
    // The new incarnation is projected while the old stream is still open...
    assert.equal(await pane.request({ processIncarnation: 'pty:101' }), 'reuse');
    // ...and only then does the old process's exit arrive.
    socket.emitMessage({ type: 'exit', exitCode: null, signal: 'SIGTERM' });
    assert.equal(await pane.request({ processIncarnation: 'pty:101' }), 'attach');
    const replacement = await connect('pty:101');
    runtime.liveIncarnation = null;
    replacement.emitMessage({ type: 'exit', exitCode: 1, signal: null });

    // The projection still says `pty:101`; one re-attach per request is all it can drive.
    assert.equal(await pane.request({ processIncarnation: 'pty:101' }), 'keep');
    assert.equal(env.claims, 2);
  });

  it('never relaunches when a newly bound process exits before its projection catches up', async (t) => {
    const { env, runtime, mountPane, connect } = setup(t);
    const pane = mountPane();
    // Reconnect on a stale projection: the claim launches `pty:101` while `pty:100` is projected.
    await pane.request({ processIncarnation: 'pty:100', attachmentRequest: 1 });
    const socket = await connect('pty:101');
    // `pty:101` exits on its own before the projection has caught up.
    socket.emitMessage({ type: 'exit', exitCode: 0, signal: null });
    const finalOutput = pane.shown;
    assert.equal(finalOutput?.getSnapshot().processIncarnation, 'pty:101');

    // The stale `pty:100` looks like a replacement, but the automatic re-attach names it and the
    // runtime, which runs nothing live, refuses instead of launching `pty:102`.
    assert.equal(
      await pane.request({ processIncarnation: 'pty:100', attachmentRequest: 1 }),
      'refused',
    );

    assert.equal(runtime.refusals, 1);
    assert.equal(env.claims, 1, 'no attach was started');
    assert.equal(pane.shown, finalOutput, 'the final output stays on screen');
    assert.equal(finalOutput?.getSnapshot().sealReason, 'exited');
    assert.equal(env.terminals[0]?.disposeCount, 0, 'nothing was disposed before the refusal');
  });

  it('names the expected incarnation only on an attach nobody asked for', () => {
    const outlived = {
      getSnapshot: () => ({
        phase: 'sealed' as const,
        sealReason: 'exited' as const,
        processIncarnation: 'pty:100',
      }),
    };
    const decide = (attachmentRequest: number) =>
      decideTerminalAttachment({
        previous: null,
        request: {
          requestKey: `${IDENTITY_KEY}:pty:101:${attachmentRequest}`,
          identityKey: IDENTITY_KEY,
          attachmentRequest,
          processIncarnation: 'pty:101',
        },
        mountedOutlived: false,
        readCached: () => outlived,
      });

    assert.deepEqual(decide(0), {
      type: 'attach',
      replacesOutlived: true,
      expectedIncarnation: 'pty:101',
    });
    // Reconnect is the user asking: it may launch, so it names nothing.
    assert.deepEqual(decide(1), {
      type: 'attach',
      replacesOutlived: true,
      expectedIncarnation: null,
    });
  });

  it('attaches afresh on an explicit request even when the presentation still fits', async (t) => {
    const { env, mountPane, connect } = setup(t);
    const pane = mountPane();
    await pane.request({ processIncarnation: 'pty:100' });
    await connect('pty:100');

    assert.equal(
      await pane.request({ processIncarnation: 'pty:100', attachmentRequest: 1 }),
      'attach',
    );
    await connect('pty:100');
    assert.equal(env.claims, 2);
  });
});

describe('presentationOutlivedIncarnation', () => {
  const sealed = (overrides: {
    readonly sealReason?: 'exited' | 'disconnected' | 'errored' | 'moved' | 'superseded';
    readonly processIncarnation?: string | null;
  }) =>
    ({
      phase: 'sealed',
      sealReason: overrides.sealReason ?? 'exited',
      processIncarnation:
        overrides.processIncarnation === undefined ? 'pty:100' : overrides.processIncarnation,
    }) as const;

  it('is outlived only once sealed, bound, and projected elsewhere', () => {
    assert.equal(presentationOutlivedIncarnation(sealed({}), 'pty:101'), true);
    assert.equal(
      presentationOutlivedIncarnation(sealed({ sealReason: 'errored' }), 'pty:101'),
      true,
    );
    assert.equal(presentationOutlivedIncarnation(sealed({}), 'pty:100'), false);
    assert.equal(presentationOutlivedIncarnation(sealed({}), null), false);
    assert.equal(
      presentationOutlivedIncarnation(sealed({ processIncarnation: null }), 'pty:101'),
      false,
      'a presentation whose claim failed never streamed a process',
    );
    assert.equal(
      presentationOutlivedIncarnation(
        { phase: 'attached', sealReason: null, processIncarnation: 'pty:100' },
        'pty:101',
      ),
      false,
    );
  });
});

describe('rejoinRefusal', () => {
  const rejected = (code: string, reason: string) =>
    new RuntimeApiError({
      endpointId: 'surfaces.claimPaneSession',
      apiError: {
        code,
        status: 400,
        message: 'diagnostic',
        requestId: 'req-1',
        data: { reason },
      } as ApiError,
    });

  it('names the runtime declining a rejoin, so the pane keeps its output quietly', () => {
    assert.equal(
      rejoinRefusal(rejected('surface_rejected', 'process_incarnation_stale')),
      'process_incarnation_stale',
    );
    assert.equal(
      rejoinRefusal(rejected('surface_rejected', 'session_already_attached')),
      'session_already_attached',
    );
  });

  it('leaves every other failure to be reported', () => {
    assert.equal(rejoinRefusal(rejected('surface_rejected', 'pane_not_found')), null);
    assert.equal(
      rejoinRefusal(rejected('runtime_database_failed', 'process_incarnation_stale')),
      null,
    );
    assert.equal(
      rejoinRefusal(
        new RuntimeTransportError({
          endpointId: 'surfaces.claimPaneSession',
          cause: new Error('offline'),
        }),
      ),
      null,
    );
    assert.equal(rejoinRefusal(new Error('unexpected')), null);
  });
});
