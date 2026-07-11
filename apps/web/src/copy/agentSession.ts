import type { HarnessLaunchBlockReason } from '@isagi/contracts';

/**
 * The recovery prompts an agent pane shows when no live process is attached and
 * the durable agent session needs the user to choose how to proceed. These are
 * derived from the backend session projection (status + recoveryAction +
 * diagnosticCode) — see `derivePaneView` — never reconstructed in the UI.
 *
 *  - resume_available  the process stopped; a captured harness session can resume
 *  - resume_failed     a resume was attempted and failed; retry is offered
 *  - start_fresh       nothing can be recovered; only a fresh session can start
 */
export type PaneRestorePrompt = 'resume_available' | 'resume_failed' | 'start_fresh';

export const agentSessionCopy = {
  // The compact status that sits right-aligned in the pane header. Dry, since
  // this lives in working chrome the user sees on every attach.
  status: {
    resume_available: 'Stopped',
    resume_failed: 'Resume failed',
    start_fresh: 'No prior session',
  } satisfies Record<PaneRestorePrompt, string>,
  // The quiet line shown in the work area where live output would be.
  body: {
    resume_available: 'The previous agent process stopped.',
    resume_failed: 'The harness session did not resume.',
    start_fresh: 'Nothing to resume yet.',
  } satisfies Record<PaneRestorePrompt, string>,
  action: {
    resume: 'Resume session',
    retry: 'Retry resume',
    startFresh: 'Start a fresh session',
  },
  // A durable agent pane whose harness the runtime will not launch right now.
  // `blocked` (a policy state — disabled/onboarding/config) is close-only; a
  // config change is the only fix. `unavailable` (missing/incompatible/probe/
  // inventory) is retained and offers an honest recheck.
  launchBlock: {
    harnessStatus: (harness: string, status: string) => `${harness} · ${status}`,
    status: {
      onboarding_incomplete: 'Setup needed',
      config_invalid: 'Config error',
      inventory_pending: 'Checking',
      harness_disabled: 'Disabled',
      harness_missing: 'Not installed',
      harness_incompatible: 'Incompatible',
      harness_probe_failed: 'Unknown',
    } satisfies Record<HarnessLaunchBlockReason, string>,
    body: {
      onboarding_incomplete: 'Finish Isagi setup to use this agent.',
      config_invalid: 'Fix your harness config to use this agent.',
      inventory_pending: 'Isagi is still checking this agent. Give it a moment.',
      harness_disabled: 'This harness is disabled in your Isagi configuration.',
      harness_missing: 'This harness is not installed in your environment.',
      harness_incompatible: 'This harness version is not compatible with Isagi.',
      harness_probe_failed: "Isagi couldn't tell whether this harness is available.",
    } satisfies Record<HarnessLaunchBlockReason, string>,
    disabledHint: 'Re-enable it in Configure harnesses, then start a new session.',
    close: 'Close pane',
    checkAgain: 'Check again',
    checking: 'Checking…',
  },
} as const;
