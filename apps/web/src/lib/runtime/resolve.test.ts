import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { resolveRuntimeUrl } from './resolve.js';

test('Electron runtime ownership takes precedence over a Vite browser fallback', async () => {
  const runtimeUrl = await Effect.runPromise(
    resolveRuntimeUrl({
      host: { getRuntimeUrl: () => Promise.resolve('http://127.0.0.1:58892') },
      viteRuntimeUrl: 'http://stale.invalid',
    }),
  );

  assert.equal(runtimeUrl, 'http://127.0.0.1:58892');
});

test('plain-browser development may use the Vite runtime fallback', async () => {
  const runtimeUrl = await Effect.runPromise(
    resolveRuntimeUrl({ host: undefined, viteRuntimeUrl: 'http://127.0.0.1:4173' }),
  );

  assert.equal(runtimeUrl, 'http://127.0.0.1:4173');
});
