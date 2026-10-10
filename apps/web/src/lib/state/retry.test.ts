// Retry policy: what a failing read does before the UI sees the failure.
import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import { Duration } from 'effect';

import type { WorkspaceSnapshot } from '@isagi/contracts';
import { RuntimeTransportError } from '@isagi/runtime-client';

import { RuntimeApi } from '../runtime/client.js';
import { query, type QueryPolicy } from './policy.js';
import { advance, controllable, flush, makeTestRegistry } from './testing.js';

const down = () => new RuntimeTransportError({ endpointId: 'workspace.get', cause: 'down' });

const setup = (t: TestContext, policy: Partial<QueryPolicy>) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const req = controllable<WorkspaceSnapshot, RuntimeTransportError>();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect } });
  t.after(() => registry.dispose());
  const atom = query(() => RuntimeApi.use((api) => api.fetchWorkspace()), {
    keys: ['workspace'],
    ...policy,
  });
  t.after(registry.mount(atom));
  return { req, registry, atom };
};

test('default resources retry with the baseline count and backoff before failing', async (t) => {
  // Baseline: 3 retries, delay min(1000 * 2^n, 30000) = 1 s, 2 s, 4 s; pending until the last fails.
  const { req, registry, atom } = setup(t, {});
  const delays = [1_000, 2_000, 4_000];
  req.last().reject(down());
  for (const [attempt, delay] of delays.entries()) {
    await flush();
    const pending = registry.get(atom);
    assert.equal(pending._tag, 'Initial', `still pending before retry ${attempt + 1}`);
    assert.equal(pending.waiting, true);
    await advance(delay - 1);
    assert.equal(req.calls.length, attempt + 1, `no retry ${attempt + 1} before ${delay} ms`);
    await advance(1);
    assert.equal(req.calls.length, attempt + 2, `retry ${attempt + 1} after ${delay} ms`);
    req.last().reject(down());
  }
  await flush();
  const result = registry.get(atom);
  assert.equal(result._tag, 'Failure');
  assert.equal(result.waiting, false);
  await advance(60_000);
  assert.equal(req.calls.length, 4, 'no fourth retry');
});

test('workflow resources fail on the first error', async (t) => {
  // Workflow reads: `retry: false`, `staleTime: Infinity`.
  const { req, registry, atom } = setup(t, { retry: false, staleTime: Duration.infinity });
  req.last().reject(down());
  await flush();
  const result = registry.get(atom);
  assert.equal(result._tag, 'Failure');
  assert.equal(result.waiting, false);
  await advance(60_000);
  assert.equal(req.calls.length, 1, 'never retried');
});
