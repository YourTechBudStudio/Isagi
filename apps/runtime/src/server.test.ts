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
    const socket = new WebSocket(agentSessionPtyWebSocketUrl(started.url, 1));
    try {
      await waitForSocketOpen(socket);
      const message = await waitForSocketMessage(socket);

      // The runtime emits a stable error code; user-facing wording lives in web copy.
      assert.equal(message.type, 'error');
      assert.equal(message.type === 'error' ? message.code : undefined, 'attach_token_missing');
    } finally {
      socket.close();
    }
  } finally {
    restoreDataDirectory(previousDataDirectory);
    await server?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('runtime HTTP CORS emits an allow origin only for the exact configured origin', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-origin-'));
  const previousDataDirectory = process.env.ISAGI_DATA_DIR;
  const previousAllowedOrigins = process.env.ISAGI_ALLOWED_ORIGINS;
  process.env.ISAGI_DATA_DIR = dataRoot;
  process.env.ISAGI_ALLOWED_ORIGINS = 'http://127.0.0.1:43129';
  let server: FastifyInstance | undefined;

  try {
    const started = await Effect.runPromise(startRuntimeServer());
    server = started.server;
    const allowed = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'http://127.0.0.1:43129' },
    });
    const rejected = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'http://127.0.0.1:43130' },
    });
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://127.0.0.1:43129');
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
  } finally {
    restoreEnvironment('ISAGI_ALLOWED_ORIGINS', previousAllowedOrigins);
    restoreDataDirectory(previousDataDirectory);
    await server?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function restoreDataDirectory(value: string | undefined) {
  restoreEnvironment('ISAGI_DATA_DIR', value);
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function agentSessionPtyWebSocketUrl(runtimeUrl: string, agentSessionId: number) {
  const url = new URL(`/api/v1/agent-sessions/${agentSessionId}/attach`, runtimeUrl);
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
