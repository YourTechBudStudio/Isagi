import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentHarness, ControlPlaneSnapshot, HarnessLaunchProjection } from '@isagi/contracts';

import { deriveStartupGate, harnessLaunch, launchableHarnesses } from './launchability.js';

type ReadyInventory = Extract<ControlPlaneSnapshot['inventory'], { readonly status: 'ready' }>;

function harnessEntry(harness: AgentHarness, launch: HarnessLaunchProjection) {
  return {
    harness,
    availability: 'available' as const,
    policy: { enabled: launch.status === 'launchable', installIsagiDocs: false },
    launch,
  };
}

function snapshot(overrides: Partial<ControlPlaneSnapshot> = {}): ControlPlaneSnapshot {
  return {
    onboardingComplete: true,
    configStatus: 'valid',
    configDiagnostic: null,
    policyRevision: 'rev-1',
    inventory: {
      status: 'ready',
      generation: 1,
      environment: 'trusted',
      node: 'available',
      packageManagers: { pnpm: 'available', npm: 'missing', bun: 'missing' },
    },
    harnesses: [
      harnessEntry('pi', { status: 'launchable' }),
      harnessEntry('opencode', { status: 'blocked', reason: 'harness_disabled' }),
      harnessEntry('claude', { status: 'blocked', reason: 'harness_missing' }),
      harnessEntry('codex', { status: 'blocked', reason: 'harness_disabled' }),
    ],
    reconciliation: {
      desiredFingerprint: null,
      runningFingerprint: null,
      lastCompletedFingerprint: null,
      lastAppliedFingerprint: null,
      lastResult: null,
    },
    ...overrides,
  };
}

function readyInventory(overrides: Partial<ReadyInventory>): ReadyInventory {
  return {
    status: 'ready',
    generation: 1,
    environment: 'trusted',
    node: 'available',
    packageManagers: { pnpm: 'available', npm: 'missing', bun: 'missing' },
    ...overrides,
  };
}

test('deriveStartupGate routes inventory pending before every other state', () => {
  assert.equal(
    deriveStartupGate(snapshot({ inventory: { status: 'pending' } })).kind,
    'inventory_pending',
  );
});

test('deriveStartupGate routes invalid config before the toolchain check', () => {
  const gate = deriveStartupGate(
    snapshot({
      configStatus: 'invalid',
      configDiagnostic: 'harnesses.pi.enabled must be a boolean',
      onboardingComplete: false,
      inventory: readyInventory({
        node: 'missing',
        packageManagers: { pnpm: 'missing', npm: 'missing', bun: 'missing' },
      }),
    }),
  );
  assert.deepEqual(gate, {
    kind: 'config_invalid',
    diagnostic: 'harnesses.pi.enabled must be a boolean',
  });
});

test('deriveStartupGate blocks when external Node is not available', () => {
  const gate = deriveStartupGate(snapshot({ inventory: readyInventory({ node: 'incompatible' }) }));
  assert.equal(gate.kind, 'toolchain_blocked');
  assert.equal(gate.kind === 'toolchain_blocked' && gate.node, 'incompatible');
});

test('deriveStartupGate blocks when no package manager is available', () => {
  const gate = deriveStartupGate(
    snapshot({
      inventory: readyInventory({
        packageManagers: { pnpm: 'missing', npm: 'missing', bun: 'probe_failed' },
      }),
    }),
  );
  assert.equal(gate.kind, 'toolchain_blocked');
});

test('deriveStartupGate does not treat a failed environment capture as a hard block', () => {
  const gate = deriveStartupGate(
    snapshot({ inventory: readyInventory({ environment: 'probe_failed' }) }),
  );
  assert.equal(gate.kind, 'ready');
});

test('deriveStartupGate routes onboarding when policy is absent', () => {
  assert.equal(deriveStartupGate(snapshot({ onboardingComplete: false })).kind, 'onboarding');
});

test('deriveStartupGate reaches the workspace when every gate is satisfied', () => {
  assert.equal(deriveStartupGate(snapshot()).kind, 'ready');
});

test('launchableHarnesses lists only the launchable entries', () => {
  assert.deepEqual(launchableHarnesses(snapshot()), ['pi']);
});

test('harnessLaunch reads the runtime projection for a harness', () => {
  assert.deepEqual(harnessLaunch(snapshot(), 'opencode'), {
    status: 'blocked',
    reason: 'harness_disabled',
  });
  assert.deepEqual(harnessLaunch(snapshot(), 'pi'), { status: 'launchable' });
});
