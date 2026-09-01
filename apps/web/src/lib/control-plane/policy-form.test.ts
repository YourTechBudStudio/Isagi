import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentHarness,
  ControlPlaneSnapshot,
  DocsReconciliationAction,
  DocsReconciliationResult,
  HarnessPolicy,
} from '@isagi/contracts';

import {
  buildHarnessPolicy,
  docsResultRetryable,
  onboardingDraft,
  setDocsIntent,
  setEnabled,
  SUPPORTED_HARNESSES,
} from './policy-form.js';

type Entry = { enabled: boolean; installIsagiDocs: boolean };

function policy(entries: Partial<Record<AgentHarness, Partial<Entry>>>): HarnessPolicy {
  const base: Entry = { enabled: false, installIsagiDocs: false };
  return {
    pi: { ...base, ...entries.pi },
    opencode: { ...base, ...entries.opencode },
    claude: { ...base, ...entries.claude },
    codex: { ...base, ...entries.codex },
  };
}

function snapshotWith(
  policyValue: HarnessPolicy,
  availability: Partial<
    Record<AgentHarness, ControlPlaneSnapshot['harnesses'][number]['availability']>
  > = {},
): ControlPlaneSnapshot {
  return {
    onboardingComplete: false,
    configStatus: 'valid',
    configDiagnostic: null,
    policyRevision: 'rev',
    inventory: {
      status: 'ready',
      generation: 1,
      environment: 'trusted',
    },
    harnesses: SUPPORTED_HARNESSES.map((harness) => ({
      harness,
      availability: availability[harness] ?? 'available',
      policy: policyValue[harness],
      launch: policyValue[harness].enabled
        ? { status: 'launchable' }
        : { status: 'blocked', reason: 'harness_disabled' },
    })),
    reconciliation: {
      desiredFingerprint: null,
      runningFingerprint: null,
      lastCompletedFingerprint: null,
      lastAppliedFingerprint: null,
      lastResult: null,
    },
    editorProvisioning: { status: 'not_applicable' },
  };
}

test('onboardingDraft enables detected harnesses, disables undetected, and defaults Docs to yes', () => {
  const draft = onboardingDraft(
    snapshotWith(policy({}), {
      pi: 'available',
      opencode: 'missing',
      claude: 'incompatible',
      codex: 'available',
    }),
  );
  assert.deepEqual(draft.enabled, { pi: true, opencode: false, claude: false, codex: true });
  assert.equal(draft.docsIntent, 'yes');
});

test('buildHarnessPolicy fans a yes intent to enabled harnesses and forces Docs false under disabled ones', () => {
  const draft = onboardingDraft(
    snapshotWith(policy({}), {
      pi: 'available',
      opencode: 'missing',
      claude: 'missing',
      codex: 'missing',
    }),
  );
  const built = buildHarnessPolicy(draft);
  assert.deepEqual(built.pi, { enabled: true, installIsagiDocs: true });
  assert.deepEqual(built.opencode, { enabled: false, installIsagiDocs: false });
});

test('a no intent clears Docs on every harness, enabled or not', () => {
  let draft = onboardingDraft(snapshotWith(policy({})));
  draft = setDocsIntent(draft, 'no');
  const built = buildHarnessPolicy(draft);
  for (const harness of SUPPORTED_HARNESSES) {
    assert.equal(built[harness].installIsagiDocs, false);
  }
});

test('setEnabled flips one harness and the Docs invariant follows it through build', () => {
  let draft = onboardingDraft(
    snapshotWith(policy({}), {
      pi: 'available',
      opencode: 'missing',
      claude: 'missing',
      codex: 'missing',
    }),
  );
  draft = setEnabled(draft, 'pi', false);
  draft = setEnabled(draft, 'codex', true);
  const built = buildHarnessPolicy(draft);
  assert.deepEqual(built.pi, { enabled: false, installIsagiDocs: false });
  assert.deepEqual(built.codex, { enabled: true, installIsagiDocs: true });
});

function reconciliation(actions: readonly DocsReconciliationAction[]): DocsReconciliationResult {
  return {
    outcome: 'partially_failed',
    policyRevision: 'rev',
    inventoryGeneration: 1,
    fingerprint: 'fp',
    results: actions.map((action, index) => ({
      harness: SUPPORTED_HARNESSES[index % SUPPORTED_HARNESSES.length]!,
      availability: 'available',
      action,
      reason: null,
      destination: null,
      diagnostic: null,
    })),
  };
}

test('docsResultRetryable is true only when at least one harness failed', () => {
  assert.equal(docsResultRetryable(reconciliation(['failed', 'installed'])), true);
  assert.equal(docsResultRetryable(reconciliation(['untouched', 'unchanged'])), false);
  assert.equal(docsResultRetryable(reconciliation(['installed', 'replaced'])), false);
});
