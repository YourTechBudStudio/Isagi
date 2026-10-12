import { useAtom } from '@effect/atom-react';
import { Effect } from 'effect';
import { useMemo, useState } from 'react';

import type { ControlPlaneSnapshot, DocsReconciliationResult } from '@isagi/contracts';
import { RuntimeApiError } from '@isagi/runtime-client';

import { editorProvisioningCopy, onboardingCopy } from '../../copy/index.js';
import {
  buildHarnessPolicy,
  docsResultRetryable,
  onboardingDraft,
  type PolicyDraft,
} from '../../lib/control-plane/policy-form.js';
import { acceptHarnessPolicy, controlPlaneQuery } from '../../lib/control-plane/queries.js';
import { editorProvisioningManifestLine } from '../../lib/editor/provisioning.js';
import { makeRetryEditorProvisioningAtom } from '../../lib/editor/queries.js';
import { keys } from '../../lib/state/keys.js';
import { refreshAndRead } from '../../lib/state/policy.js';
import { useAppRun, useRegistry } from '../../lib/state/registry.js';
import { mutationError } from '../../lib/state/result.js';
import { invalidateKeys } from '../../lib/state/runtime.js';
import { formatRuntimeError, refreshInventory } from '../../lib/workspace/runtime-data.js';
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
  const retryProvisioningAtom = useMemo(makeRetryEditorProvisioningAtom, []);
  const [retryProvisioning, runRetryProvisioning] = useAtom(retryProvisioningAtom);
  const retryProvisioningError = mutationError(retryProvisioning);

  const registry = useRegistry();
  const app = useAppRun();

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const output = await app(
        acceptHarnessPolicy({
          expectedPolicyRevision: snapshot.policyRevision,
          policy: buildHarnessPolicy(draft),
        }),
      );
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
      if (caught instanceof RuntimeApiError && caught.apiError.code === 'harness_policy_conflict')
        invalidateKeys(registry, [keys.controlPlane]);
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
      // The read begins after the refresh, so it reflects that reconciliation, and it is
      // the cached snapshot's own re-read, so the gate sees the same result.
      const fresh = await app(
        Effect.andThen(refreshInventory(), refreshAndRead(controlPlaneQuery)),
      );
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

  // Onboarding hears about a provisioning *failure* only — never the download's
  // progress. Background work the user did not ask for and cannot steer has no
  // business interrupting the screen where they are configuring something else.
  // The line is null for every transient state, which is what makes this safe to
  // read unconditionally.
  const provisioningLine = editorProvisioningManifestLine(snapshot.editorProvisioning);
  const provisioning =
    provisioningLine !== null && snapshot.editorProvisioning.status === 'failed'
      ? {
          line: provisioningLine,
          retryable: editorProvisioningCopy.retryable[snapshot.editorProvisioning.reason],
          retrying: retryProvisioning.waiting,
          // A retry that never reached the runtime leaves the projection exactly
          // as it was, so the button would look inert. The fn atom's own error
          // is the only record of it.
          retryError:
            retryProvisioningError === null ? null : formatRuntimeError(retryProvisioningError),
          onRetry: () => runRetryProvisioning(),
        }
      : null;

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
              provisioning={provisioning}
            />
          </>
        ),
      }}
    />
  );
}
