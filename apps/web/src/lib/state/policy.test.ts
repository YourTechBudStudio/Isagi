// The freshness policy, with simulated time, focus and reconnect.
import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import { Duration, Effect } from 'effect';
import { AsyncResult, type AtomRegistry } from 'effect/reactivity';

import type { WorkspaceSnapshot } from '@isagi/contracts';
import { RuntimeTransportError } from '@isagi/runtime-client';

import { RuntimeApi } from '../runtime/client.js';
import {
  observe,
  pollWhile,
  query,
  type QueryPolicy,
  refreshAndRead,
  revalidate,
  revalidationSignalAtom,
} from './policy.js';
import { invalidateKeys, runApp } from './runtime.js';
import { advance, controllable, flush, makeTestRegistry } from './testing.js';

const setup = (t: TestContext) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.after(() => mock.timers.reset());
};
const dispose = (t: TestContext, registry: AtomRegistry.AtomRegistry) =>
  t.after(() => registry.dispose());
const focus = (registry: AtomRegistry.AtomRegistry) =>
  registry.update(revalidationSignalAtom, (n) => n + 1);

const down = () => new RuntimeTransportError({ endpointId: 'workspace.get', cause: 'down' });
const snapshot = (): WorkspaceSnapshot => ({ projects: [] });
const workspaceRead = () => controllable<WorkspaceSnapshot, RuntimeTransportError>();

// One query definition per test, so atom identity (and so node state) is fresh.
const workspaceQuery = (policy: Partial<QueryPolicy> = {}) =>
  query(() => RuntimeApi.use((api) => api.fetchWorkspace()), { keys: ['workspace'], ...policy });

test('10 s stale: remount within window reuses, after window shows previous data while refetching', async (t) => {
  setup(t);
  const req = workspaceRead();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect } });
  dispose(t, registry);
  const atom = workspaceQuery();
  let unmount = registry.mount(atom);
  assert.equal(registry.get(atom)._tag, 'Initial');
  assert.equal(registry.get(atom).waiting, true, 'isLoading');
  req.last().resolve(snapshot());
  await flush();
  assert.equal(registry.get(atom)._tag, 'Success');
  unmount();
  await advance(5_000);
  unmount = registry.mount(atom);
  await flush();
  assert.equal(req.calls.length, 1, 'fresh: no refetch on remount');
  unmount();
  await advance(6_000);
  unmount = registry.mount(atom);
  await flush();
  assert.equal(req.calls.length, 2, 'stale: refetch on remount');
  const during = registry.get(atom);
  assert.equal(during._tag, 'Success', 'previous data kept');
  assert.equal(during.waiting, true, 'isFetching');
  req.last().resolve(snapshot());
  await flush();
  assert.equal(registry.get(atom).waiting, false);
  unmount();
});

test('focus/reconnect signal revalidates only when stale', async (t) => {
  setup(t);
  const req = workspaceRead();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect } });
  dispose(t, registry);
  const atom = workspaceQuery();
  const unmount = registry.mount(atom);
  req.last().resolve(snapshot());
  await flush();
  focus(registry);
  await flush();
  assert.equal(req.calls.length, 1, 'fresh: focus ignored');
  await advance(10_001);
  focus(registry);
  await flush();
  assert.equal(req.calls.length, 2, 'stale: focus revalidates');
  unmount();
});

test('retry: three retries at 1s, 2s, 4s while pending; error only after the last', async (t) => {
  setup(t);
  const req = workspaceRead();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect } });
  dispose(t, registry);
  const atom = workspaceQuery();
  const unmount = registry.mount(atom);
  req.last().reject(down());
  await flush();
  assert.equal(registry.get(atom)._tag, 'Initial', 'still pending during retries');
  await advance(999);
  assert.equal(req.calls.length, 1);
  await advance(1);
  assert.equal(req.calls.length, 2, 'retry 1 at 1s');
  req.last().reject(down());
  await advance(2_000);
  assert.equal(req.calls.length, 3, 'retry 2 at +2s');
  req.last().reject(down());
  await advance(4_000);
  assert.equal(req.calls.length, 4, 'retry 3 at +4s');
  req.last().reject(down());
  await flush();
  const result = registry.get(atom);
  assert.equal(result._tag, 'Failure');
  assert.equal(result.waiting, false);
  unmount();
});

