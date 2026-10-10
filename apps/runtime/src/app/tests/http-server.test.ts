import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Cause, ConfigProvider, Effect, Exit, Layer } from 'effect';

import type { PtyWebSocketOutputMessage } from '@isagi/contracts';
import { expectNoNewHandles, makeLogCapture } from '@isagi/testing';

import { CliAccess } from '../../cli-access/index.js';
import { noCliAccess } from '../../cli-access/testing.js';
import { HttpServerLayer } from '../http-server.js';
import { AppLayer } from '../layer.js';
import { bootRuntime, type BootedRuntime } from './runtime-harness.js';

test('runtime server registers PTY routes after the websocket plugin is ready', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-ws-'));
  const previousDataDirectory = process.env.ISAGI_DATA_DIR;
  process.env.ISAGI_DATA_DIR = dataRoot;
  let runtime: BootedRuntime | undefined;

  try {
    runtime = await bootRuntime();
    const socket = new WebSocket(agentSessionPtyWebSocketUrl(runtime.url, 1));
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
    await runtime?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('runtime HTTP CORS emits an allow origin only for the exact configured origin', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-origin-'));
  const previousDataDirectory = process.env.ISAGI_DATA_DIR;
  const previousAllowedOrigins = process.env.ISAGI_ALLOWED_ORIGINS;
  process.env.ISAGI_DATA_DIR = dataRoot;
  process.env.ISAGI_ALLOWED_ORIGINS = 'http://127.0.0.1:43129';
  let runtime: BootedRuntime | undefined;

  try {
    runtime = await bootRuntime();
    const server = runtime.server;
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
    await runtime?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a route handler log reaches the runtime logger with the request annotations', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-logger-'));
  const previousDataDirectory = process.env.ISAGI_DATA_DIR;
  const previousDebug = process.env.ISAGI_RUNTIME_DEBUG;
  process.env.ISAGI_DATA_DIR = dataRoot;
  process.env.ISAGI_RUNTIME_DEBUG = '1';
  // `RuntimeLogger` writes `Debug` entries through `console.debug`; record them instead of printing.
  const originalDebug = console.debug;
  const lines: string[] = [];
  console.debug = (...args: ReadonlyArray<unknown>) => {
    lines.push(args.map(String).join(' '));
  };
  let runtime: BootedRuntime | undefined;

  try {
    runtime = await bootRuntime();
    const server = runtime.server;
    // A base directory that does not exist: the handler logs why the listing is empty and still answers.
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/paths/suggestions',
      payload: { input: `${join(dataRoot, 'no-such-directory')}/` },
    });
    const payload = response.json() as { meta?: { requestId?: string } };
    assert.equal(response.statusCode, 200);

    const line = lines.find((entry) => entry.includes('message=paths.listing_failed'));
    assert.ok(line, 'the handler log reached the runtime logger');
    assert.match(line, /^timestamp=\S+ level=DEBUG /, 'as one logfmt line at Debug');
    assert.match(line, /endpointId=paths\.suggestions/);
    assert.ok(line.includes(`requestId=${payload.meta?.requestId}`), line);
  } finally {
    console.debug = originalDebug;
    restoreEnvironment('ISAGI_RUNTIME_DEBUG', previousDebug);
    restoreDataDirectory(previousDataDirectory);
    await runtime?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup failure after listen closes Fastify and disposes the runtime', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-startup-failure-'));
  const previousDataDirectory = process.env.ISAGI_DATA_DIR;
  process.env.ISAGI_DATA_DIR = dataRoot;
  const released: string[] = [];
  let listeningUrl: string | undefined;
  // The first startup step after `listen` fails. Its service is provided around the server, beside the app layer, so
  // its release shows the runtime's services were released too.
  const failingStartupStep = Layer.effect(
    CliAccess,
    Effect.acquireRelease(
      Effect.succeed(
        CliAccess.of({
          ...noCliAccess,
          publishRuntimeUrl: (url) =>
            Effect.sync(() => {
              listeningUrl = url;
            }).pipe(Effect.andThen(Effect.die(new Error('startup step failed')))),
        }),
      ),
      () => Effect.sync(() => released.push('runtime services')),
    ),
  );
  const server = HttpServerLayer.pipe(Layer.provide(failingStartupStep), Layer.provide(AppLayer));
  const logs = makeLogCapture();

  try {
    const exit = await Effect.runPromise(
      expectNoNewHandles(Effect.exit(Effect.scoped(Layer.build(server)))).pipe(
        Effect.provide(logs.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
    );

    assert.ok(Exit.isFailure(exit), 'startup fails');
    assert.match(Cause.pretty(exit.cause), /startup step failed/);
    assert.ok(listeningUrl, 'the server was listening when startup failed');
    await assert.rejects(fetch(`${listeningUrl}/api/v1/health`), 'Fastify no longer listens');
    assert.deepEqual(released, ['runtime services']);
  } finally {
    restoreDataDirectory(previousDataDirectory);
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
