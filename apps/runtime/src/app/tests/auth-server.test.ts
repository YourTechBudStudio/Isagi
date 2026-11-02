// The runtime with `server.auth` on, booted through the harness the way a user turns it on: config.yaml.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { Redacted } from 'effect';

import { makeLogCapture } from '../../../test/test-support.js';
import { sessionCookieName, signSession } from '../../access/testing.js';
import { PtyService } from '../../pty-processes/index.js';
import { bootRuntime, type BootedRuntime } from './runtime-harness.js';

const signingSecret = 'test-signing-secret';
const passwordVariable = `AUTH_SERVER_TEST_PASSWORD_${process.pid}`;
const password = 'correct horse';
const launcherToken = 'launcher-token-for-tests';
const allowedOrigin = 'http://127.0.0.1:43129';
const documentBody = '<!doctype html><title>Isagi</title>';

type ErrorBody = { error: { code: string; message: string } };

let dataRoot: string;
let runtime: BootedRuntime;
const logs = makeLogCapture();

before(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'isagi-auth-server-'));
  const webRoot = join(dataRoot, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), documentBody);
  writeFileSync(join(webRoot, 'assets', 'a.js'), 'export {};');
  // The password comes from the login-shell environment, as `env.NAME` does for users.
  process.env[passwordVariable] = password;
  writeFileSync(
    join(dataRoot, 'config.yaml'),
    [
      'server:',
      '  serveWebUi: true',
      '  auth:',
      '    enabled: true',
      '    username: ada',
      `    password: env.${passwordVariable}`,
      `    signingSecret: ${signingSecret}`,
      '',
    ].join('\n'),
  );
  runtime = await bootRuntime({
    dataDirectory: dataRoot,
    allowedOrigins: [allowedOrigin],
    webRoot: { value: webRoot, source: 'flag', name: '--web-root' },
    launcherToken,
    extraLayer: logs.layer,
  });
});

after(async () => {
  await runtime?.close();
  delete process.env[passwordVariable];
  rmSync(dataRoot, { recursive: true, force: true });
});

const nowSeconds = () => Math.floor(Date.now() / 1000);
const cookieAt = (issuedAt: number) =>
  `${sessionCookieName}=${signSession(Redacted.make(signingSecret), issuedAt)}`;

function assertAuthRequired(response: { statusCode: number; body: string }, label: string) {
  assert.equal(response.statusCode, 401, label);
  assert.equal((JSON.parse(response.body) as ErrorBody).error.code, 'auth_required', label);
}

/** A real upgrade to the listening runtime: `inject` has no socket for the editor proxy to pipe. */
function rawUpgrade(path: string, headers: Record<string, string> = {}) {
  const { port } = new URL(runtime.url);
  return new Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port,
        path,
        agent: false,
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': randomBytes(16).toString('base64'),
          ...headers,
        },
      });
      request.on('upgrade', (response, socket) => {
        socket.destroy();
        resolve({ statusCode: response.statusCode ?? 0, body: '', headers: response.headers });
      });
      request.on('response', (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () =>
          resolve({ statusCode: response.statusCode ?? 0, body, headers: response.headers }),
        );
      });
      request.on('error', reject);
      request.end();
    },
  );
}

test('without credentials, the API, content, SSE, both socket families and the editor proxy answer 401 auth_required', async () => {
  for (const [method, url] of [
    ['GET', '/api/v1/workspace'],
    ['POST', '/api/v1/projects'],
    ['GET', '/api/v1/auth/session'],
    ['POST', '/api/v1/auth/logout'],
    ['GET', '/api/v1/workflows/checkpoints/1/file?path=a'],
    ['GET', '/api/v1/fluidcast-sessions/x/worker/status'],
    ['GET', '/api/v1/fluidcast-sessions/x/speech/1'],
    ['GET', '/editor/1/x'],
    ['POST', '/editor/1/x'],
  ] as const) {
    assertAuthRequired(await runtime.server.inject({ method, url }), `${method} ${url}`);
  }
  for (const path of ['/api/v1/events', '/api/v1/agent-sessions/1/attach', '/editor/1/socket']) {
    assertAuthRequired(await rawUpgrade(path), `upgrade ${path}`);
  }
});