test('retry: false fails on first error', async (t) => {
  setup(t);
  const req = workspaceRead();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect } });
  dispose(t, registry);
  const atom = workspaceQuery({ retry: false, staleTime: Duration.infinity });
  const unmount = registry.mount(atom);
  req.last().reject(down());
  await flush();
  assert.equal(registry.get(atom)._tag, 'Failure');
  unmount();
  await flush();
  // An infinite staleTime still re-reads a failed query on the next mount (no data -> fetch on mount).
  const again = registry.mount(atom);
  await flush();
  assert.equal(req.calls.length, 2);
  again();
});

test('idle TTL 5 min: retained while idle, dropped after', async (t) => {
  setup(t);
  const req = workspaceRead();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect } });
  dispose(t, registry);
  const atom = workspaceQuery({ staleTime: Duration.infinity });
  let unmount = registry.mount(atom);
  req.last().resolve(snapshot());
  await flush();
  unmount();
  await advance(4 * 60_000);
  unmount = registry.mount(atom);
  await flush();
  assert.equal(registry.get(atom)._tag, 'Success', 'retained');
  assert.equal(req.calls.length, 1);
  unmount();
  await advance(5 * 60_000 + 2_000);
  unmount = registry.mount(atom);
  await flush();
  assert.equal(registry.get(atom)._tag, 'Initial', 'collected, so a fresh load');
  assert.equal(req.calls.length, 2);
  unmount();
});

test('invalidation: observed refetches now (interrupting the in-flight read); unobserved is only marked stale', async (t) => {
  setup(t);
  const req = workspaceRead();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect } });
  dispose(t, registry);
  const atom = workspaceQuery();
  let unmount = registry.mount(atom);
  const first = req.last();
  invalidateKeys(registry, ['workspace']);
  await flush();
  assert.equal(first.aborted, true, 'in-flight read interrupted (cancelQueries)');
  assert.equal(req.calls.length, 2);
  first.resolve(snapshot()); // a late answer from the aborted read is ignored
  req.last().resolve(snapshot());
  await flush();
  unmount();
  await flush();
  invalidateKeys(registry, ['workspace']);
  await flush();
  assert.equal(req.calls.length, 2, 'nobody watching: no request');
  unmount = registry.mount(atom);
  await flush();
  assert.equal(req.calls.length, 3, 'remount within 10s still refetches: it was marked stale');
  assert.equal(registry.get(atom)._tag, 'Success', 'with previous data while it does');
  unmount();
});

test('invalidation: two observed queries on one key each refetch once', async (t) => {
  let reads = 0;
  const first = query(() => Effect.sync(() => ++reads), { keys: ['shared'] });
  const second = query(() => Effect.sync(() => ++reads), { keys: ['shared'] });
  const registry = makeTestRegistry();
  dispose(t, registry);
  t.after(registry.mount(first));
  t.after(registry.mount(second));
  await flush();
  assert.equal(reads, 2);
  invalidateKeys(registry, ['shared']);
  await flush();
  assert.equal(reads, 4, 'each query read once more, and the invalidation ended');
  invalidateKeys(registry, ['shared']);
  await flush();
  assert.equal(reads, 6, 'the rebuilt nodes still answer the next invalidation');
});

test('refreshAndRead: cancel the in-flight read, await a read that began after the call', async (t) => {
  setup(t);
  const req = workspaceRead();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect } });
  dispose(t, registry);
  const atom = workspaceQuery();
  const unmount = registry.mount(atom);
  const older = req.last(); // e.g. a focus refetch already on the wire
  const pending = runApp(registry, refreshAndRead(atom));
  await flush();
  assert.equal(older.aborted, true);
  older.resolve(snapshot());
  const fresh = snapshot();
  req.last().resolve(fresh);
  assert.equal(await pending, fresh);
  unmount();
});

