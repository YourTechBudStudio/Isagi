import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { ControlPlaneSnapshot, DocsReconciliationResult } from '@isagi/contracts';

import { onboardingCopy } from '../../copy/index.js';
import {
  buildHarnessPolicy,
  docsResultRetryable,
  onboardingDraft,
  type PolicyDraft,
} from '../../lib/control-plane/policy-form.js';
import {
  controlPlaneQueryKey,
  useAcceptHarnessPolicyMutation,
} from '../../lib/control-plane/queries.js';
import { RuntimeApiError } from '../../lib/runtime/client.js';
import { runRuntimeEffect, unwrapRuntimeFailure } from '../../lib/runtime/run.js';
import {
  fetchControlPlane,
  formatRuntimeError,
  refreshInventory,
} from '../../lib/workspace/runtime-data.js';
import { PolicyForm } from './PolicyForm.js';
import { BootBody, BootSurface, BootTitle } from './StartupSurfaces.js';

function attentionTitle(result: DocsReconciliationResult): string {
  if (result.outcome === 'failed') return onboardingCopy.results.failedTitle;
  return onboardingCopy.results.partialTitle;
}

/**
 * First-run setup as the third boot beat: the boot surface holds its track at
 * the setup fill while the policy manifest unfolds beneath the mark.
 *
 * There is one surface for the whole flow. A fully successful save completes
 * immediately and the boot runs on into the workspace. A partial or failed
 * reconciliation stays on the SAME manifest, annotated in place — continuing
 * silently would present a degraded setup as success. Editing any line clears
 * the annotations and returns to a clean save; Retry re-runs reconciliation and
 * boots on the moment it fully succeeds. For the stop path the gate keeps this
 * mounted until `onComplete` fires — `onCommitted` holds the gate the moment a
 * policy is committed so the annotations survive the snapshot flipping to
 * "complete".
 */
export function OnboardingFlow({
  snapshot,
  onCommitted,
  onComplete,
}: {
  snapshot: ControlPlaneSnapshot;
  onCommitted: () => void;
  onComplete: () => void;
}) {
  const [draft, setDraft] = useState<PolicyDraft>(() => onboardingDraft(snapshot));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<DocsReconciliationResult | null>(null);
  const [superseded, setSuperseded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const acceptPolicy = useAcceptHarnessPolicyMutation();
  const queryClient = useQueryClient();

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const output = await acceptPolicy.mutateAsync({
        expectedPolicyRevision: snapshot.policyRevision,
        policy: buildHarnessPolicy(draft),
      });
      onCommitted();
      if (output.reconciliation.outcome === 'succeeded') {
        // Nothing needs the user's attention — the boot continues on its own.
        onComplete();
        return;
      }
      setResult(output.reconciliation);
      setSuperseded(output.disposition === 'superseded');
    } catch (caught) {
      // Every accept error keeps the manifest editable — the policy was not
      // committed. A stale-revision conflict additionally refetches so the next
      // attempt carries the current revision.
      const failure = unwrapRuntimeFailure(caught);
      if (failure instanceof RuntimeApiError && failure.apiError.code === 'harness_policy_conflict')
        void queryClient.invalidateQueries({ queryKey: controlPlaneQueryKey });
      setError(formatRuntimeError(caught));
    } finally {
      setSaving(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    setError(null);
    setSuperseded(false);
    try {
      // The policy is already committed; a retry re-runs reconciliation through a
      // fresh inventory refresh and reads the new result. It never rewrites policy.
      await runRuntimeEffect(refreshInventory());
      const fresh = await runRuntimeEffect(fetchControlPlane());
      await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKey });
      const latest = fresh.reconciliation.lastResult;
      if (latest?.outcome === 'succeeded') {
        onComplete();
        return;
      }
      if (latest) setResult(latest);
    } catch (caught) {
      setError(formatRuntimeError(caught));
    } finally {
      setRetrying(false);
    }
  };

  // Any edit under attention returns the manifest to a clean form: the
  // annotations described the save that was, not the draft that now is.
  const change = (next: PolicyDraft) => {
    if (result) {
      setResult(null);
      setSuperseded(false);
      setError(null);
    }
    setDraft(next);
  };

  const attention = result
    ? {
        result,
        superseded,
        retryable: docsResultRetryable(result),
        retrying,
        onRetry: () => void retry(),
        onComplete,
      }
    : null;

  return (
    <BootSurface
      view={{
        kind: 'setup',
        live: saving || retrying,
        whisper: attention || saving ? null : onboardingCopy.keyboardWhisper,
        stepKey: 'setup',
        children: (
          <>
            <BootTitle>
              {attention ? attentionTitle(attention.result) : onboardingCopy.title}
            </BootTitle>
            <BootBody>{attention ? onboardingCopy.results.body : onboardingCopy.body}</BootBody>
            <PolicyForm
              snapshot={snapshot}
              draft={draft}
              onChange={change}
              saving={saving}
              error={error}
              onSave={() => void save()}
              attention={attention}
            />
          </>
        ),
      }}
    />
  );
}
