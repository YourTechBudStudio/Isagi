// Isolation and injection: one app layer per registry, the same services for atoms and
// imperative edges, Reactivity key semantics, and family key semantics.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Effect, Layer } from 'effect';
import { AsyncResult, Atom, AtomRegistry, Reactivity } from 'effect/reactivity';

import type { ApiError, WorkspaceSnapshot } from '@isagi/contracts';
import { RuntimeApiError } from '@isagi/runtime-client';

import { RuntimeApi } from '../runtime/client.js';
import { query } from './policy.js';
import { appReactivityAtom, invalidateKeys, runApp, runtimeApiLayerAtom } from './runtime.js';
import { flush, makeFakeRuntimeApi, makeTestRegistry } from './testing.js';

const emptySnapshot: WorkspaceSnapshot = { projects: [] };

let workspaceReads = 0;
const workspaceAtom = query(
  () =>
    Effect.gen(function* () {
      const api = yield* RuntimeApi;
      workspaceReads++;
      return yield* api.fetchWorkspace();
    }),
  { keys: ['workspace'] },
);

test('registries are isolated: each gets its own layer, services and cache', async () => {
  let builtA = 0;
  let builtB = 0;
  const snapshotA: WorkspaceSnapshot = { projects: [] };
  const a = AtomRegistry.make({
    initialValues: [
      [
        runtimeApiLayerAtom,
        Layer.sync(RuntimeApi, () => {
          builtA++;
          return makeFakeRuntimeApi({ fetchWorkspace: () => Effect.succeed(snapshotA) });
        }),
      ],
    ],
  });
  const b = AtomRegistry.make({
    initialValues: [
      [
        runtimeApiLayerAtom,
        Layer.sync(RuntimeApi, () => {
          builtB++;
          return makeFakeRuntimeApi({ fetchWorkspace: () => Effect.succeed(emptySnapshot) });
        }),
      ],
    ],
  });
  const unmountA = a.mount(workspaceAtom);
  const unmountB = b.mount(workspaceAtom);
  await flush();
  assert.equal(AsyncResult.getOrThrow(a.get(workspaceAtom)), snapshotA);
  assert.equal(AsyncResult.getOrThrow(b.get(workspaceAtom)), emptySnapshot);
  // runApp sees the SAME RuntimeApi instance the atoms used (built once per registry).
  const fromRunApp = await runApp(
    a,
    RuntimeApi.use((api) => api.fetchWorkspace()),
  );
  assert.equal(fromRunApp, snapshotA);
  assert.equal(builtA, 1);
  assert.equal(builtB, 1);
  unmountA();
  unmountB();
  a.dispose();
  b.dispose();
});

test('Reactivity.invalidate inside runApp refreshes atoms of that registry only', async () => {
  const api = { fetchWorkspace: () => Effect.succeed(emptySnapshot) };
  const a = makeTestRegistry({ api });
  const b = makeTestRegistry({ api });
  const ua = a.mount(workspaceAtom);
  const ub = b.mount(workspaceAtom);
  await flush();
  const before = workspaceReads;
  await runApp(a, Reactivity.invalidate(['workspace']));
  await flush();
  assert.equal(workspaceReads, before + 1, 'only registry a re-read');
  // and the synchronous edge helper does the same
  invalidateKeys(b, ['workspace']);
  await flush();
  assert.equal(workspaceReads, before + 2);
  ua();
  ub();
  a.dispose();
  b.dispose();
});

test('Reactivity: flat string keys are exact; record keys are table-coarse', () => {
  const registry = makeTestRegistry();
  const reactivity = AsyncResult.getOrThrow(registry.get(appReactivityAtom));
  const hits: Array<string> = [];
  reactivity.registerUnsafe(['surface:12'], () => hits.push('flat-12'));
  reactivity.registerUnsafe({ surface: [12] }, () => hits.push('record-12'));
  reactivity.invalidateUnsafe(['surface:13']);
  assert.deepEqual(hits, [], 'flat key for 13 does not touch 12');
  reactivity.invalidateUnsafe({ surface: [13] });
  assert.deepEqual(
    hits,
    ['record-12'],
    'record invalidation of 13 hits every `surface` registration',
  );
  registry.dispose();
});

test('Atom.family compares keys with Equal: primitives and structural tuples hit, fresh objects too', () => {
  const fam = Atom.family((key: string) => Atom.make(key));
  assert.equal(fam('1:a'), fam('1:a'));
  const objFam = Atom.family((key: { readonly id: number }) => Atom.make(key.id));
  // v4 Equal is structural for plain objects: documented here so implementers know object keys
  // *work*, but Isagi still uses primitive/string keys for readability.
  assert.equal(objFam({ id: 1 }), objFam({ id: 1 }));
  // flat tuples of primitives are the sanctioned multi-part key
  const tupleFam = Atom.family((key: readonly [number, string]) => Atom.make(key[1]));
  assert.equal(tupleFam([1, 'dev']), tupleFam([1, 'dev']));
  assert.notEqual(tupleFam([1, 'dev']), tupleFam([1, 'test']));
  assert.notEqual(tupleFam([1, 'dev']), tupleFam([2, 'dev']));
});

test('a synchronous fake resolves a query on first read (static render tests need no flush)', () => {
  const snapshot: WorkspaceSnapshot = { projects: [] };
  const registry = makeTestRegistry({ api: { fetchWorkspace: () => Effect.succeed(snapshot) } });
  const atom = query(() => RuntimeApi.use((api) => api.fetchWorkspace()), { keys: [] });
  const result = registry.get(atom);
  assert.equal(result._tag, 'Success');
  assert.equal(AsyncResult.getOrThrow(result), snapshot);
  registry.dispose();
});

test('an unused fake RuntimeApi member dies naming itself', async () => {
  const registry = makeTestRegistry();
  const failure = await runApp(
    registry,
    Effect.flip(Effect.sandbox(RuntimeApi.use((api) => api.fetchWorkspace()))),
  );
  assert.match(String(failure), /RuntimeApi\.fetchWorkspace is not used/);
  registry.dispose();
});

// Imperative edges reject with the failure itself: there is no run wrapper to unwrap, so callers
// classify (`classifyRuntimeFailure`, `formatRuntimeError`) the rejection as-is.

const pathRejectedError = new RuntimeApiError({
  endpointId: 'projects.add',
  apiError: {
    code: 'project_path_rejected',
    status: 400,
    message: 'Not a Git repository: /repo/nope',
    requestId: 'req-path-rejected',
    data: { reason: 'not_git_repository', path: '/repo/nope' },
  } satisfies ApiError,
});

test('runApp rejects with the typed Effect failure', async (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());
  await assert.rejects(
    () => runApp(registry, Effect.fail(pathRejectedError)),
    (error) => error === pathRejectedError,
  );
});

test('runApp rejects with the defect when the effect dies', async (t) => {
  const registry = makeTestRegistry();
  t.after(() => registry.dispose());
  const defect = new Error('defect');
  await assert.rejects(
    () => runApp(registry, Effect.die(defect)),
    (error) => error === defect,
  );
});

test('Effect.runPromise rejects with the typed failure itself, with no wrapper to unwrap', async () => {
  const rejection = await Effect.runPromise(Effect.fail(pathRejectedError)).catch(
    (error: unknown) => error,
  );

  assert.equal(rejection, pathRejectedError);
});
