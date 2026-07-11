import type {
  AgentHarness,
  ControlPlaneSnapshot,
  DocsReconciliationResult,
  HarnessPolicy,
} from '@isagi/contracts';

// State math for the first-run harness-policy manifest, pure and tested. The
// Docs invariant is the subtle part: `installIsagiDocs` must be false whenever a
// harness is disabled. Policy is edited here exactly once (onboarding); later
// changes go through the settings surface (see the project-settings milestone),
// so there is no "preserve existing values" mode anymore.

export const SUPPORTED_HARNESSES = [
  'pi',
  'opencode',
  'claude',
  'codex',
] as const satisfies readonly AgentHarness[];

// The global isagi-docs skill control: one yes/no fanned out to every enabled
// harness on submit.
export type DocsIntent = 'yes' | 'no';

export interface PolicyDraft {
  readonly enabled: Readonly<Record<AgentHarness, boolean>>;
  readonly docsIntent: DocsIntent;
}

// Onboarding: detected harnesses default on, undetected off, Docs default yes —
// there is no prior policy to preserve.
export function onboardingDraft(snapshot: ControlPlaneSnapshot): PolicyDraft {
  return {
    enabled: draftEnabled((harness) => availabilityOf(snapshot, harness) === 'available'),
    docsIntent: 'yes',
  };
}

export function setEnabled(
  draft: PolicyDraft,
  harness: AgentHarness,
  enabled: boolean,
): PolicyDraft {
  return { ...draft, enabled: { ...draft.enabled, [harness]: enabled } };
}

export function setDocsIntent(draft: PolicyDraft, intent: DocsIntent): PolicyDraft {
  return { ...draft, docsIntent: intent };
}

export function buildHarnessPolicy(draft: PolicyDraft): HarnessPolicy {
  const entries = SUPPORTED_HARNESSES.map((harness) => {
    const enabled = draft.enabled[harness];
    // Invariant: Docs is false under a disabled harness.
    return [harness, { enabled, installIsagiDocs: enabled && draft.docsIntent === 'yes' }] as const;
  });
  return Object.fromEntries(entries) as HarnessPolicy;
}

// Retry is offered only when at least one harness genuinely failed. `unsupported`
// (a capability limit) and `untouched` (not requested) can never be repaired by
// repeating the reconciliation.
export function docsResultRetryable(result: DocsReconciliationResult): boolean {
  return result.results.some((entry) => entry.action === 'failed');
}

function draftEnabled(
  predicate: (harness: AgentHarness) => boolean,
): Record<AgentHarness, boolean> {
  return Object.fromEntries(
    SUPPORTED_HARNESSES.map((harness) => [harness, predicate(harness)]),
  ) as Record<AgentHarness, boolean>;
}

function availabilityOf(snapshot: ControlPlaneSnapshot, harness: AgentHarness) {
  return snapshot.harnesses.find((entry) => entry.harness === harness)?.availability ?? 'missing';
}
