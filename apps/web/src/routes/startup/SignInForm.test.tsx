// The sign-in view, the expiry screen, and which of them a signed-out page shows. Rendered
// statically: each phase is a state the view can sit in, so its markup is what the user sees.
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { ApiError } from '@isagi/contracts';
import { RuntimeApiError, RuntimeDecodeError, RuntimeTransportError } from '@isagi/runtime-client';

import { startupCopy } from '../../copy/index.js';
import { workbenchShownAtom } from '../../lib/auth/state.js';
import { AppStateProvider } from '../../lib/state/AppStateProvider.js';
import { makeTestRegistry } from '../../lib/state/testing.js';
import { formatRuntimeErrorSummary } from '../../lib/workspace/runtime-data.js';
import { signInFailure, signInOutputLine } from './sign-in.js';
import { SignedOutSurface } from './SignedOutSurface.js';
import { SignInPrompt } from './SignInForm.js';
import { BootSurface, type SignInPhase } from './StartupSurfaces.js';

const apiError = (code: string, status: number): ApiError => ({
  code,
  status,
  message: 'runtime-authored, never shown',
  requestId: 'req-1',
});

const PHASES: readonly SignInPhase[] = ['idle', 'checking', 'failed', 'error', 'signed_in'];

function renderSignIn(phase: SignInPhase, options: { slow?: boolean; failureLine?: string } = {}) {
  const output = signInOutputLine({
    phase,
    slow: options.slow ?? false,
    failureLine: options.failureLine ?? null,
  });
  return renderToStaticMarkup(
    <BootSurface
      view={{
        kind: 'sign_in',
        phase,
        children: (
          <SignInPrompt
            username="noorain"
            password="hunter22"
            phase={phase}
            output={output}
            onUsername={() => undefined}
            onPassword={() => undefined}
            onSubmit={() => undefined}
          />
        ),
      }}
    />,
  );
}

/** The parts of the track that carry meaning: its tone and whether it is animating. */
function track(markup: string) {
  return {
    red: markup.includes('bg-error/55'),
    amber: markup.includes('bg-amber/60'),
    running: markup.includes('from-blue to-violet'),
    live: markup.includes('animate-ray'),
    fill: /style="width:(\d+)%"/.exec(markup)?.[1],
  };
}

const disabledInputs = (markup: string) => (markup.match(/<input[^>]*disabled=""/g) ?? []).length;

describe('signInFailure', () => {
  it('a wrong pair is `failed`, printed as the code then its copy', () => {
    const failure = signInFailure(
      new RuntimeApiError({
        endpointId: 'auth.login',
        apiError: apiError('auth_login_failed', 401),
      }),
    );
    assert.equal(failure.phase, 'failed');
    assert.ok(failure.line.startsWith('auth_login_failed · '));
    assert.ok(!failure.line.includes('runtime-authored'), 'the runtime message is not the line');
  });

  it('a transport failure is `error` with the sign-in view’s own unreachable line', () => {
    const failure = signInFailure(
      new RuntimeTransportError({ endpointId: 'auth.login', cause: 'down' }),
    );
    assert.equal(failure.phase, 'error');
    assert.equal(failure.line, `error · ${startupCopy.signIn.unreachable}`);
  });

  it('any other failure is `error` with the shared runtime-error summary', () => {
    for (const error of [
      new RuntimeApiError({
        endpointId: 'auth.login',
        apiError: apiError('api_unhandled_error', 500),
      }),
      new RuntimeDecodeError({ endpointId: 'auth.login', cause: 'bad' }),
      new Error('boom'),
    ]) {
      const failure = signInFailure(error);
      assert.equal(failure.phase, 'error');
      assert.equal(failure.line, `error · ${formatRuntimeErrorSummary(error)}`);
    }
  });
});

