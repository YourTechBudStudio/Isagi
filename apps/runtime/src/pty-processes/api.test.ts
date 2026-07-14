import assert from 'node:assert/strict';
import test from 'node:test';

import websocket from '@fastify/websocket';
import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import {
  agentSessionPtyWebSocketEndpoint,
  terminalSessionPtyWebSocketEndpoint,
  type PtyStreamOutputMessageSet,
} from '@isagi/contracts';

import { HarnessAdapterError } from '../agent-sessions/harness/types.js';
import {
  AgentSessionError,
  AgentSessionService,
  type AgentSessionServiceShape,
} from '../agent-sessions/index.js';
import {
  SessionLifecycle,
  SessionLifecycleLive,
  type AttachTokenRecord,
  type SessionLifecycleService,
} from '../session-lifecycle/index.js';
import {
  TerminalSessionService,
  type TerminalSessionServiceShape,
} from '../terminal-sessions/index.js';
import { registerPtyApi } from './api.js';
import { PtyService, type PtyServiceShape } from './index.js';
import type { PtyAttachment } from './pty.service.js';

type OutputSender = (message: PtyStreamOutputMessageSet) => void;

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

test('PTY websocket API rejects a different loopback origin before resolving a session', async () => {
  const previous = process.env.ISAGI_ALLOWED_ORIGINS;
  process.env.ISAGI_ALLOWED_ORIGINS = 'http://127.0.0.1:43129';
  const fastify = Fastify({ logger: false });
  try {
    await fastify.register(websocket);
    registerPtyApi(fastify, {
      runPromise: () => Promise.reject(new Error('must not run')),
    } as never);
    await fastify.ready();
    await assert.rejects(
      fastify.injectWS('/api/v1/agent-sessions/10/attach', {
        headers: { origin: 'http://127.0.0.1:43130' },
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.ISAGI_ALLOWED_ORIGINS;
    else process.env.ISAGI_ALLOWED_ORIGINS = previous;
    await fastify.close();
  }
});

test('PTY websocket API reports unsupported harness adapter failures with stable protocol code', async () => {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(
        AgentSessionService,
        fakeAgentSessionService({
          ensureActivePtyProcess: () =>
            Effect.sleep(1).pipe(
              Effect.zipRight(
                Effect.fail(
                  new HarnessAdapterError(
                    'unsupported_harness',
                    'Harness claude is not supported yet.',
                  ),
                ),
              ),
            ),
        }),
      ),
      Layer.succeed(TerminalSessionService, fakeTerminalSessionService()),
      Layer.succeed(
        PtyService,
        fakePtyService({ onAttachStarted: () => {}, attachPromise: async () => fakeAttachment() }),
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
    const message = await receiveJson(ws);
    assert.deepEqual(message, {
      type: 'error',
      code: 'unsupported_harness',
      message: 'Harness claude is not supported yet.',
    });
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('PTY websocket API reports invalid harness metadata with stable protocol code', async () => {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(
        AgentSessionService,
        fakeAgentSessionService({
          ensureActivePtyProcess: () =>
            Effect.fail(
              new AgentSessionError('harness_metadata_invalid', 'Harness metadata is invalid.'),
            ),
        }),
      ),
      Layer.succeed(TerminalSessionService, fakeTerminalSessionService()),
      Layer.succeed(
        PtyService,
        fakePtyService({ onAttachStarted: () => {}, attachPromise: async () => fakeAttachment() }),
      ),
      SessionLifecycleLive,
    ),
  );

  try {
    await fastify.register(websocket);
    registerPtyApi(fastify, runtime as never);
    await fastify.ready();
    const token = await issueAgentAttachToken(runtime, 10);

    const ws = await fastify.injectWS(
      `/api/v1/agent-sessions/10/attach?attachToken=${token.token}`,
    );
    const message = await receiveJson(ws);
    assert.deepEqual(message, {
      type: 'error',
      code: 'harness_metadata_invalid',
      message: 'Harness metadata is invalid.',
    });
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
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

test('PTY websocket API preserves session replay before live output ordering', async () => {
  let liveSend: OutputSender | null = null;
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(AgentSessionService, fakeAgentSessionService()),
      Layer.succeed(TerminalSessionService, fakeTerminalSessionService()),
      Layer.succeed(
        PtyService,
        fakePtyService({
          onAttachStarted: () => {},
          attachPromise: async () =>
            fakeAttachment(() => {
              liveSend = null;
            }),
          onAttachSend: (send) => {
            liveSend = send;
          },
          replay: (send) =>
            Effect.sync(() => {
              send({ type: 'replay_start', bytes: 5 });
              send({ type: 'output', data: 'hello', replay: true });
              send({ type: 'replay_end' });
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
    const token = await issueAgentAttachToken(runtime, 10);

    const ws = await fastify.injectWS(
      `/api/v1/agent-sessions/10/attach?attachToken=${token.token}`,
    );
    const messages = collectJsonMessages(ws);
    await messages.waitForCount(4, 'session replay messages');
    assert.deepEqual(messages.items[0], {
      type: 'session',
      status: 'running',
      exitCode: null,
      signal: null,
    });
    assert.deepEqual(messages.items[1], { type: 'replay_start', bytes: 5 });
    assert.deepEqual(messages.items[2], {
      type: 'output',
      data: 'hello',
      replay: true,
    });
    assert.deepEqual(messages.items[3], { type: 'replay_end' });

    assert.ok(liveSend);
    (liveSend as OutputSender)({ type: 'output', data: ' live' });
    await messages.waitForCount(5, 'live output');
    assert.deepEqual(messages.items[4], { type: 'output', data: ' live' });
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('PTY websocket API buffers client input until live attach completes', async () => {
  let markAttachStarted!: () => void;
  let resolveAttach!: () => void;
  const attachStarted = new Promise<void>((resolve) => {
    markAttachStarted = resolve;
  });
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
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
              resolveAttach = () => resolveAttachment(fakeAttachment());
            }),
          write: (data) =>
            Effect.sync(() => {
              writes.push(data);
            }),
          resize: (size) =>
            Effect.sync(() => {
              resizes.push(size);
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
    const token = await issueAgentAttachToken(runtime, 10);

    const ws = await fastify.injectWS(
      `/api/v1/agent-sessions/10/attach?attachToken=${token.token}`,
    );
    await attachStarted;
    ws.send(JSON.stringify({ type: 'input', data: 'abc' }));
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    assert.deepEqual(writes, []);
    assert.deepEqual(resizes, []);

    resolveAttach();
    await waitUntil(() => writes.length === 1 && resizes.length === 1, 'buffered input flush');
    assert.deepEqual(writes, ['abc']);
    assert.deepEqual(resizes, [{ cols: 120, rows: 40 }]);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

test('PTY websocket API supersede detaches the displaced viewer before the replacement attaches', async () => {
  let active = false;
  let activeSend: OutputSender | null = null;
  let attachCalls = 0;
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(AgentSessionService, fakeAgentSessionService()),
      Layer.succeed(TerminalSessionService, fakeTerminalSessionService()),
      Layer.succeed(
        PtyService,
        fakePtyService({
          onAttachStarted: () => {},
          attachPromise: async () => {
            if (active) throw new Error('session_already_attached');
            active = true;
            attachCalls++;
            return fakeAttachment(() => {
              active = false;
              activeSend = null;
            });
          },
          onAttachSend: (send) => {
            activeSend = send;
          },
        }),
      ),
      SessionLifecycleLive,
    ),
  );

  try {
    await fastify.register(websocket);
    registerPtyApi(fastify, runtime as never);
    await fastify.ready();
    const firstToken = await issueAgentAttachToken(runtime, 10);
    const first = await fastify.injectWS(
      `/api/v1/agent-sessions/10/attach?attachToken=${firstToken.token}`,
    );
    const firstMessages = collectJsonMessages(first);
    await waitUntil(() => attachCalls === 1, 'first attachment');

    const secondToken = await issueAgentAttachToken(runtime, 10);
    const firstClosed = onceClose(first);
    const second = await fastify.injectWS(
      `/api/v1/agent-sessions/10/attach?attachToken=${secondToken.token}`,
    );
    const secondMessages = collectJsonMessages(second);

    await firstMessages.waitForType('error', 'first moved error');
    assert.deepEqual(firstMessages.items.at(-1), {
      type: 'error',
      code: 'session_attachment_moved',
    });
    await firstClosed;
    await waitUntil(() => attachCalls === 2, 'replacement attachment');

    assert.ok(activeSend);
    (activeSend as OutputSender)({ type: 'output', data: 'replacement-live' });
    await secondMessages.waitForType('output', 'replacement live output');
    assert.deepEqual(secondMessages.items.at(-1), {
      type: 'output',
      data: 'replacement-live',
    });
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
});

function fakeAgentSessionService(
  overrides: Partial<AgentSessionServiceShape> = {},
): AgentSessionServiceShape {
  return {
    startFresh: () => Effect.die('startFresh is not used'),
    get: () => Effect.die('get is not used'),
    ensureActivePtyProcess: () => Effect.succeed(20),
    activePtyProcessId: () => Effect.succeed(20),
    ...overrides,
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
  readonly onAttachSend?:
    | ((send: (message: PtyStreamOutputMessageSet) => void) => void)
    | undefined;
  readonly replay?:
    | ((send: (message: PtyStreamOutputMessageSet) => void) => Effect.Effect<void>)
    | undefined;
  readonly write?: ((data: string) => Effect.Effect<void>) | undefined;
  readonly resize?:
    | ((size: { readonly cols: number; readonly rows: number }) => Effect.Effect<void>)
    | undefined;
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
    attach: ({ send }) =>
      Effect.promise(() => {
        const promise = input.attachPromise();
        input.onAttachStarted();
        input.onAttachSend?.(send);
        return promise;
      }),
    replay: ({ send }) => input.replay?.(send) ?? Effect.void,
    write: ({ data }) => input.write?.(data) ?? Effect.void,
    writeInput: ({ data }) => input.write?.(data) ?? Effect.void,
    resize: ({ cols, rows }) => input.resize?.({ cols, rows }) ?? Effect.void,
    kill: () => Effect.void,
    terminate: () => Effect.void,
    pin: () => Effect.void,
    unpin: () => Effect.void,
    isPinned: () => Effect.succeed(false),
  } satisfies PtyServiceShape;
}

function issueAgentAttachToken(
  runtime: {
    readonly runPromise: (
      effect: Effect.Effect<AttachTokenRecord, never, SessionLifecycleService>,
    ) => Promise<AttachTokenRecord>;
  },
  sessionId: number,
) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const lifecycle = yield* SessionLifecycle;
      return yield* lifecycle.issueAttachToken({ kind: 'agent_session', sessionId });
    }),
  );
}

function receiveJson(
  ws: {
    once: (event: 'message', listener: (data: Buffer) => void) => void;
    off?: (event: 'message', listener: (data: Buffer) => void) => void;
  },
  label = 'websocket message',
) {
  return new Promise<unknown>((resolve, reject) => {
    const onMessage = (data: Buffer) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    };
    const timer = setTimeout(() => {
      ws.off?.('message', onMessage);
      reject(new Error(`Timed out waiting for ${label}`));
    }, 1_000);
    ws.once('message', onMessage);
  });
}

function collectJsonMessages(ws: {
  on: (event: 'message', listener: (data: Buffer) => void) => void;
}) {
  const items: unknown[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (data) => {
    items.push(JSON.parse(data.toString()));
    for (const waiter of waiters.splice(0)) waiter();
  });

  const waitFor = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 1_000;
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${label}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  return {
    items,
    waitForCount: (count: number, label: string) => waitFor(() => items.length >= count, label),
    waitForType: (type: string, label: string) =>
      waitFor(
        () =>
          items.some(
            (item) =>
              typeof item === 'object' && item !== null && 'type' in item && item.type === type,
          ),
        label,
      ),
  };
}

function onceClose(ws: { once: (event: 'close', listener: () => void) => void }) {
  return new Promise<void>((resolve) => ws.once('close', resolve));
}

async function waitUntil(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeAttachment(onUnsubscribe: () => void = () => {}) {
  return {
    session: fakeRunningProcess(),
    attachmentId: Symbol('test-attachment'),
    replayBytes: null,
    live: true,
    detach: Effect.sync(onUnsubscribe),
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
      ptyProcessId: 20,
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
