import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Cause, ConfigProvider, Effect, Exit, Layer } from 'effect';

import type { PtyWebSocketOutputMessage } from '@isagi/contracts';

import { expectNoNewHandles, makeLogCapture } from '../../../test/test-support.js';
import { CliAccess } from '../../cli-access/index.js';
import { noCliAccess } from '../../cli-access/testing.js';
import { WebRootUnusable, webUiContentSecurityPolicy } from '../../web-ui/index.js';
import { HttpServerLayer } from '../http-server.js';
import { launchInputsLayer } from '../launch.js';
import { AppLayer } from '../layer.js';
import { bootRuntime, testRuntimeLaunch, type BootedRuntime } from './runtime-harness.js';

test('runtime server registers PTY routes after the websocket plugin is ready', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-ws-'));
  let runtime: BootedRuntime | undefined;

  try {
    runtime = await bootRuntime({ dataDirectory: dataRoot });
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
    await runtime?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('runtime HTTP CORS emits an allow origin only for the exact configured origin', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-origin-'));
  let runtime: BootedRuntime | undefined;

  try {
    runtime = await bootRuntime({
      dataDirectory: dataRoot,
      allowedOrigins: ['http://127.0.0.1:43129'],
    });
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
    await runtime?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('the Host guard refuses an unlisted host on every route, upgrade and preflight', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-host-'));
  let runtime: BootedRuntime | undefined;

  try {
    runtime = await bootRuntime({
      dataDirectory: dataRoot,
      allowedOrigins: ['http://127.0.0.1:43129'],
    });
    const server = runtime.server;

    const refused = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: 'evil.test' },
    });
    assert.equal(refused.statusCode, 403);
    const { error } = refused.json<{ error: { code: string; data: unknown } }>();
    assert.equal(error.code, 'api_host_not_allowed');
    assert.deepEqual(error.data, { host: 'evil.test' });

    // Unknown routes too: the guard reaches the not-found context, so a refused host never learns what exists.
    const unknown = await server.inject({
      method: 'GET',
      url: '/nope',
      headers: { host: 'evil.test' },
    });
    assert.equal(unknown.statusCode, 403);
    assert.equal(unknown.json<{ error: { code: string } }>().error.code, 'api_host_not_allowed');

    // A preflight from a refused host is refused before CORS can answer it.
    const preflight = await server.inject({
      method: 'OPTIONS',
      url: '/api/v1/health',
      headers: {
        host: 'evil.test',
        origin: 'http://127.0.0.1:43129',
        'access-control-request-method': 'GET',
      },
    });
    assert.equal(preflight.statusCode, 403);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);

    const loopback = await server.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(loopback.statusCode, 200);

    // `injectWS` sends no Host of its own, so each upgrade names the one under test.
    await assert.rejects(
      server.injectWS('/api/v1/events', { headers: { host: 'evil.test' } }),
      /403/,
    );
    const socket = await server.injectWS('/api/v1/events', { headers: { host: '127.0.0.1' } });
    socket.terminate();
  } finally {
    await runtime?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("the runtime's own non-loopback address is refused until it is listed (D1)", async () => {
  // What a PTY's ISAGI_RUNTIME_URL produces under `--host 192.168.1.20`, sent to a loopback-bound runtime, so the
  // rule is exercised without binding a LAN address.
  for (const [allowedHosts, expected] of [
    [undefined, 403],
    [['192.168.1.20', 'VM.Example.test'], 200],
  ] as const) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-d1-'));
    let runtime: BootedRuntime | undefined;
    try {
      if (allowedHosts !== undefined) {
        writeFileSync(
          join(dataRoot, 'config.yaml'),
          `server:\n  allowedHosts:\n${allowedHosts.map((entry) => `    - ${entry}\n`).join('')}`,
          'utf8',
        );
      }
      const booted = await bootRuntime({ dataDirectory: dataRoot });
      runtime = booted;
      const port = new URL(booted.url).port;
      for (const host of [`192.168.1.20:${port}`, 'vm.example.test']) {
        const response = await booted.server.inject({
          method: 'GET',
          url: '/api/v1/health',
          headers: { host },
        });
        assert.equal(response.statusCode, expected, `${host} with ${JSON.stringify(allowedHosts)}`);
      }
    } finally {
      await runtime?.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }
});

test('with serveWebUi off, / is a JSON contract error and the web root is never read', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-ui-off-'));
  let runtime: BootedRuntime | undefined;
  try {
    // A web root that does not exist: with the UI off it is neither checked nor served (AC2).
    runtime = await bootRuntime({
      dataDirectory: dataRoot,
      webRoot: { value: join(dataRoot, 'absent'), source: 'flag', name: '--web-root' },
    });
    const root = await runtime.server.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 404);
    assert.equal(root.json<{ error: { code: string } }>().error.code, 'api_route_not_found');
    assert.equal(root.headers['content-security-policy'], undefined);
  } finally {
    await runtime?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('with serveWebUi on, the web build is served with the CSP and page misses fall back to it', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-ui-on-'));
  const webRoot = join(dataRoot, 'web');
  const documentBody = '<!doctype html><title>Isagi</title>';
  let runtime: BootedRuntime | undefined;
  try {
    mkdirSync(join(webRoot, 'assets'), { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), documentBody);
    writeFileSync(join(webRoot, 'assets', 'a.js'), 'export {};');
    writeFileSync(
      join(dataRoot, 'config.yaml'),
      'server:\n  serveWebUi: true\n  allowedHosts:\n    - vm.example.test\n',
    );
    runtime = await bootRuntime({
      dataDirectory: dataRoot,
      webRoot: { value: webRoot, source: 'flag', name: '--web-root' },
    });
    const server = runtime.server;

    for (const url of ['/', '/deep/path', '/apiary?x=1']) {
      const page = await server.inject({ method: 'GET', url });
      assert.equal(page.statusCode, 200, url);
      assert.equal(page.body, documentBody, url);
      assert.equal(page.headers['content-security-policy'], webUiContentSecurityPolicy, url);
    }
    const asset = await server.inject({ method: 'GET', url: '/assets/a.js' });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.body, 'export {};');
    assert.equal(asset.headers['content-security-policy'], webUiContentSecurityPolicy);
    const head = await server.inject({ method: 'HEAD', url: '/' });
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers['content-security-policy'], webUiContentSecurityPolicy);

    // API and editor misses, and anything but GET/HEAD, stay contract errors: never HTML.
    for (const [method, url] of [
      ['GET', '/api/v1/nope'],
      ['GET', '/api'],
      ['GET', '/editor/1'],
      ['POST', '/x'],
    ] as const) {
      const miss = await server.inject({ method, url });
      assert.equal(miss.statusCode, 404, `${method} ${url}`);
      assert.equal(miss.json<{ error: { code: string } }>().error.code, 'api_route_not_found');
      assert.equal(miss.headers['content-security-policy'], undefined, `${method} ${url}`);
    }
    assert.equal((await server.inject({ method: 'GET', url: '/api/v1/health' })).statusCode, 200);

    // One admission path: the Host guard covers the static files and the fallback too.
    for (const url of ['/', '/deep/path', '/assets/a.js']) {
      const refused = await server.inject({ method: 'GET', url, headers: { host: 'evil.test' } });
      assert.equal(refused.statusCode, 403, url);
      assert.equal(refused.json<{ error: { code: string } }>().error.code, 'api_host_not_allowed');
    }
    const listed = await server.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'vm.example.test' },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body, documentBody);
  } finally {
    await runtime?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('with serveWebUi on, an unusable web root fails startup with WebRootUnusable', async () => {
  for (const webRoot of [undefined, 'absent'] as const) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-ui-bad-'));
    try {
      writeFileSync(join(dataRoot, 'config.yaml'), 'server:\n  serveWebUi: true\n');
      await assert.rejects(
        bootRuntime({
          dataDirectory: dataRoot,
          webRoot:
            webRoot === undefined
              ? undefined
              : { value: join(dataRoot, webRoot), source: 'flag', name: '--web-root' },
        }),
        (error: unknown) => {
          assert.ok(error instanceof WebRootUnusable, String(error));
          assert.match(error.message, /^server\.serveWebUi is true, but /);
          return true;
        },
      );
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }
});

test('a loopback runtime logs no exposure warning', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-warnings-'));
  const logs = makeLogCapture();
  let runtime: BootedRuntime | undefined;

  try {
    runtime = await bootRuntime({ dataDirectory: dataRoot, extraLayer: logs.layer });
    assert.ok(logs.lines.some((line) => line.message === 'Runtime listen settings'));
    assert.deepEqual(
      logs.lines.filter((line) => line.message.includes('beyond loopback')),
      [],
    );
  } finally {
    await runtime?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a route handler log reaches the runtime logger with the request annotations', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-logger-'));
  const previousDebug = process.env.ISAGI_RUNTIME_DEBUG;
  process.env.ISAGI_RUNTIME_DEBUG = '1';
  // `RuntimeLogger` writes `Debug` entries through `console.debug`; record them instead of printing.
  const originalDebug = console.debug;
  const lines: string[] = [];
  console.debug = (...args: ReadonlyArray<unknown>) => {
    lines.push(args.map(String).join(' '));
  };
  let runtime: BootedRuntime | undefined;

  try {
    runtime = await bootRuntime({ dataDirectory: dataRoot });
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
    await runtime?.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup failure after listen closes Fastify and disposes the runtime', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-runtime-server-startup-failure-'));
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
  const server = HttpServerLayer.pipe(
    Layer.provide(failingStartupStep),
    Layer.provide(AppLayer),
    Layer.provide(launchInputsLayer(testRuntimeLaunch({ dataDirectory: dataRoot }))),
  );
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
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

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