test('refreshAndRead surfaces a failed fresh read as a failure (not stale success)', async (t) => {
  setup(t);
  const req = workspaceRead();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect } });
  dispose(t, registry);
  const atom = workspaceQuery({ retry: false });
  const unmount = registry.mount(atom);
  req.last().resolve(snapshot());
  await flush();
  const pending = runApp(registry, refreshAndRead(atom)).then(
    () => 'ok',
    () => 'failed',
  );
  await flush();
  req.last().reject(down());
  assert.equal(await pending, 'failed');
  unmount();
});

test('conditional polling: 1 s while pending, stops when settled', async (t) => {
  setup(t);
  let reads = 0;
  const registry = makeTestRegistry();
  dispose(t, registry);
  const base = query(() => Effect.sync(() => ({ pending: ++reads < 3 })), {
    keys: ['control-plane'],
  });
  const atom = pollWhile(base, (result) =>
    AsyncResult.isSuccess(result) && result.value.pending ? Duration.seconds(1) : null,
  );
  const unmount = registry.mount(atom);
  await flush();
  assert.equal(reads, 1);
  await advance(1_000);
  assert.equal(reads, 2);
  await advance(1_000);
  assert.equal(reads, 3);
  await advance(5_000);
  assert.equal(reads, 3, 'settled: no more polling');
  unmount();
});

test('per-observer view: staleTime 0 revalidates on each mount and polls every 10 s; shared base', async (t) => {
  setup(t);
  let reads = 0;
  const registry = makeTestRegistry({
    api: { fetchWorkspace: () => Effect.sync(() => (reads++, snapshot())) },
  });
  dispose(t, registry);
  const shared = workspaceQuery();
  const palette = observe(shared, { staleTime: 0, pollEvery: Duration.seconds(10) });
  const drawer = registry.mount(shared);
  await flush();
  assert.equal(reads, 1);
  let open = registry.mount(palette);
  await flush();
  assert.equal(reads, 2, "palette open starts a read even though the drawer's data is fresh");
  await advance(10_000);
  assert.equal(reads, 3, 'polls while open');
  open();
  await advance(30_000);
  assert.equal(reads, 3, 'no poll once closed');
  open = registry.mount(palette);
  await flush();
  assert.equal(reads, 4);
  open();
  drawer();
});

test('setQueryData equivalent: a write patches a Success in place', async (t) => {
  setup(t);
  const registry = makeTestRegistry({
    api: { fetchWorkspace: () => Effect.sync(snapshot) },
  });
  dispose(t, registry);
  const atom = workspaceQuery();
  const unmount = registry.mount(atom);
  await flush();
  const patched = snapshot();
  registry.set(atom, () => patched);
  assert.equal(AsyncResult.getOrThrow(registry.get(atom)), patched);
  unmount();
});

test('revalidate: observed -> refetch and await; unobserved -> stale mark only', async (t) => {
  const req = workspaceRead();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect }, retry: false });
  dispose(t, registry);
  const atom = workspaceQuery();
  const unmount = registry.mount(atom);
  req.last().resolve(snapshot());
  await flush();
  let done = false;
  const pending = runApp(registry, revalidate(atom)).then(() => {
    done = true;
  });
  await flush();
  assert.equal(req.calls.length, 2);
  assert.equal(done, false, 'waits for the refetch');
  req.last().reject(down());
  await pending;
  assert.equal(done, true, 'the refetch failure is swallowed');
  unmount();
  const other = workspaceQuery();
  const readsBefore = req.calls.length;
  await runApp(registry, revalidate(other));
  assert.equal(req.calls.length, readsBefore, 'nothing watching: no request');
});

test('registry-level retry off (tests/fixtures): first failure surfaces', async (t) => {
  const req = workspaceRead();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect }, retry: false });
  dispose(t, registry);
  const atom = workspaceQuery();
  const unmount = registry.mount(atom);
  req.last().reject(down());
  await flush();
  assert.equal(registry.get(atom)._tag, 'Failure');
  unmount();
});
