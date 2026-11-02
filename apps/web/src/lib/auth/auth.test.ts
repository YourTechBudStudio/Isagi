// The page-level auth signal, its registry state, and the 401 detector on the runtime transport.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';

import { Effect, Layer } from 'effect';

import { RuntimeClient } from '@isagi/runtime-client';

import { fluidcastTransport } from '../fluidcast/transport.js';
import { authAwareRuntimeHttpClient, makeRuntimeApi } from '../runtime/client.js';
import { makeTestRegistry } from '../state/testing.js';
import { onAuthRequired, signalAuthRequired } from './signal.js';
import { connectAuthSignal, signedOutAtom } from './state.js';

const runtimeUrl = 'http://runtime.test';

/** Answers every request with `status`, and counts the signals raised meanwhile. */
const stubRuntime = (t: TestContext, status: number, body: unknown) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  let signals = 0;
  const off = onAuthRequired(() => {
    signals += 1;
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    off();
  });
  return { signals: () => signals };
};

const authRequired = {
  code: 'auth_required',
  status: 401,
  message: 'Sign in to use this runtime.',
  requestId: 'req-1',
};

test('connectAuthSignal turns the signal into the signed-out state, idempotently', (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());
  const disconnect = connectAuthSignal(registry);
  assert.equal(registry.get(signedOutAtom), false);
  signalAuthRequired();
  signalAuthRequired();
  assert.equal(registry.get(signedOutAtom), true);

  const other = makeTestRegistry();
  t.after(() => other.dispose());
  connectAuthSignal(other)();
  disconnect();
  signalAuthRequired();
  assert.equal(other.get(signedOutAtom), false, 'a disconnected page no longer listens');
});

test('a 401 from a RuntimeApi call raises the signal and still fails the call', async (t) => {
  const runtime = stubRuntime(t, 401, authRequired);
  const exit = await Effect.runPromiseExit(
    makeRuntimeApi(Effect.succeed(runtimeUrl)).getControlPlane(),
  );
  assert.equal(exit._tag, 'Failure');
  assert.equal(runtime.signals(), 1);
});

test('a failed login (401 auth_login_failed) raises the signal too, which the sign-in view ignores', async (t) => {
  const runtime = stubRuntime(t, 401, { ...authRequired, code: 'auth_login_failed', data: {} });
  const exit = await Effect.runPromiseExit(
    makeRuntimeApi(Effect.succeed(runtimeUrl)).signIn({ username: 'a', password: 'b' }),
  );
  assert.equal(exit._tag, 'Failure');
  assert.equal(runtime.signals(), 1);
});

test('other statuses do not raise the signal', async (t) => {
  const runtime = stubRuntime(t, 500, {
    ...authRequired,
    code: 'api_unhandled_error',
    status: 500,
  });
  await Effect.runPromiseExit(makeRuntimeApi(Effect.succeed(runtimeUrl)).getControlPlane());
  assert.equal(runtime.signals(), 0);
});

test('a 401 on the Fluidcast transport, over the auth-aware client, raises the signal', async (t) => {
  const runtime = stubRuntime(t, 401, authRequired);
  await Effect.runPromiseExit(
    Effect.gen(function* () {
      const transport = yield* fluidcastTransport({
        fluidcastSessionId: 'fc-1',
        beforeSubscribe: Effect.void,
      });
      return yield* transport.send({ _tag: 'Pause' });
    }).pipe(
      Effect.provide(
        RuntimeClient.layer(runtimeUrl).pipe(Layer.provide(authAwareRuntimeHttpClient)),
      ),
    ),
  );
  assert.equal(runtime.signals(), 1);
});

test('the Fluidcast connection provides the auth-aware client, not the bare one', () => {
  // `connection.ts` loads the Fluidcast React SDK, which node cannot import; its wiring is pinned
  // by source instead, and the transport above proves what that wiring does.
  const source = readFileSync(new URL('../fluidcast/connection.ts', import.meta.url), 'utf8');
  assert.match(source, /Layer\.provide\(authAwareRuntimeHttpClient\)/);
  assert.doesNotMatch(source, /\bRuntimeHttpClient\b/);
});
