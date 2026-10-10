// Family retention: a family returns the swr VIEW, but the TTL-retained node is `cache`. Without a
// back-reference from `cache` to the view, GC can drop the family entry while the cache is still
// retained, and the next call builds a second cache (a silent cache miss).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect } from 'effect';
import { Atom } from 'effect/reactivity';

import type { WorkspaceSnapshot } from '@isagi/contracts';

import { RuntimeApi } from '../runtime/client.js';
import { query } from './policy.js';
import { flush, makeTestRegistry } from './testing.js';

const gc = (globalThis as { gc?: () => void }).gc;

test(
  'family query keeps its identity while the cache is retained (needs --expose-gc)',
  { skip: gc === undefined ? 'run node with --expose-gc' : false },
  async (t) => {
    const snapshot: WorkspaceSnapshot = { projects: [] };
    const registry = makeTestRegistry({
      api: { fetchWorkspace: () => Effect.succeed(snapshot) },
    });
    t.after(() => registry.dispose());
    const fam = Atom.family((id: number) =>
      query(() => RuntimeApi.use((api) => api.fetchWorkspace()), { keys: [`k:${id}`] }),
    );
    let unmount: (() => void) | null = registry.mount(fam(1));
    const firstCache = fam(1).cache;
    await flush();
    unmount();
    unmount = null;
    await flush();
    for (let i = 0; i < 5; i++) {
      gc!();
      await flush();
    }
    assert.equal(fam(1).cache, firstCache, 'same retained cache after GC');
  },
);