test('health, login, static files, SPA deep paths, unmatched API paths and preflights stay open', async () => {
  assert.equal(
    (await runtime.server.inject({ method: 'GET', url: '/api/v1/health' })).statusCode,
    200,
  );
  const failedLogin = await runtime.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'nobody', password: 'nothing' },
  });
  assert.equal((failedLogin.json() as ErrorBody).error.code, 'auth_login_failed');
  for (const url of ['/', '/assets/a.js', '/deep/path', '/assets/missing.js']) {
    const page = await runtime.server.inject({ method: 'GET', url });
    assert.equal(page.statusCode, 200, url);
    assert.equal(page.body, url === '/assets/a.js' ? 'export {};' : documentBody, url);
  }
  for (const [method, url] of [
    ['GET', '/api/v1/nope'],
    ['POST', '/api/v1/nope'],
    ['DELETE', '/x'],
  ] as const) {
    const miss = await runtime.server.inject({ method, url });
    assert.equal(miss.statusCode, 404, `${method} ${url}`);
    assert.equal((miss.json() as ErrorBody).error.code, 'api_route_not_found');
  }
  const preflight = await runtime.server.inject({
    method: 'OPTIONS',
    url: '/api/v1/projects',
    headers: {
      origin: allowedOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], allowedOrigin);
});

