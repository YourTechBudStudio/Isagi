import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Exit } from 'effect';

import { resolveRuntimeUrl, RuntimeUrlUnavailable, type RuntimeUrlSources } from './resolve.js';

const bridge = { getRuntimeUrl: () => Promise.resolve('http://127.0.0.1:58892') };
const none: RuntimeUrlSources = {
  host: undefined,
  developmentRuntimeUrl: undefined,
  pageOrigin: undefined,
};

test('the desktop bridge beats a development URL and the page origin', async () => {
  const runtimeUrl = await Effect.runPromise(
    resolveRuntimeUrl({
      host: bridge,
      developmentRuntimeUrl: 'http://stale.invalid',
      pageOrigin: 'http://127.0.0.1:4173',
    }),
  );

  assert.equal(runtimeUrl, 'http://127.0.0.1:58892');
});

test('Vite development may point at a runtime other than the page origin', async () => {
  const runtimeUrl = await Effect.runPromise(
    resolveRuntimeUrl({
      ...none,
      developmentRuntimeUrl: 'http://127.0.0.1:11299',
      pageOrigin: 'http://127.0.0.1:4173',
    }),
  );

  assert.equal(runtimeUrl, 'http://127.0.0.1:11299');
});

test('a page the runtime served uses its own origin', async () => {
  const runtimeUrl = await Effect.runPromise(
    resolveRuntimeUrl({ ...none, pageOrigin: 'https://vm.tail1234.ts.net' }),
  );

  assert.equal(runtimeUrl, 'https://vm.tail1234.ts.net');
});

test('a file: page with no bridge or development URL has no runtime', async () => {
  const exit = await Effect.runPromiseExit(resolveRuntimeUrl(none));

  assert.ok(Exit.isFailure(exit));
  const error = exit.cause.reasons.find((reason) => reason._tag === 'Fail')?.error;
  assert.ok(error instanceof RuntimeUrlUnavailable);
  assert.match(error.message, /^No runtime URL: open Isagi through the desktop app/);
});
