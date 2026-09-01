import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import type {
  AgentHarness,
  ControlPlaneSnapshot,
  DocsHarnessResult,
  DocsReconciliationResult,
} from '@isagi/contracts';

import { Button } from '../../components/Button.js';
import { docsResultCopy, editorProvisioningCopy, onboardingCopy } from '../../copy/index.js';
import {
  setDocsIntent,
  setEnabled,
  SUPPORTED_HARNESSES,
  type PolicyDraft,
} from '../../lib/control-plane/policy-form.js';

// The onboarding manifest: mono config-file lines inside the boot column. Each
// line is one whole click target — bracket toggle, lowercase harness name
// (config-land uses the config ids, not display labels), dotted leader, then
// detection state. Keyboard is first-class: ↑↓ roves focus between lines, space
// flips the focused bracket (native button activation), and enter saves from
// anywhere in the manifest.
//
// There is no separate results screen. When a save's reconciliation needs
// attention (partial or failed — success boots straight on), the SAME manifest
// stays up, annotated in place: outcome stamps replace the detection state on
// the leader and failure reasons land as `#` comments under their lines. The
// lines stay togglable; the owner clears the annotations on any edit, which
// returns the manifest to a clean save.

/**
 * A provisioning failure, said in the manifest's own voice.
 *
 * Onboarding reports the *failure* only, never the download's progress: work the
 * user did not ask for and cannot steer does not get to interrupt setup. And it
 * says so through the machinery already here — a `#` comment and a button in the
 * existing row — rather than introducing a second kind of surface on a screen
 * that is deliberately one config file.
 */
export interface PolicyProvisioningFailure {
  /** Lowercase manifest phrasing; the component adds the leading `#`. */
  readonly line: string;
  readonly retryable: boolean;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}

/** A needs-attention reconciliation layered onto the manifest after a save. */
export interface PolicyAttention {
  readonly result: DocsReconciliationResult;
  readonly superseded: boolean;
  readonly retryable: boolean;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly onComplete: () => void;
}

function ManifestComment({
  tone = 'subtle',
  children,
}: {
  tone?: 'subtle' | 'error' | 'amber';
  children: ReactNode;
}) {
  const color =
    tone === 'error' ? 'text-error' : tone === 'amber' ? 'text-amber/85' : 'text-fg-subtle/80';
  return <p className={`pl-9 font-mono text-[11px] leading-relaxed ${color}`}># {children}</p>;
}

function Leader() {
  return (
    <span
      aria-hidden="true"
      className="flex-1 -translate-y-0.75 border-b border-dotted border-line/35"
    />
  );
}

function stampClass(action: DocsHarnessResult['action']): string {
  if (action === 'failed') return 'text-error';
  if (action === 'untouched') return 'text-fg-subtle';
  return 'text-green/78';
}

const LINE_CLASS =
  'flex w-full items-baseline gap-2.5 rounded-sm px-1 py-1 text-left font-mono text-[12.5px] transition duration-micro ease-expo outline-none hover:bg-white/4 focus-visible:bg-white/6 disabled:opacity-60';