test('a percent-encoded API path is matched and refused, never treated as a web UI path', async () => {
  for (const url of ['/%61pi/v1/workspace', '/api/v1/%77orkspace']) {
    assertAuthRequired(await runtime.server.inject({ method: 'GET', url }), url);
    // With a credential the same URL reaches the workspace route, so the refusal above was the guard's.
    const admitted = await runtime.server.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${launcherToken}` },
    });
    assert.equal(admitted.statusCode, 200, url);
    assert.ok('data' in (admitted.json() as object), url);
  }
});

test('loopback grants nothing, and a 401 to an allowed origin carries CORS headers', async () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assertAuthRequired(
      await runtime.server.inject({ method: 'GET', url: '/api/v1/workspace', headers: { host } }),
      host,
    );
  }
  const crossOrigin = await runtime.server.inject({
    method: 'GET',
    url: '/api/v1/workspace',
    headers: { origin: allowedOrigin },
  });
  assertAuthRequired(crossOrigin, 'cross-origin');
  assert.equal(crossOrigin.headers['access-control-allow-origin'], allowedOrigin);
});

test('a login sets the cookie, which admits the API and reports cookie; the launcher token reports token', async () => {
  const login = await runtime.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'ada', password },
  });
  assert.equal(login.statusCode, 200);
  assert.deepEqual(login.json().data, null);
  const setCookie = login.headers['set-cookie'];
  assert.equal(typeof setCookie, 'string');
  assert.match(
    setCookie as string,
    /^isagi_session=v1\.\d+\.[\w-]+; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/,
  );
  const cookie = (setCookie as string).split(';')[0]!;

  const workspace = await runtime.server.inject({
    method: 'GET',
    url: '/api/v1/workspace',
    headers: { cookie },
  });
  assert.equal(workspace.statusCode, 200);
  assert.equal(workspace.headers['set-cookie'], undefined, 'a fresh cookie is not renewed');
  const session = await runtime.server.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { cookie },
  });
  assert.deepEqual(session.json().data, { credential: 'cookie' });

  const bearer = { authorization: `Bearer ${launcherToken}` };
  const asToken = await runtime.server.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: bearer,
  });
  assert.deepEqual(asToken.json().data, { credential: 'token' });
  assert.equal(
    (await runtime.server.inject({ method: 'GET', url: '/api/v1/workspace', headers: bearer }))
      .statusCode,
    200,
  );
  // A bearer that matches nothing does not stop a valid cookie.
  const both = await runtime.server.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { authorization: 'Bearer wrong', cookie },
  });
  assert.deepEqual(both.json().data, { credential: 'cookie' });
  assertAuthRequired(
    await runtime.server.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: { authorization: 'Bearer ' },
    }),
    'empty bearer',
  );
});

test('a wrong password is auth_login_failed with a growing delay, and nothing secret is logged', async () => {
  const attempt = async () => {
    const started = performance.now();
    const response = await runtime.server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'ada', password: 'wrong guess' },
    });
    return { response, elapsed: performance.now() - started };
  };
  // Reset the count left by earlier tests.
  await runtime.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'ada', password },
  });
  const first = await attempt();
  const second = await attempt();
  assert.equal(first.response.statusCode, 401);
  const error = (first.response.json() as ErrorBody).error;
  assert.equal(error.code, 'auth_login_failed');
  assert.equal(error.message, 'Wrong username or password.');
  assert.equal(first.response.headers['set-cookie'], undefined);
  assert.ok(first.elapsed >= 240, `first delay ${first.elapsed}`);
  assert.ok(second.elapsed >= 490, `second delay ${second.elapsed}`);
  await runtime.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'ada', password },
  });

  assert.ok(logs.lines.some((line) => line.message === 'Runtime login is on'));
  assert.ok(logs.lines.some((line) => line.message === 'Runtime login failed'));
  const text = JSON.stringify(logs.lines);
  for (const secret of [password, 'wrong guess', signingSecret, launcherToken, 'isagi_session=']) {
    assert.ok(!text.includes(secret), secret);
  }
});

test('a cookie older than a day is renewed on HTTP replies but not on an upgrade; an expired one is refused', async () => {
  const old = cookieAt(nowSeconds() - 2 * 24 * 60 * 60);
  const renewed = await runtime.server.inject({
    method: 'GET',
    url: '/api/v1/workspace',
    headers: { cookie: old },
  });
  assert.equal(renewed.statusCode, 200);
  assert.match(String(renewed.headers['set-cookie']), /^isagi_session=v1\.\d+\./);

  const upgrade = await rawUpgrade('/api/v1/events', { cookie: old });
  assert.equal(upgrade.statusCode, 101);
  assert.equal(upgrade.headers['set-cookie'], undefined, 'a 101 never carries the renewal');

  assertAuthRequired(
    await runtime.server.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: { cookie: cookieAt(nowSeconds() - 8 * 24 * 60 * 60) },
    }),
    'expired',
  );
  assertAuthRequired(
    await runtime.server.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: {
        cookie: `${sessionCookieName}=${signSession(Redacted.make('other'), nowSeconds())}`,
      },
    }),
    'other secret',
  );
});

test('logout over an old cookie answers exactly one clearing Set-Cookie', async () => {
  const logout = await runtime.server.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { cookie: cookieAt(nowSeconds() - 2 * 24 * 60 * 60) },
  });
  assert.equal(logout.statusCode, 200);
  assert.equal(
    logout.headers['set-cookie'],
    'isagi_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
  );
});

/** Polls `condition` until it holds, or fails after `ms`. */
async function eventually(condition: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  for (let waited = 0; !(await condition()); waited += 25) {
    if (waited >= ms) assert.fail(`${label} never held`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a launched process's own token is admitted while it runs and refused once it ends", async () => {
  // A real PTY through the real launch environment: one `ProcessTokens` from the launchers to the guard.
  const out = join(dataRoot, 'process-token');
  const { ptyProcessId } = await runtime.run(
    PtyService.use((pty) =>
      pty.launch({
        command: '/bin/sh',
        args: ['-c', `printf %s "$ISAGI_RUNTIME_TOKEN" > '${out}'; exec sleep 60`],
        cwd: dataRoot,
      }),
    ),
  );
  await eventually(() => existsSync(out) && readFileSync(out, 'utf8') !== '', 'the token write');
  // Asserted by shape and status only, so a failure never prints the token.
  const token = readFileSync(out, 'utf8');
  assert.ok(/^[0-9a-f]{64}$/.test(token), 'the process received a token');
  const asProcess = () =>
    runtime.server.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: { authorization: `Bearer ${token}` },
    });
  assert.equal((await asProcess()).statusCode, 200, 'admitted while the process runs');

  await runtime.run(
    PtyService.use((pty) => pty.terminate({ ptyProcessId, gracefulTimeoutMs: 1_000 })),
  );
  await eventually(async () => (await asProcess()).statusCode === 401, 'refusal after the end');
  assertAuthRequired(await asProcess(), 'a released process token');
});
