import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { Effect } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import { terminalSettingsDefaults } from '@isagi/contracts';

import { revalidationSignalAtom } from '../state/policy.js';
import { advance, controllable, flush, makeTestRegistry } from '../state/testing.js';
import { clientSettingsAtom } from './queries.js';

test('the client settings atom is read once and kept for the app session', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  let reads = 0;
  const registry = makeTestRegistry({
    api: {
      fetchClientSettings: () =>
        Effect.sync(() => (reads++, { terminal: terminalSettingsDefaults })),
    },
  });
  t.after(() => registry.dispose());

  let unmount = registry.mount(clientSettingsAtom);
  await flush();
  unmount();
  await advance(60 * 60_000);
  registry.update(revalidationSignalAtom, (n) => n + 1);
  unmount = registry.mount(clientSettingsAtom);
  await flush();
  assert.equal(reads, 1, 'never stale, never collected');
  assert.deepEqual(AsyncResult.getOrThrow(registry.get(clientSettingsAtom)), {
    terminal: terminalSettingsDefaults,
  });
  unmount();
});

test('a refreshed client settings read cancels the one in flight', async (t) => {
  const reads = controllable<{ readonly terminal: typeof terminalSettingsDefaults }>();
  const registry = makeTestRegistry({ api: { fetchClientSettings: () => reads.effect } });
  t.after(() => registry.dispose());
  const unmount = registry.mount(clientSettingsAtom);
  await flush();
  registry.refresh(clientSettingsAtom);
  await flush();
  assert.equal(reads.calls.length, 2);
  assert.equal(reads.calls[0]!.aborted, true);
  unmount();
});
