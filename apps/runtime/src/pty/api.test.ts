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
  } = {},
) {
  const running = options.running ?? true;
  return {
    launch: () => Effect.die('launch is not used by websocket tests'),
    attach: (input) =>
      options.missing
        ? Effect.fail(
            new PtyServiceError({
              code: 'session_not_found',
              message: `PTY session ${input.ptySessionId} was not found.`,
              ptySessionId: input.ptySessionId,
            }),
          )
        : Effect.succeed({
            session: {
              id: input.ptySessionId,
              paneId: 1,
              worktreeId: 1,
              backend: 'node_pty' as const,
              backendRefJson: JSON.stringify({
                schemaVersion: 1,
                backend: 'node_pty',
                ptySessionId: input.ptySessionId,
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
              logMode: 'backend_file' as const,
              logPath: '/tmp/no-log-needed',
              createdAt: '2026-06-09T00:00:00.000Z',
              updatedAt: '2026-06-09T00:00:00.000Z',
              exitedAt: null,
              lastSeenAt: null,
            },
            attachmentId: running ? Symbol(`attachment-${input.ptySessionId}`) : null,
            replayBytes: 5,
            live: running,
            unsubscribe: () => {},
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
        : Effect.sync(() => {
            input.send({ type: 'replay_start', bytes: input.bytes ?? 0 });
            input.send({ type: 'replay_end' });
          }),
    write: (input) =>
      running
        ? Effect.void
        : Effect.fail(
            new PtyServiceError({
              code: 'session_not_running',
              message: `PTY session ${input.ptySessionId} is not running.`,
              ptySessionId: input.ptySessionId,
            }),
          ),
    resize: () => Effect.void,
    kill: () => Effect.void,
  } satisfies PtyServiceShape;
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
