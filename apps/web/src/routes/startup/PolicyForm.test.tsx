import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { AgentHarness, ControlPlaneSnapshot, HarnessLaunchProjection } from '@isagi/contracts';

import { onboardingDraft } from '../../lib/control-plane/policy-form.js';
import { PolicyForm, type PolicyProvisioningFailure } from './PolicyForm.js';

function harnessEntry(harness: AgentHarness, launch: HarnessLaunchProjection) {
  return {
    harness,
    availability: 'available' as const,
    policy: { enabled: launch.status === 'launchable', installIsagiDocs: false },
    launch,
  };
}

const snapshot: ControlPlaneSnapshot = {
  onboardingComplete: false,
  configStatus: 'valid',
  configDiagnostic: null,
  policyRevision: 'rev-1',
  inventory: { status: 'ready', generation: 1, environment: 'trusted' },
  harnesses: [
    harnessEntry('codex', { status: 'launchable' }),
    harnessEntry('claude', { status: 'launchable' }),
    harnessEntry('pi', { status: 'blocked', reason: 'harness_missing' }),
    harnessEntry('opencode', { status: 'blocked', reason: 'harness_missing' }),
  ],
  reconciliation: {
    desiredFingerprint: null,
    runningFingerprint: null,
    lastCompletedFingerprint: null,
    lastAppliedFingerprint: null,
    lastResult: null,
  },
  editorProvisioning: { status: 'not_applicable' },
};

function render(provisioning: PolicyProvisioningFailure | null): string {
  return renderToStaticMarkup(
    <PolicyForm
      snapshot={snapshot}
      draft={onboardingDraft(snapshot)}
      onChange={() => undefined}
      saving={false}
      error={null}
      onSave={() => undefined}
      provisioning={provisioning}
    />,
  );
}

const failure: PolicyProvisioningFailure = {
  line: "the editor download didn't finish. nothing was installed.",
  retryable: true,
  retrying: false,
  onRetry: () => undefined,
};

describe('PolicyForm provisioning failure', () => {
  it('says nothing at all when there is no failure to report', () => {
    // Onboarding never narrates the download. Progress the user did not ask for
    // and cannot steer has no place on a screen where they are doing something.
    const markup = render(null);
    assert.doesNotMatch(markup, /editor|download/i);
  });

  it('reports a failure as a manifest comment, not as a second surface', () => {
    const markup = render(failure);

    // The existing mechanism: a `#` comment in error tone, beside the harness
    // lines, in the manifest's own lowercase voice.
    assert.match(markup, /# the editor download didn&#x27;t finish\./);
    assert.match(markup, /text-error/);
    // No card, no border, no icon — nothing this screen did not already have.
    assert.doesNotMatch(markup, /rounded-md border|role="alert"|<svg/);
  });

  it('names its retry, because the row it joins already holds a Save', () => {
    const markup = render(failure);
    assert.match(markup, />Retry download</);
    assert.match(markup, />Save and continue</);
  });

  it('offers no retry for a failure that retrying cannot change', () => {
    const markup = render({ ...failure, retryable: false });
    assert.match(markup, /# the editor download/);
    assert.doesNotMatch(markup, />Retry download</);
  });

  it('holds the retry inert while one is running', () => {
    const markup = render({ ...failure, retrying: true });
    assert.match(markup, />Trying again…</);
  });
});
