import type { AttentionState } from '../lib/workspace/types.js';

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

/** Attention tone for each restore prompt: a failed resume is a still error, the
 *  others wait on the user. */
export const paneRestoreAttention: Record<PaneRestorePrompt, AttentionState> = {
  resume_available: 'waiting',
  resume_failed: 'error',
  start_fresh: 'waiting',
};

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
} as const;
