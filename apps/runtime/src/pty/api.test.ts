import assert from 'node:assert/strict';
import test from 'node:test';

import websocket from '@fastify/websocket';
import { Effect, Layer, ManagedRuntime } from 'effect';
import Fastify from 'fastify';

import type { PtyWebSocketOutputMessage } from '@isagi/contracts';

import { registerPtyApi } from './api.js';
import { PtyService, PtyServiceError, type PtyServiceShape } from './index.js';

test('PTY websocket route replays through the contract-owned path', async () => {
  const messages = await withPtyApi(fakePtyService(), async (fastify) => {
    const ws = await fastify.injectWS('/api/v1/pty-sessions/42');
    try {
      return await takeMessages(ws, 3);
    } finally {
      ws.terminate();
    }
  });

  assert.deepEqual(messages, [
    { type: 'session', status: 'running', exitCode: null, signal: null },
    { type: 'replay_start', bytes: 5 },
    { type: 'replay_end' },
  ]);
});

test('PTY websocket route rejects disallowed origins before upgrade', async () => {
  await withPtyApi(fakePtyService(), async (fastify) => {
    await assert.rejects(
      fastify.injectWS('/api/v1/pty-sessions/42', {
        headers: { origin: 'https://not-isagi.example' },
      }),
    );
  });
});

test('PTY websocket route rejects input for non-running sessions with a protocol error', async () => {
  const messages = await withPtyApi(fakePtyService({ running: false }), async (fastify) => {
    const ws = await fastify.injectWS('/api/v1/pty-sessions/42');
    try {
      await takeMessages(ws, 3);
      ws.send(JSON.stringify({ type: 'input', data: 'pwd\n' }));
      return await takeMessages(ws, 1);
    } finally {
      ws.terminate();
    }
  });

  assert.deepEqual(messages, [
    { type: 'error', code: 'session_not_running', message: 'PTY session 42 is not running.' },
  ]);
});

test('PTY websocket route hides internal details for missing sessions', async () => {
  const messages = await withPtyApi(fakePtyService({ missing: true }), async (fastify) => {
    const ws = await fastify.injectWS('/api/v1/pty-sessions/42');
    try {
      return await takeMessages(ws, 1);
    } finally {
      ws.terminate();
    }
  });

  assert.deepEqual(messages, [
    { type: 'error', code: 'session_not_found', message: 'PTY session 42 was not found.' },
  ]);
});

test('PTY websocket route hides internal details for replay failures', async () => {
  const messages = await withPtyApi(fakePtyService({ replayFails: true }), async (fastify) => {
    const ws = await fastify.injectWS('/api/v1/pty-sessions/42');
    try {
      return await takeMessages(ws, 2);
    } finally {
      ws.terminate();
    }
  });

  assert.deepEqual(messages, [
    { type: 'session', status: 'running', exitCode: null, signal: null },
    {
      type: 'error',
      code: 'log_read_failed',
      message: 'Could not replay PTY log /private/runtime-data/sessions/42.ptylog.',
    },
  ]);
});

test('PTY websocket route replays backend screen state before live attach redraw', async () => {
  const events: string[] = [];
  const messages = await withPtyApi(
    fakePtyService({
      replaySource: 'backend',
      attachOutput: 'attach redraw',
      events,
    }),
    async (fastify) => {
      const ws = await fastify.injectWS('/api/v1/pty-sessions/42');
      try {
        return await takeMessages(ws, 4);
      } finally {
        ws.terminate();
      }
    },
  );

  assert.deepEqual(events, ['replay', 'attach']);
  assert.deepEqual(messages, [
    { type: 'session', status: 'running', exitCode: null, signal: null },
    { type: 'replay_start', bytes: 0 },
    { type: 'replay_end' },
    { type: 'output', data: 'attach redraw' },
  ]);
});

test('PTY websocket route queues input until backend replay attaches live', async () => {
  let releaseReplay = () => {};
  const replayGate = new Promise<void>((resolve) => {
    releaseReplay = resolve;
  });
  const writes: string[] = [];
  const messages = await withPtyApi(
    fakePtyService({
      replaySource: 'backend',
      replayGates: [replayGate],
      writes,
    }),
    async (fastify) => {
      const ws = await fastify.injectWS('/api/v1/pty-sessions/42');
      try {
        const sessionMessages = await takeMessages(ws, 1);
        ws.send(JSON.stringify({ type: 'input', data: 'pwd\n' }));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(writes, []);
        releaseReplay();
        return [...sessionMessages, ...(await takeMessages(ws, 2))];
      } finally {
        ws.terminate();
      }
    },
  );

  assert.deepEqual(messages, [
    { type: 'session', status: 'running', exitCode: null, signal: null },
    { type: 'replay_start', bytes: 0 },
    { type: 'replay_end' },
  ]);
  assert.deepEqual(writes, ['pwd\n']);
});

