// The process token over the real HTTP client: `globalThis.fetch` is stubbed, because the CLI's
// client resolves it per request, so these runs exercise exactly what the CLI puts on the wire.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { Redacted } from 'effect';

import { resolveRuntimeToken } from './target.js';
import { onlyJsonDocument, runIsagi } from './testing/cli-harness.js';

const token = 'f'.repeat(64);
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answers every request with `response`, recording the authorization header each one carried. */
function stubRuntime(response: () => Response) {
  const authorization: (string | null)[] = [];
  globalThis.fetch = (_input, init) => {
    authorization.push(new Headers(init?.headers).get('authorization'));
    return Promise.resolve(response());
  };
  return authorization;
}

const page = () =>
  new Response(JSON.stringify({ data: { items: [], nextCursor: null }, meta: { requestId: 'r' } }));

test('resolveRuntimeToken reads ISAGI_RUNTIME_TOKEN, ignoring an unset or empty value', () => {
  const resolved = resolveRuntimeToken({ ISAGI_RUNTIME_TOKEN: token });
  assert.ok(resolved !== undefined);
  assert.equal(Redacted.value(resolved), token);
  assert.equal(String(resolved).includes(token), false, 'redacted when printed');
  assert.equal(resolveRuntimeToken({ ISAGI_RUNTIME_TOKEN: '' }), undefined);
  assert.equal(resolveRuntimeToken({}), undefined);
});

test('a client command sends the bearer whenever ISAGI_RUNTIME_TOKEN is set, whatever the target', async () => {
  const seen = stubRuntime(page);
  const fromEnv = await runIsagi(['workflows', 'runs', 'list', '--json'], {
    env: { ISAGI_RUNTIME_URL: 'http://127.0.0.1:4100', ISAGI_RUNTIME_TOKEN: token },
  });
  // A --runtime-url naming another runtime still gets the token (the story's wording).
  const fromFlag = await runIsagi(
    ['workflows', 'runs', 'list', '--json', '--runtime-url', 'http://10.0.0.5:4100'],
    { env: { ISAGI_RUNTIME_TOKEN: token } },
  );
  assert.equal(fromEnv.code, 0, fromEnv.stderr);
  assert.equal(fromFlag.code, 0, fromFlag.stderr);
  assert.deepEqual(seen, [`Bearer ${token}`, `Bearer ${token}`]);
});

test('without ISAGI_RUNTIME_TOKEN, or with it empty, no authorization header is sent', async () => {
  const seen = stubRuntime(page);
  await runIsagi(['workflows', 'runs', 'list', '--json'], {
    env: { ISAGI_RUNTIME_URL: 'http://127.0.0.1:4100' },
  });
  await runIsagi(['workflows', 'runs', 'list', '--json'], {
    env: { ISAGI_RUNTIME_URL: 'http://127.0.0.1:4100', ISAGI_RUNTIME_TOKEN: '' },
  });
  assert.deepEqual(seen, [null, null]);
});

test('auth_required carries the plain-shell recovery hint and never echoes the token', async () => {
  stubRuntime(
    () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'auth_required',
            status: 401,
            message: 'This runtime requires login.',
            requestId: 'req-401',
          },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
  );
  const env = { ISAGI_RUNTIME_URL: 'http://127.0.0.1:4100', ISAGI_RUNTIME_TOKEN: token };

  const json = await runIsagi(['workflows', 'runs', 'list', '--json'], { env });
  assert.equal(json.code, 1);
  const { error } = onlyJsonDocument(json.stdout) as {
    error: { code: string; recovery: string };
  };
  assert.equal(error.code, 'auth_required');
  assert.equal(
    error.recovery,
    'This runtime has login on. Run `isagi` inside an Isagi terminal or agent, which sets ISAGI_RUNTIME_TOKEN; a plain shell cannot call it. A terminal that outlived a runtime restart needs to be reopened.',
  );

  const plain = await runIsagi(['workflows', 'runs', 'list'], { env });
  assert.match(plain.stderr, /isagi: auth_required/);
  for (const output of [json.stdout, json.stderr, plain.stdout, plain.stderr]) {
    assert.equal(output.includes(token), false, 'the token never appears in output');
  }
});
