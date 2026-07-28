import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { terminalSettingsDefaults } from '@isagi/contracts';

import { clientSettingsQueryKey, clientSettingsQueryOptions } from './queries.js';

test('client settings query is stable for the runtime lifetime', () => {
  const options = clientSettingsQueryOptions(() =>
    Effect.succeed({ terminal: terminalSettingsDefaults }),
  );

  assert.deepEqual(options.queryKey, clientSettingsQueryKey);
  assert.equal(options.staleTime, Infinity);
  assert.equal(options.gcTime, Infinity);
});

test('client settings query forwards cancellation to the runtime effect', async () => {
  let interrupted = false;
  const options = clientSettingsQueryOptions(() =>
    Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true)))),
  );
  const controller = new AbortController();
  assert.equal(typeof options.queryFn, 'function');
  const request = (options.queryFn as (context: unknown) => Promise<unknown>)({
    signal: controller.signal,
  });

  controller.abort();
  await assert.rejects(request);
  assert.equal(interrupted, true);
});