describe('sign-in view', () => {
  it('prints one output line per phase, and nothing while idle', () => {
    assert.equal(signInOutputLine({ phase: 'idle', slow: false, failureLine: null }), null);
    const checking = signInOutputLine({ phase: 'checking', slow: false, failureLine: null });
    const slow = signInOutputLine({ phase: 'checking', slow: true, failureLine: null });
    assert.equal(checking?.text, startupCopy.signIn.checking);
    assert.equal(slow?.text, startupCopy.signIn.slow, 'the slow line once the throttle holds');
    assert.equal(
      signInOutputLine({ phase: 'failed', slow: false, failureLine: 'x' })?.tone,
      'text-amber',
    );
    assert.equal(
      signInOutputLine({ phase: 'error', slow: false, failureLine: 'x' })?.tone,
      'text-error',
    );
    assert.equal(
      signInOutputLine({ phase: 'signed_in', slow: false, failureLine: null })?.text,
      startupCopy.signIn.success,
    );
  });

  it('renders the output line inside a polite live region', () => {
    const markup = renderSignIn('failed', { failureLine: 'auth_login_failed · nope' });
    assert.match(markup, /<div aria-live="polite"><p[^>]*>auth_login_failed · nope<\/p><\/div>/);
    assert.match(renderSignIn('idle'), /<div aria-live="polite"><\/div>/);
  });

  it('labels the inputs for password managers and screen readers', () => {
    const markup = renderSignIn('idle');
    assert.match(markup, /<input[^>]*aria-label="Username"[^>]*autoComplete="username"/i);
    assert.match(
      markup,
      /<input[^>]*aria-label="Password"[^>]*type="password"[^>]*autoComplete="current-password"/i,
    );
    assert.match(markup, /<button type="submit"/);
  });

  it('disables both inputs and the submit control only while checking or signed in', () => {
    for (const phase of PHASES) {
      const markup = renderSignIn(phase, { failureLine: 'x' });
      const busy = phase === 'checking' || phase === 'signed_in';
      assert.equal(disabledInputs(markup), busy ? 2 : 0, `${phase}: inputs`);
      assert.equal(/<button type="submit" disabled=""/.test(markup), busy, `${phase}: submit`);
    }
  });

  it('keeps the track at the first beat: running, live only while working, red only on error, never amber', () => {
    for (const phase of PHASES) {
      const t = track(renderSignIn(phase, { failureLine: 'x' }));
      assert.equal(t.fill, '25', `${phase}: one fill for the kind`);
      assert.equal(t.amber, false, `${phase}: never amber`);
      assert.equal(t.red, phase === 'error', `${phase}: red only for error`);
      assert.equal(t.running, phase !== 'error', `${phase}: running colour otherwise`);
      assert.equal(t.live, phase === 'checking' || phase === 'signed_in', `${phase}: live`);
    }
  });

  it('carries the bottom note', () => {
    assert.ok(renderSignIn('idle').includes(startupCopy.signIn.whisper.replace("'", '&#x27;')));
  });
});

describe('expiry screen', () => {
  it('is a still, amber blocker at the first beat with one Sign in action', () => {
    const markup = renderToStaticMarkup(
      <BootSurface view={{ kind: 'session_expired', onSignIn: () => undefined }} />,
    );
    const t = track(markup);
    assert.deepEqual([t.amber, t.live, t.red, t.fill], [true, false, false, '25']);
    assert.ok(markup.includes(startupCopy.sessionExpired.title));
    assert.equal((markup.match(/<button/g) ?? []).length, 1);
    assert.match(markup, />Sign in<\/span><\/button>/);
    assert.ok(!markup.includes('<input'), 'no form until Sign in is pressed');
  });
});

describe('signed-out surface', () => {
  const render = (t: TestContext, workbenchShown: boolean) => {
    const registry = makeTestRegistry({ initialValues: [[workbenchShownAtom, workbenchShown]] });
    t.after(() => registry.dispose());
    return renderToStaticMarkup(
      <AppStateProvider registry={registry}>
        <SignedOutSurface />
      </AppStateProvider>,
    );
  };

  it('shows the expiry screen first when the workbench was showing', (t) => {
    const markup = render(t, true);
    assert.ok(markup.includes(startupCopy.sessionExpired.title));
    assert.ok(!markup.includes(startupCopy.signIn.command));
  });

  it('goes straight to the sign-in view when it was not', (t) => {
    const markup = render(t, false);
    assert.ok(markup.includes(startupCopy.signIn.command));
    assert.ok(!markup.includes(startupCopy.sessionExpired.title));
  });
});
