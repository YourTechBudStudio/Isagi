// Editor runtime state: the per-pane ensure, provisioning retry and the diagnostics family.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Effect } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type {
  ControlPlaneSnapshot,
  EditorDiagnosticsOutput,
  EnsureEditorRuntimeOutput,
  RetryEditorProvisioningOutput,
  SurfaceDetail,
} from '@isagi/contracts';
import { RuntimeTransportError } from '@isagi/runtime-client';

import { controlPlaneQuery } from '../control-plane/queries.js';
import { mutationError } from '../state/result.js';
import { advance, controllable, flush, makeTestRegistry } from '../state/testing.js';
import { surfaceDetailAtom } from '../workspace/queries.js';
import {
  editorDiagnosticsAtom,
  makeEnsureEditorRuntimeAtom,
  makeRetryEditorProvisioningAtom,
} from './queries.js';

const refused = () => new RuntimeTransportError({ endpointId: 'editor.ensure', cause: 'down' });
const detail = { id: 7 } as unknown as SurfaceDetail;
const snapshot = {} as unknown as ControlPlaneSnapshot;

test('an ensure stays pending until the surface detail re-read lands, on success and on failure', async (t) => {
  const ensures = controllable<EnsureEditorRuntimeOutput, RuntimeTransportError>();
  const details = controllable<SurfaceDetail>();
  const registry = makeTestRegistry({
    api: {
      ensureEditorRuntime: (editorContextId, input) =>
        Effect.suspend(() => {
          assert.equal(editorContextId, 3);
          assert.deepEqual(input, { intent: 'reuse' });
          return ensures.effect;
        }),
      getSurfaceDetail: (surfaceId) =>
        Effect.suspend(() => {
          assert.equal(surfaceId, 7);
          return details.effect;
        }),
    },
  });
  t.after(() => registry.dispose());
  const unmountDetail = registry.mount(surfaceDetailAtom(7));
  details.last().resolve(detail);
  await flush();

  const ensure = makeEnsureEditorRuntimeAtom(3, 7);
  const unmountEnsure = registry.mount(ensure);
  registry.set(ensure, { intent: 'reuse' });
  await flush();
  assert.equal(registry.get(ensure).waiting, true);
  ensures.last().resolve({} as EnsureEditorRuntimeOutput);
  await flush();
  assert.equal(details.calls.length, 2, 'the surface detail is re-read');
  assert.equal(registry.get(ensure).waiting, true, 'still pending while it is');
  details.last().resolve(detail);
  await flush();
  assert.equal(registry.get(ensure)._tag, 'Success');
  assert.equal(registry.get(ensure).waiting, false);

  registry.set(ensure, { intent: 'reuse' });
  await flush();
  ensures.last().reject(refused());
  await flush();
  assert.equal(details.calls.length, 3, 'a failed launch changed the record too');
  details.last().resolve(detail);
  await flush();
  assert.equal(registry.get(ensure)._tag, 'Failure');
  unmountEnsure();
  unmountDetail();
});

test('a second ensure does not abort the first request', async (t) => {
  const ensures = controllable<EnsureEditorRuntimeOutput, RuntimeTransportError>();
  const registry = makeTestRegistry({
    api: {
      ensureEditorRuntime: () => ensures.effect,
      getSurfaceDetail: () => Effect.succeed(detail),
    },
  });
  t.after(() => registry.dispose());
  const ensure = makeEnsureEditorRuntimeAtom(3, 7);
  const unmount = registry.mount(ensure);
  registry.set(ensure, { intent: 'reuse' });
  await flush();
  registry.set(ensure, { intent: 'replace' });
  await flush();
  assert.equal(ensures.calls.length, 2);
  assert.equal(ensures.calls[0]!.aborted, false, 'the first launch keeps running');
  unmount();
});

test('a provisioning retry re-reads the control plane on both outcomes', async (t) => {
  const retries = controllable<RetryEditorProvisioningOutput, RuntimeTransportError>();
  let reads = 0;
  const registry = makeTestRegistry({
    api: {
      retryEditorProvisioning: () => retries.effect,
      getControlPlane: () => Effect.sync(() => (reads++, snapshot)),
    },
  });
  t.after(() => registry.dispose());
  const unmountControlPlane = registry.mount(controlPlaneQuery);
  await flush();
  assert.equal(reads, 1);

  const retry = makeRetryEditorProvisioningAtom();
  const unmountRetry = registry.mount(retry);
  registry.set(retry, undefined);
  await flush();
  retries.last().reject(refused());
  await flush();
  assert.equal(reads, 2, 'a refused retry (e.g. editor_provisioning_busy) still re-reads');
  assert.equal(registry.get(retry)._tag, 'Failure');

  registry.set(retry, undefined);
  await flush();
  retries.last().resolve({} as RetryEditorProvisioningOutput);
  await flush();
  assert.equal(reads, 3);
  assert.equal(registry.get(retry)._tag, 'Success');
  unmountRetry();
  unmountControlPlane();
});

test('diagnostics are read per incarnation and never go stale', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const reads: Array<readonly [number, number]> = [];
  const registry = makeTestRegistry({
    api: {
      editorDiagnostics: (editorContextId, ptyProcessId) =>
        Effect.sync(() => {
          reads.push([editorContextId, ptyProcessId]);
          return { ptyProcessId } as unknown as EditorDiagnosticsOutput;
        }),
    },
  });
  t.after(() => registry.dispose());
  assert.equal(editorDiagnosticsAtom([3, 40]), editorDiagnosticsAtom([3, 40]), 'same member');
  assert.notEqual(editorDiagnosticsAtom([3, 40]), editorDiagnosticsAtom([3, 41]));

  let unmount = registry.mount(editorDiagnosticsAtom([3, 40]));
  await flush();
  unmount();
  await advance(60_000);
  unmount = registry.mount(editorDiagnosticsAtom([3, 40]));
  await flush();
  assert.deepEqual(reads, [[3, 40]], 'a dead incarnation is read once');
  unmount();

  unmount = registry.mount(editorDiagnosticsAtom([3, 41]));
  await flush();
  assert.deepEqual(reads, [
    [3, 40],
    [3, 41],
  ]);
  assert.equal(
    AsyncResult.getOrThrow(registry.get(editorDiagnosticsAtom([3, 41]))).ptyProcessId,
    41,
  );
  unmount();
});

test('an ensure failure reaches the caller as the runtime error itself', async (t) => {
  const failure = refused();
  const registry = makeTestRegistry({
    api: {
      ensureEditorRuntime: () => Effect.fail(failure),
      getSurfaceDetail: () => Effect.succeed(detail),
    },
  });
  t.after(() => registry.dispose());
  const ensure = makeEnsureEditorRuntimeAtom(3, 7);
  const unmount = registry.mount(ensure);
  registry.set(ensure, { intent: 'replace' });
  await flush();
  assert.equal(mutationError(registry.get(ensure)), failure);
  unmount();
});
