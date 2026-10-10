// The control-plane read: the gate's conditional polling and the policy commit's re-read.
import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import { Duration, Effect, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import type {
  AcceptHarnessPolicyOutput,
  ControlPlaneSnapshot,
  EditorProvisioningState,
} from '@isagi/contracts';

import { runApp } from '../state/runtime.js';
import { advance, controllable, flush, makeTestRegistry } from '../state/testing.js';
import {
  acceptHarnessPolicy,
  controlPlaneAtom,
  controlPlanePollInterval,
  controlPlaneQuery,
} from './queries.js';

const useMockTime = (t: TestContext) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.after(() => mock.timers.reset());
};

function snapshot(
  overrides: {
    readonly inventoryPending?: boolean;
    readonly editorProvisioning?: EditorProvisioningState;
  } = {},
): ControlPlaneSnapshot {
  return {
    onboardingComplete: true,
    configStatus: 'valid',
    configDiagnostic: null,
    policyRevision: 'rev-1',
    inventory: overrides.inventoryPending
      ? { status: 'pending' }
      : { status: 'ready', generation: 1, environment: 'trusted' },
    harnesses: [],
    reconciliation: {
      desiredFingerprint: null,
      runningFingerprint: null,
      lastCompletedFingerprint: null,
      lastAppliedFingerprint: null,
      lastResult: null,
    },
    editorProvisioning: overrides.editorProvisioning ?? { status: 'not_applicable' },
  };
}

const millis = (interval: Duration.Duration | null) =>
  interval === null ? null : Duration.toMillis(interval);

test('the gate polls every second only while inventory or editor provisioning is still working', () => {
  assert.equal(millis(controlPlanePollInterval(AsyncResult.initial(true))), null, 'no snapshot');
  assert.equal(
    millis(controlPlanePollInterval(AsyncResult.success(snapshot({ inventoryPending: true })))),
    1_000,
  );
  assert.equal(
    millis(
      controlPlanePollInterval(
        AsyncResult.success(
          snapshot({ editorProvisioning: { status: 'downloading', version: '1.0.0' } }),
        ),
      ),
    ),
    1_000,
  );
  assert.equal(
    millis(
      controlPlanePollInterval(
        AsyncResult.success(
          snapshot({
            editorProvisioning: {
              status: 'failed',
              version: '1.0.0',
              reason: 'download_failed',
              diagnostic: null,
            },
          }),
        ),
      ),
    ),
    null,
    'a failed provisioning waits for the user',
  );
  assert.equal(millis(controlPlanePollInterval(AsyncResult.success(snapshot()))), null, 'settled');
});

test('the decision reads the last snapshot under a failed refetch', () => {
  const failedOverPending = AsyncResult.failWithPrevious<ControlPlaneSnapshot, Error>(
    new Error('down'),
    { previous: Option.some(AsyncResult.success(snapshot({ inventoryPending: true }))) },
  );
  assert.equal(millis(controlPlanePollInterval(failedOverPending)), 1_000);
});

test('StartupGate polling stops once the gate settles', async (t) => {
  useMockTime(t);
  const answers = [
    snapshot({ inventoryPending: true }),
    snapshot({ editorProvisioning: { status: 'downloading', version: '1.0.0' } }),
    snapshot(),
  ];
  let reads = 0;
  const registry = makeTestRegistry({
    api: { getControlPlane: () => Effect.sync(() => answers[Math.min(reads++, 2)]!) },
  });
  t.after(() => registry.dispose());

  const unmount = registry.mount(controlPlaneAtom);
  await flush();
  assert.equal(reads, 1);
  await advance(1_000);
  assert.equal(reads, 2, 'inventory pending: polled after 1 s');
  await advance(1_000);
  assert.equal(reads, 3, 'provisioning working: polled after 1 s');
  await advance(9_000);
  assert.equal(reads, 3, 'settled: no more polling');
  unmount();
});

test('a policy commit answers only after the control plane has been re-read', async (t) => {
  const reads = controllable<ControlPlaneSnapshot>();
  const output = { disposition: 'applied' } as unknown as AcceptHarnessPolicyOutput;
  const registry = makeTestRegistry({
    api: {
      getControlPlane: () => reads.effect,
      acceptHarnessPolicy: () => Effect.succeed(output),
    },
  });
  t.after(() => registry.dispose());
  const unmount = registry.mount(controlPlaneQuery);
  reads.last().resolve(snapshot());
  await flush();

  let answered: AcceptHarnessPolicyOutput | null = null;
  const commit = runApp(
    registry,
    acceptHarnessPolicy({ expectedPolicyRevision: 'rev-1', policy: {} as never }),
  ).then((value) => {
    answered = value;
  });
  await flush();
  assert.equal(reads.calls.length, 2, 'the commit re-reads the control plane');
  assert.equal(answered, null, 'and waits for that read');
  reads.last().resolve(snapshot());
  await commit;
  assert.equal(answered, output);
  unmount();
});