test('PTY websocket route does not attach a closed backend replay socket', async () => {
  let releaseFirstReplay = () => {};
  let releaseSecondReplay = () => {};
  const firstReplayGate = new Promise<void>((resolve) => {
    releaseFirstReplay = resolve;
  });
  const secondReplayGate = new Promise<void>((resolve) => {
    releaseSecondReplay = resolve;
  });
  const events: string[] = [];

  await withPtyApi(
    fakePtyService({
      replaySource: 'backend',
      replayGates: [firstReplayGate, secondReplayGate],
      events,
    }),
    async (fastify) => {
      const stale = await fastify.injectWS('/api/v1/pty-sessions/42');
      await takeMessages(stale, 1);
      stale.terminate();

      const current = await fastify.injectWS('/api/v1/pty-sessions/42');
      try {
        await takeMessages(current, 1);
        releaseSecondReplay();
        await takeMessages(current, 2);
        releaseFirstReplay();
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        current.terminate();
      }
    },
  );

  assert.deepEqual(
    events.filter((event) => event === 'attach'),
    ['attach'],
  );
});

test('PTY websocket route does not let an older open backend replay replace a newer attach', async () => {
  let releaseFirstReplay = () => {};
  let releaseSecondReplay = () => {};
  const firstReplayGate = new Promise<void>((resolve) => {
    releaseFirstReplay = resolve;
  });
  const secondReplayGate = new Promise<void>((resolve) => {
    releaseSecondReplay = resolve;
  });
  const events: string[] = [];

  await withPtyApi(
    fakePtyService({
      replaySource: 'backend',
      replayGates: [firstReplayGate, secondReplayGate],
      events,
    }),
    async (fastify) => {
      const older = await fastify.injectWS('/api/v1/pty-sessions/42');
      await takeMessages(older, 1);

      const newer = await fastify.injectWS('/api/v1/pty-sessions/42');
      try {
        await takeMessages(newer, 1);
        releaseSecondReplay();
        await takeMessages(newer, 2);
        const olderClosed = waitForClose(older);
        releaseFirstReplay();
        await olderClosed;
      } finally {
        older.terminate();
        newer.terminate();
      }
    },
  );

  assert.deepEqual(
    events.filter((event) => event === 'attach'),
    ['attach'],
  );
});

test('PTY websocket route closes a superseded live socket without writing input', async () => {
  const writes: string[] = [];

  await withPtyApi(fakePtyService({ writes }), async (fastify) => {
    const older = await fastify.injectWS('/api/v1/pty-sessions/42');
    await takeMessages(older, 3);

    const newer = await fastify.injectWS('/api/v1/pty-sessions/42');
    try {
      await takeMessages(newer, 3);
      const olderClosed = waitForClose(older);
      older.send(JSON.stringify({ type: 'input', data: 'pwd\n' }));
      await olderClosed;
    } finally {
      older.terminate();
      newer.terminate();
    }
  });

  assert.deepEqual(writes, []);
});

test('PTY websocket route reports unexpected input effect rejections', async () => {
  const messages = await withPtyApi(fakePtyService({ writeDefects: true }), async (fastify) => {
    const ws = await fastify.injectWS('/api/v1/pty-sessions/42');
    try {
      await takeMessages(ws, 3);
      ws.send(JSON.stringify({ type: 'input', data: 'pwd\n' }));
      return await takeMessages(ws, 1);
    } finally {
      ws.terminate();
    }
  });

  assert.equal(messages[0]?.type, 'error');
  assert.equal(messages[0]?.code, 'unknown');
});

async function withPtyApi<A>(
  service: PtyServiceShape,
  run: (fastify: Fastify.FastifyInstance) => Promise<A>,
) {
  const fastify = Fastify({ logger: false });
  const runtime = ManagedRuntime.make(Layer.succeed(PtyService, service));
  try {
    await fastify.register(websocket);
    registerPtyApi(fastify, runtime as never);
    await fastify.ready();
    return await run(fastify);
  } finally {
    await fastify.close();
    await runtime.dispose();
  }
}