export function PolicyForm({
  snapshot,
  draft,
  onChange,
  saving,
  error,
  onSave,
  attention = null,
  provisioning = null,
}: {
  snapshot: ControlPlaneSnapshot;
  draft: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  attention?: PolicyAttention | null;
  provisioning?: PolicyProvisioningFailure | null;
}) {
  const manifestRef = useRef<HTMLDivElement | null>(null);
  const busy = saving || (attention?.retrying ?? false);
  const noneEnabled = SUPPORTED_HARNESSES.every((harness) => !draft.enabled[harness]);
  const availabilityByHarness = new Map(
    snapshot.harnesses.map((entry) => [entry.harness, entry.availability]),
  );
  const outcomeByHarness = new Map<AgentHarness, DocsHarnessResult>(
    (attention?.result.results ?? []).map((entry) => [entry.harness, entry]),
  );

  // ↑↓ roves focus across the manifest lines; enter saves (only while the
  // manifest is a clean form — under attention the buttons carry the actions).
  // Space stays native: every line is a real button, so space is a click.
  // preventDefault on Enter stops it from also acting as a click on the focused
  // line.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!busy && !attention) onSave();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const container = manifestRef.current;
    if (!container) return;
    event.preventDefault();
    const lines = [...container.querySelectorAll<HTMLButtonElement>('[data-manifest-line]')];
    const current = lines.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'ArrowDown'
        ? Math.min(current + 1, lines.length - 1)
        : Math.max(current - 1, 0);
    lines[next]?.focus();
  };

  return (
    <div className="w-85 max-w-full">
      <div ref={manifestRef} className="mt-4 text-left" onKeyDown={handleKeyDown}>
        {attention?.superseded ? (
          <div className="mb-2">
            <ManifestComment tone="amber">{onboardingCopy.results.superseded}</ManifestComment>
          </div>
        ) : null}

        {SUPPORTED_HARNESSES.map((harness) => {
          const enabled = draft.enabled[harness];
          const detected = availabilityByHarness.get(harness) === 'available';
          const outcome = attention ? outcomeByHarness.get(harness) : undefined;
          return (
            <div key={harness}>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={harness}
                data-manifest-line
                disabled={busy}
                onClick={() => onChange(setEnabled(draft, harness, !enabled))}
                className={LINE_CLASS}
              >
                <span className={enabled ? 'text-blue' : 'text-fg-subtle'}>
                  {enabled ? '[x]' : '[ ]'}
                </span>
                <span className={enabled ? 'text-fg' : 'text-fg-muted'}>{harness}</span>
                <Leader />
                {outcome ? (
                  <span className={`text-[11.5px] ${stampClass(outcome.action)}`}>
                    {docsResultCopy.action[outcome.action]}
                  </span>
                ) : (
                  <span
                    className={`text-[11.5px] ${detected ? 'text-green/78' : 'text-fg-subtle'}`}
                  >
                    {detected ? onboardingCopy.detected : onboardingCopy.notDetected}
                  </span>
                )}
              </button>
              {outcome?.reason ? (
                <ManifestComment tone={outcome.action === 'failed' ? 'error' : 'subtle'}>
                  {docsResultCopy.reason[outcome.reason]}
                </ManifestComment>
              ) : null}
            </div>
          );
        })}

        <div className="mt-2.5 border-t border-line/15 pt-2.5">
          {/* The bracket is the whole control — same affordance as the harness
              lines, no second toggle. */}
          <button
            type="button"
            role="switch"
            aria-checked={draft.docsIntent === 'yes'}
            aria-label={onboardingCopy.docs.label}
            data-manifest-line
            disabled={busy}
            onClick={() =>
              onChange(setDocsIntent(draft, draft.docsIntent === 'yes' ? 'no' : 'yes'))
            }
            className={LINE_CLASS}
          >
            <span className={draft.docsIntent === 'yes' ? 'text-blue' : 'text-fg-subtle'}>
              {draft.docsIntent === 'yes' ? '[x]' : '[ ]'}
            </span>
            <span className={draft.docsIntent === 'yes' ? 'text-fg' : 'text-fg-muted'}>
              {onboardingCopy.docs.label}
            </span>
          </button>
          {onboardingCopy.docs.comments.map((comment) => (
            <ManifestComment key={comment}>{comment}</ManifestComment>
          ))}
        </div>

        {noneEnabled && !attention ? (
          <div className="mt-2.5">
            <ManifestComment>{onboardingCopy.emptyNote}</ManifestComment>
          </div>
        ) : null}
        {error ? (
          <div className="mt-2.5">
            <ManifestComment tone="error">{error}</ManifestComment>
          </div>
        ) : null}
        {provisioning ? (
          <div className="mt-2.5">
            <ManifestComment tone="error">{provisioning.line}</ManifestComment>
          </div>
        ) : null}
      </div>

      <div className="mt-5 flex justify-center gap-2.5">
        {provisioning?.retryable ? (
          // Named for what it retries: the row it joins already holds a Save or a
          // reconciliation Retry, and "Try again" beside either would be a riddle.
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || provisioning.retrying}
            onClick={provisioning.onRetry}
          >
            {provisioning.retrying
              ? editorProvisioningCopy.retrying
              : editorProvisioningCopy.manifestRetry}
          </Button>
        ) : null}
        {attention ? (
          <>
            {attention.retryable ? (
              <Button variant="secondary" size="sm" disabled={busy} onClick={attention.onRetry}>
                {attention.retrying
                  ? onboardingCopy.results.retrying
                  : onboardingCopy.results.retry}
              </Button>
            ) : null}
            <Button variant="primary" size="sm" disabled={busy} onClick={attention.onComplete}>
              {onboardingCopy.results.continue}
            </Button>
          </>
        ) : (
          <Button variant="primary" size="sm" disabled={busy} onClick={onSave}>
            {saving ? onboardingCopy.saving : onboardingCopy.save}
          </Button>
        )}
      </div>
    </div>
  );
}
