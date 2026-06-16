import assert from 'node:assert/strict';
import test from 'node:test';

import websocket from '@fastify/websocket';
import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import {
  agentSessionPtyWebSocketEndpoint,
  terminalSessionPtyWebSocketEndpoint,
} from '@isagi/contracts';

import { AgentSessionService, type AgentSessionServiceShape } from '../agent-sessions/index.js';
import { SessionLifecycle, SessionLifecycleLive } from '../session-lifecycle/index.js';
import {
  TerminalSessionService,
  type TerminalSessionServiceShape,
} from '../terminal-sessions/index.js';
import { registerPtyApi } from './api.js';
import { PtyService, type PtyServiceShape } from './index.js';
import type { PtyAttachment } from './pty.service.js';

/**
 * The previous PTY API tests targeted the removed `/pty-sessions/:id` route.
 * Session-level websocket behavior is now exercised through agent/terminal
 * session services; this smoke test keeps the contract path expectations local
 * to the runtime API package while those deeper tests are rebuilt.
 */
test('PTY websocket API uses durable session-level contract routes', () => {
  assert.equal(agentSessionPtyWebSocketEndpoint.path, '/agent-sessions/:agentSessionId/attach');
  assert.equal(
    terminalSessionPtyWebSocketEndpoint.path,
    '/terminal-sessions/:terminalSessionId/attach',
  );
});

test('PTY websocket API detaches an attachment that resolves after socket close', async () => {
  let markAttachStarted!: () => void;
  let resolveAttach!: () => void;
  let detached = false;
  const attachStarted = new Promise<void>((resolve) => {
    markAttachStarted = resolve;
  });
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(AgentSessionService, fakeAgentSessionService()),
      Layer.succeed(TerminalSessionService, fakeTerminalSessionService()),
      Layer.succeed(
        PtyService,
        fakePtyService({
          onAttachStarted: markAttachStarted,
          attachPromise: () =>
            new Promise((resolveAttachment) => {
              resolveAttach = () => resolveAttachment(fakeAttachment(() => (detached = true)));
            }),
        }),
      ),
      SessionLifecycleLive,
    ),
  );

  try {
    await fastify.register(websocket);
    registerPtyApi(fastify, runtime as never);
    await fastify.ready();
    const token = await runtime.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* SessionLifecycle;
        return yield* lifecycle.issueAttachToken({ kind: 'agent_session', sessionId: 10 });
      }),
    );

    const ws = await fastify.injectWS(
      `/api/v1/agent-sessions/10/attach?attachToken=${token.token}`,
    );
    await attachStarted;
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.terminate();
    await closed;
    resolveAttach();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(detached, true);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

function fakeAgentSessionService(): AgentSessionServiceShape {
  return {
    startFresh: () => Effect.die('startFresh is not used'),
    get: () => Effect.die('get is not used'),
    ensureActivePtyProcess: () => Effect.succeed(20),
    activePtyProcessId: () => Effect.succeed(20),
    recordHarnessSessionObservation: () => Effect.void,
  } satisfies AgentSessionServiceShape;
}

function fakeTerminalSessionService(): TerminalSessionServiceShape {
  return {
    startFresh: () => Effect.die('startFresh is not used'),
    get: () => Effect.die('get is not used'),
    ensureActivePtyProcess: () => Effect.die('terminal attach is not used'),
    activePtyProcessId: () => Effect.die('terminal attach is not used'),
  } satisfies TerminalSessionServiceShape;
}

function fakePtyService(input: {
  readonly onAttachStarted: () => void;
  readonly attachPromise: () => Promise<ReturnType<typeof fakeAttachment>>;
}): PtyServiceShape {
  return {
    launch: () => Effect.die('launch is not used'),
    getAttachmentPlan: () =>
      Effect.succeed({
        session: fakeRunningProcess(),
        replayBytes: null,
        live: true,
        replaySource: 'file_log',
      }),
    attach: () =>
      Effect.promise(() => {
        const promise = input.attachPromise();
        input.onAttachStarted();
        return promise;
      }),
    replay: () => Effect.void,
    write: () => Effect.void,
    resize: () => Effect.void,
    kill: () => Effect.void,
    cleanupProcessForDelete: () => Effect.succeed([]),
    cleanupSessionForDelete: () => Effect.succeed([]),
  } satisfies PtyServiceShape;
}

function fakeAttachment(onUnsubscribe: () => void = () => {}) {
  return {
    session: fakeRunningProcess(),
    attachmentId: Symbol('test-attachment'),
    replayBytes: null,
    live: true,
    unsubscribe: onUnsubscribe,
  } satisfies PtyAttachment;
}

function fakeRunningProcess() {
  return {
    id: 20,
    paneId: 1,
    surfaceId: 2,
    worktreeId: 3,
    backend: 'node_pty',
    backendRefJson: JSON.stringify({
      schemaVersion: 1,
      backend: 'node_pty',
      ptySessionId: 20,
      pid: 1234,
    }),
    command: 'bash',
    args: [],
    argsJson: '[]',
    cwd: '/repo/isagi',
    status: 'running',
    statusReason: null,
    exitCode: null,
    signal: null,
    logMode: 'none',
    logPath: null,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
    exitedAt: null,
    lastSeenAt: null,
  } satisfies Parameters<PtyServiceShape['replay']>[0]['session'];
}
