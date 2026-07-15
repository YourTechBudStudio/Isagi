import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reconcileRuntimeStatus,
  type HostRuntimeStatusSnapshot,
} from '../../lib/desktop-bridge.js';
import { hostRuntimeAllowsQueries, hostRuntimeGateDecision } from './HostRuntimeGate.js';

const managedFailure = {
  protocolVersion: 1,
  revision: 4,
  ownership: 'managed',
  state: 'failed',
  reason: 'exited_after_ready',
  diagnostic: { exitCode: 7 },
} as const satisfies HostRuntimeStatusSnapshot;

test('managed terminal failure blocks stale runtime-backed workspace state', () => {
  assert.equal(hostRuntimeGateDecision(managedFailure), 'managed_failed');
});

test('external unreachable does not block the query-driven retry path', () => {
  assert.equal(
    hostRuntimeGateDecision({
      protocolVersion: 1,
      revision: 2,
      ownership: 'external',
      state: 'unreachable',
      reason: 'external_health_check_failed',
    }),
    'pass',
  );
});

test('snapshot reconciliation retains the greatest lifecycle revision', () => {
  const ready = {
    protocolVersion: 1,
    revision: 3,
    ownership: 'managed',
    state: 'ready',
  } as const satisfies HostRuntimeStatusSnapshot;
  assert.equal(reconcileRuntimeStatus(managedFailure, ready), managedFailure);
  assert.equal(reconcileRuntimeStatus(ready, managedFailure), managedFailure);
});

test('runtime-backed queries remain disabled until the host gate passes', () => {
  assert.equal(hostRuntimeAllowsQueries('connecting'), false);
  assert.equal(hostRuntimeAllowsQueries('managed_failed'), false);
  assert.equal(hostRuntimeAllowsQueries('pass'), true);
});
