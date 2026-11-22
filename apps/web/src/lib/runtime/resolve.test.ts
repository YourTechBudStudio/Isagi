import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Exit } from 'effect';

import { resolveRuntimeUrl, RuntimeUrlUnavailable } from './resolve.js';

test('the page origin is the runtime, wherever the runtime served it', async () => {
  for (const origin of ['https://vm.tail1234.ts.net', 'http://127.0.0.1:58892']) {
    assert.equal(await Effect.runPromise(resolveRuntimeUrl({ pageOrigin: origin })), origin);
  }
});

test('the page is read when no sources are given', async (t) => {
  Object.assign(globalThis, {
    window: { location: { protocol: 'http:', origin: 'http://127.0.0.1:4173' } },
  });
  t.after(() => Reflect.deleteProperty(globalThis, 'window'));
  assert.equal(await Effect.runPromise(resolveRuntimeUrl()), 'http://127.0.0.1:4173');
});

test('a page not served over http(s) has no runtime', async () => {
  const exit = await Effect.runPromiseExit(resolveRuntimeUrl({ pageOrigin: undefined }));

  assert.ok(Exit.isFailure(exit));
  const error = exit.cause.reasons.find((reason) => reason._tag === 'Fail')?.error;
  assert.ok(error instanceof RuntimeUrlUnavailable);
  assert.match(error.message, /^No runtime URL: open Isagi from the runtime's own address/);
});
