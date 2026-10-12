// What a component sees while a query refreshes over data it already shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type { WorkspaceSnapshot } from '@isagi/contracts';
import { RuntimeTransportError } from '@isagi/runtime-client';

import { RuntimeApi } from '../runtime/client.js';
import { query } from './policy.js';
import { queryError } from './result.js';
import { controllable, flush, makeTestRegistry } from './testing.js';

const setup = (t: import('node:test').TestContext) => {
  const req = controllable<WorkspaceSnapshot, RuntimeTransportError>();
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => req.effect }, retry: false });
  t.after(() => registry.dispose());
  const atom = query(() => RuntimeApi.use((api) => api.fetchWorkspace()), {
    keys: ['workspace'],
  });
  t.after(registry.mount(atom));
  return { req, registry, atom };
};

test('a refresh keeps the previous success visible and marks it waiting', async (t) => {
  const { req, registry, atom } = setup(t);
  const first: WorkspaceSnapshot = { projects: [] };
  req.last().resolve(first);
  await flush();

  registry.refresh(atom);
  const during = registry.get(atom);
  assert.equal(during._tag, 'Success');
  assert.equal(during.waiting, true);
  assert.equal(Option.getOrUndefined(AsyncResult.value(during)), first);

  const second: WorkspaceSnapshot = { projects: [] };
  req.last().resolve(second);
  await flush();
  const after = registry.get(atom);
  assert.equal(after.waiting, false);
  assert.equal(Option.getOrUndefined(AsyncResult.value(after)), second);
});

test('a failed refresh keeps the previous success and exposes the failure', async (t) => {
  const { req, registry, atom } = setup(t);
  const first: WorkspaceSnapshot = { projects: [] };
  req.last().resolve(first);
  await flush();

  registry.refresh(atom);
  const failure = new RuntimeTransportError({ endpointId: 'workspace.get', cause: 'down' });
  req.last().reject(failure);
  await flush();

  const result = registry.get(atom);
  assert.equal(result._tag, 'Failure');
  assert.equal(result.waiting, false);
  assert.equal(queryError(result), failure, 'the failure is exposed');
  assert.equal(
    Option.getOrUndefined(AsyncResult.value(result)),
    first,
    'the previous success stays on screen',
  );
});