function fakePtyService(
  options: {
    readonly running?: boolean;
    readonly missing?: boolean;
    readonly replayFails?: boolean;
    readonly replaySource?: 'backend' | 'file_log';
    readonly attachOutput?: string;
    readonly events?: string[];
    readonly replayGates?: Promise<void>[];
    readonly writes?: string[];
    readonly writeDefects?: boolean;
  } = {},
) {
  const running = options.running ?? true;
  const replaySource = options.replaySource ?? 'file_log';
  const sessionFor = (ptySessionId: number) =>
    ({
      id: ptySessionId,
      paneId: 1,
      surfaceId: 1,
      worktreeId: 1,
      backend: replaySource === 'backend' ? ('tmux' as const) : ('node_pty' as const),
      backendRefJson:
        replaySource === 'backend'
          ? JSON.stringify({
              schemaVersion: 1,
              backend: 'tmux',
              sessionName: `isagi-session-${ptySessionId}`,
            })
          : JSON.stringify({
              schemaVersion: 1,
              backend: 'node_pty',
              ptySessionId,
              pid: 101,
            }),
      purpose: 'terminal' as const,
      harness: null,
      command: 'bash',
      cwd: '/repo/isagi',
      status: running ? ('running' as const) : ('failed' as const),
      statusReason: null,
      exitCode: null,
      signal: null,
      logMode: replaySource === 'backend' ? ('none' as const) : ('backend_file' as const),
      logPath: replaySource === 'backend' ? null : '/tmp/no-log-needed',
      createdAt: '2026-06-09T00:00:00.000Z',
      updatedAt: '2026-06-09T00:00:00.000Z',
      exitedAt: null,
      lastSeenAt: null,
    }) satisfies Parameters<PtyServiceShape['replay']>[0]['session'];
  const missingSessionError = (ptySessionId: number) =>
    new PtyServiceError({
      code: 'session_not_found',
      message: `PTY session ${ptySessionId} was not found.`,
      ptySessionId,
    });
  return {
    launch: () => Effect.die('launch is not used by websocket tests'),
    getAttachmentPlan: (input) =>
      options.missing
        ? Effect.fail(missingSessionError(input.ptySessionId))
        : Effect.succeed({
            session: sessionFor(input.ptySessionId),
            replayBytes: replaySource === 'backend' ? null : 5,
            live: running,
            replaySource,
          }),
    attach: (input) =>
      options.missing
        ? Effect.fail(missingSessionError(input.ptySessionId))
        : Effect.sync(() => {
            options.events?.push('attach');
            if (options.attachOutput) {
              input.send({ type: 'output', data: options.attachOutput });
            }
            return {
              session: sessionFor(input.ptySessionId),
              attachmentId: running ? Symbol(`attachment-${input.ptySessionId}`) : null,
              replayBytes: replaySource === 'backend' ? null : 5,
              live: running,
              unsubscribe: () => {},
            };
          }),
    replay: (input) =>
      options.replayFails
        ? Effect.fail(
            new PtyServiceError({
              code: 'log_read_failed',
              message: 'Could not replay PTY log /private/runtime-data/sessions/42.ptylog.',
              ptySessionId: input.session.id,
            }),
          )
        : Effect.promise(async () => {
            options.events?.push('replay');
            await options.replayGates?.shift();
          }).pipe(
            Effect.zipRight(
              Effect.sync(() => {
                input.send({ type: 'replay_start', bytes: input.bytes ?? 0 });
                input.send({ type: 'replay_end' });
              }),
            ),
          ),
    write: (input) =>
      options.writeDefects
        ? Effect.die(new Error('write exploded'))
        : running
          ? Effect.sync(() => {
              options.writes?.push(input.data);
            })
          : Effect.fail(
              new PtyServiceError({
                code: 'session_not_running',
                message: `PTY session ${input.ptySessionId} is not running.`,
                ptySessionId: input.ptySessionId,
              }),
            ),
    resize: () => Effect.void,
    kill: () => Effect.void,
    cleanupSessionForDelete: () => Effect.succeed([]),
  } satisfies PtyServiceShape;
}

function waitForClose(ws: { once: (event: 'close', listener: () => void) => void }) {
  return new Promise<void>((resolve) => {
    ws.once('close', resolve);
  });
}

function takeMessages(
  ws: { once: (event: 'message', listener: (data: Buffer) => void) => void },
  count: number,
) {
  const messages: PtyWebSocketOutputMessage[] = [];
  return new Promise<PtyWebSocketOutputMessage[]>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for websocket messages.')),
      1_000,
    );
    const listen = () => {
      ws.once('message', (data) => {
        messages.push(JSON.parse(data.toString()) as PtyWebSocketOutputMessage);
        if (messages.length === count) {
          clearTimeout(timeout);
          resolve(messages);
        } else {
          listen();
        }
      });
    };
    listen();
  });
}
