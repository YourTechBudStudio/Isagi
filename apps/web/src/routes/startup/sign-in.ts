import { runtimeErrorCopy, startupCopy } from '../../copy/index.js';
import { classifyRuntimeFailure } from '../../lib/runtime/classify.js';
import { formatRuntimeErrorSummary } from '../../lib/workspace/runtime-data.js';
import type { SignInPhase } from './StartupSurfaces.js';

// The sign-in view's decisions, as pure functions of its state, so each phase is testable
// without a DOM. `SignInForm` owns the state and renders through these.

/** How long a check runs before the output line says the throttle is holding it. */
export const SIGN_IN_SLOW_AFTER_MS = 1200;

/** The phase and printed line a failed sign-in leaves behind. */
export function signInFailure(error: unknown): {
  readonly phase: 'failed' | 'error';
  readonly line: string;
} {
  const classified = classifyRuntimeFailure(error);
  if (classified.kind === 'api' && classified.apiError.code === 'auth_login_failed') {
    // A wrong pair is user-fixable: the code, then its copy.
    return {
      phase: 'failed',
      line: `${classified.apiError.code} · ${runtimeErrorCopy.fromApiError(classified.apiError)}`,
    };
  }
  const message =
    classified.kind === 'transport'
      ? startupCopy.signIn.unreachable
      : formatRuntimeErrorSummary(error);
  return { phase: 'error', line: `${startupCopy.signIn.errorPrefix} · ${message}` };
}

export type SignInOutput = { readonly text: string; readonly tone: string } | null;

/** The one output line under the prompts. `idle` prints nothing. */
export function signInOutputLine(state: {
  readonly phase: SignInPhase;
  readonly slow: boolean;
  readonly failureLine: string | null;
}): SignInOutput {
  switch (state.phase) {
    case 'idle':
      return null;
    case 'checking':
      return {
        text: state.slow ? startupCopy.signIn.slow : startupCopy.signIn.checking,
        tone: 'text-fg-subtle',
      };
    // Amber, not red: a wrong pair is the user's to fix.
    case 'failed':
      return state.failureLine ? { text: state.failureLine, tone: 'text-amber' } : null;
    case 'error':
      return state.failureLine ? { text: state.failureLine, tone: 'text-error' } : null;
    case 'signed_in':
      return { text: startupCopy.signIn.success, tone: 'text-idle' };
  }
}
