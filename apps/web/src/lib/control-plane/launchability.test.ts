import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentHarness, ControlPlaneSnapshot, HarnessLaunchProjection } from '@isagi/contracts';

import {
  deriveStartupGate,
  editorAvailable,
  harnessLaunch,
  isTransientProvisioning,
  launchableHarnesses,
} from './launchability.js';

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
    editorProvisioning: { status: 'not_applicable' },
    ...overrides,
  };
}

function readyInventory(overrides: Partial<ReadyInventory>): ReadyInventory {
  return {
    status: 'ready',
    generation: 1,
    environment: 'trusted',
    ...overrides,
  };
}

test('deriveStartupGate routes inventory pending before every other state', () => {
  assert.equal(
    deriveStartupGate(snapshot({ inventory: { status: 'pending' } })).kind,
    'inventory_pending',
  );
});

test('deriveStartupGate routes invalid config before onboarding', () => {
  const gate = deriveStartupGate(
    snapshot({
      configStatus: 'invalid',
      configDiagnostic: 'harnesses.pi.enabled must be a boolean',
      onboardingComplete: false,
    }),
  );
  assert.deepEqual(gate, {
    kind: 'config_invalid',
    diagnostic: 'harnesses.pi.enabled must be a boolean',
  });
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

// ---------------------------------------------------------------------------
// Editor provisioning: the last gate beat, and the availability it feeds
// ---------------------------------------------------------------------------

const TRANSIENT = ['checking', 'downloading', 'verifying', 'extracting'] as const;

test('provisioning gates readiness only after inventory, config, and onboarding', () => {
  // Every earlier blocker still wins while provisioning is mid-download, which
  // is what lets a first-run user finish onboarding while the download runs.
  const downloading = { status: 'downloading', version: '4.135.0' } as const;
  assert.equal(
    deriveStartupGate(
      snapshot({ editorProvisioning: downloading, inventory: { status: 'pending' } }),
    ).kind,
    'inventory_pending',
  );
  assert.equal(
    deriveStartupGate(
      snapshot({
        editorProvisioning: downloading,
        configStatus: 'invalid',
        configDiagnostic: 'bad',
      }),
    ).kind,
    'config_invalid',
  );
  assert.equal(
    deriveStartupGate(snapshot({ editorProvisioning: downloading, onboardingComplete: false }))
      .kind,
    'onboarding',
  );
  assert.equal(
    deriveStartupGate(snapshot({ editorProvisioning: downloading })).kind,
    'editor_provisioning',
  );
});

test('every transient provisioning state gates, and carries itself to the surface', () => {
  for (const status of TRANSIENT) {
    const state = { status, version: '4.135.0' } as const;
    const gate = deriveStartupGate(snapshot({ editorProvisioning: state }));
    assert.deepEqual(gate, { kind: 'editor_provisioning', state }, status);
    assert.equal(isTransientProvisioning(state), true, status);
  }
});

test('a provisioning failure blocks readiness, because a declared capability is a promise', () => {
  const state = {
    status: 'failed',
    version: '4.135.0',
    reason: 'download_failed',
    diagnostic: 'ECONNRESET',
  } as const;
  assert.deepEqual(deriveStartupGate(snapshot({ editorProvisioning: state })), {
    kind: 'editor_provisioning',
    state,
  });
  // And it does not poll: retrying is the user's to start, and the retry
  // mutation invalidates the query itself.
  assert.equal(isTransientProvisioning(state), false);
});

test('an unprovisioned runtime and a provisioned one both reach the workspace', () => {
  // `not_applicable` is the modelled way to proceed without an editor, so an
  // external runtime is unaffected by any of this.
  assert.equal(
    deriveStartupGate(snapshot({ editorProvisioning: { status: 'not_applicable' } })).kind,
    'ready',
  );
  assert.equal(
    deriveStartupGate(snapshot({ editorProvisioning: { status: 'ready', version: '4.135.0' } }))
      .kind,
    'ready',
  );
});

test('the editor is available only when the runtime says provisioning finished', () => {
  assert.equal(
    editorAvailable(snapshot({ editorProvisioning: { status: 'ready', version: '4.135.0' } })),
    true,
  );
  assert.equal(
    editorAvailable(snapshot({ editorProvisioning: { status: 'not_applicable' } })),
    false,
  );
  for (const status of TRANSIENT) {
    assert.equal(
      editorAvailable(snapshot({ editorProvisioning: { status, version: '4.135.0' } })),
      false,
      status,
    );
  }
  assert.equal(
    editorAvailable(
      snapshot({
        editorProvisioning: {
          status: 'failed',
          version: '4.135.0',
          reason: 'unsupported_platform',
          diagnostic: null,
        },
      }),
    ),
    false,
  );
});
