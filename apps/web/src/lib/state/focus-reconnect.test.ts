// Revalidation on focus and reconnect, driven through the browser events `main.tsx` connects.
import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import { Duration, Effect } from 'effect';
import type { AtomRegistry } from 'effect/reactivity';

import type { WorkspaceSnapshot } from '@isagi/contracts';

import { RuntimeApi } from '../runtime/client.js';
import { connectBrowserRevalidation, query, type QueryPolicy } from './policy.js';
import { advance, flush, makeTestRegistry } from './testing.js';

/** A stand-in `window`: visibility is a flag the test flips, events are dispatched by hand. */
const fakeWindow = () => {
  const target = new EventTarget();
  let visible = true;
  return {
    target,
    isVisible: () => visible,
    hide: () => {
      visible = false;
      target.dispatchEvent(new Event('visibilitychange'));
    },
    show: () => {
      visible = true;
      target.dispatchEvent(new Event('visibilitychange'));
    },
    online: () => target.dispatchEvent(new Event('online')),
  };
};

const setup = (t: TestContext) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  let reads = 0;
  const registry = makeTestRegistry({
    api: {
      fetchWorkspace: () =>
        Effect.sync((): WorkspaceSnapshot => {
          reads++;
          return { projects: [] };
        }),
    },
  });
  t.after(() => registry.dispose());
  const browser = fakeWindow();
  t.after(connectBrowserRevalidation(registry, browser.target, browser.isVisible));
  return { registry, browser, reads: () => reads };
};

const mounted = (
  t: TestContext,
  registry: AtomRegistry.AtomRegistry,
  policy: Partial<QueryPolicy>,
) => {
  const atom = query(() => RuntimeApi.use((api) => api.fetchWorkspace()), {
    keys: ['workspace'],
    ...policy,
  });
  t.after(registry.mount(atom));
  return atom;
};

test('a stale resource refreshes once when visibility returns; a fresh one does not', async (t) => {
  const { registry, browser, reads } = setup(t);
  mounted(t, registry, {});
  await flush();
  assert.equal(reads(), 1);

  browser.hide();
  browser.show();
  await flush();
  assert.equal(reads(), 1, 'fresh: regaining visibility does not refetch');

  await advance(10_001);
  browser.hide();
  await flush();
  assert.equal(reads(), 1, 'becoming hidden never refetches');
  browser.show();
  await flush();
  assert.equal(reads(), 2, 'stale: regaining visibility refetches');
  browser.hide();
  browser.show();
  await flush();
  assert.equal(reads(), 2, 'once: the refetch made it fresh again');
});

test('coming online refreshes resources that opt into reconnect refresh', async (t) => {
  const { registry, browser, reads } = setup(t);
  mounted(t, registry, {});
  await flush();
  browser.online();
  await flush();
  assert.equal(reads(), 1, 'fresh: coming online does not refetch');
  await advance(10_001);
  browser.online();
  await flush();
  assert.equal(reads(), 2, 'stale: coming online refetches');
});

test('resources with infinite staleTime never refresh on focus', async (t) => {
  const { registry, browser, reads } = setup(t);
  mounted(t, registry, { staleTime: Duration.infinity, retry: false });
  await flush();
  await advance(60 * 60_000);
  browser.hide();
  browser.show();
  browser.online();
  await flush();
  assert.equal(reads(), 1);
});
