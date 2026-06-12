import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import type { PtyWebSocketOutputMessage } from '@isagi/contracts';

import { startRuntimeServer } from './server.js';

test('runtime server registers PTY routes after the websocket plugin is ready', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-ws-'));
  const previousDataDirectory = process.env.ISAGI_DATA_DIR;
  process.env.ISAGI_DATA_DIR = dataRoot;
  let server: FastifyInstance | undefined;

  try {
    const started = await Effect.runPromise(startRuntimeServer());
    server = started.server;
    const socket = new WebSocket(ptyWebSocketUrl(started.url, 1));
    try {
      await waitForSocketOpen(socket);
      const message = await waitForSocketMessage(socket);

      assert.deepEqual(message, {
        type: 'error',
        message: "That session's gone — looks like it already wrapped up.",
      } satisfies PtyWebSocketOutputMessage);
    } finally {
      socket.close();
    }
  } finally {
    restoreDataDirectory(previousDataDirectory);
    await server?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function restoreDataDirectory(value: string | undefined) {
  if (value === undefined) {
    delete process.env.ISAGI_DATA_DIR;
    return;
  }
  process.env.ISAGI_DATA_DIR = value;
}

function ptyWebSocketUrl(runtimeUrl: string, ptySessionId: number) {
  const url = new URL(`/api/v1/pty-sessions/${ptySessionId}`, runtimeUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function waitForSocketOpen(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for PTY websocket open.')),
      1_000,
    );
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('PTY websocket errored before opening.'));
      },
      { once: true },
    );
  });
}

function waitForSocketMessage(socket: WebSocket) {
  return new Promise<PtyWebSocketOutputMessage>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for PTY websocket message.')),
      1_000,
    );
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(event.data)) as PtyWebSocketOutputMessage);
      },
      { once: true },
    );
  });
}
