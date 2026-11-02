import { CornerDownLeft } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { startupCopy } from '../../copy/index.js';
import { signIn } from '../../lib/auth/session.js';
import { uiTransition } from '../../lib/motion.js';
import { useAppRun } from '../../lib/state/registry.js';
import {
  SIGN_IN_SLOW_AFTER_MS,
  signInFailure,
  signInOutputLine,
  type SignInOutput,
} from './sign-in.js';
import { BootSurface, type SignInPhase } from './StartupSurfaces.js';

const isBusy = (phase: SignInPhase) => phase === 'checking' || phase === 'signed_in';

/**
 * The sign-in view: a terminal-shaped `isagi login` session on the boot surface. It owns the form
 * state and hands the prompt card to `BootSurface`, the way `OnboardingFlow` owns `setup`.
 * Feedback stays in the card's output line (ADR 0004). A success reloads the page (`signIn`).
 */
export function SignInForm() {
  const run = useAppRun();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<SignInPhase>('idle');
  const [slow, setSlow] = useState(false);
  const [failureLine, setFailureLine] = useState<string | null>(null);

  // The throttle holds failed attempts back; past the threshold the line says so.
  useEffect(() => {
    if (phase !== 'checking') return;
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), SIGN_IN_SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const submit = () => {
    if (isBusy(phase)) return;
    setPhase('checking');
    setFailureLine(null);
    run(signIn({ username, password })).then(
      () => setPhase('signed_in'),
      (error: unknown) => {
        const failure = signInFailure(error);
        setFailureLine(failure.line);
        setPhase(failure.phase);
      },
    );
  };

  return (
    <BootSurface
      view={{
        kind: 'sign_in',
        phase,
        children: (
          <SignInPrompt
            username={username}
            password={password}
            phase={phase}
            output={signInOutputLine({ phase, slow, failureLine })}
            onUsername={setUsername}
            onPassword={setPassword}
            onSubmit={submit}
          />
        ),
      }}
    />
  );
}

function PromptLine({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex items-center gap-2 py-1 ${className}`}>{children}</div>;
}

const promptInput =
  'min-w-0 flex-1 bg-transparent text-fg caret-violet outline-none disabled:opacity-60';

/** The prompt card itself, presentational so each phase can be rendered on its own. */
export function SignInPrompt({
  username,
  password,
  phase,
  output,
  onUsername,
  onPassword,
  onSubmit,
}: {
  username: string;
  password: string;
  phase: SignInPhase;
  output: SignInOutput;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: () => void;
}) {
  const busy = isBusy(phase);
  const passwordRef = useRef<HTMLInputElement>(null);
  // Disabling the inputs drops focus; after a miss, put the cursor back where the retry starts.
  useEffect(() => {
    if (phase === 'failed' || phase === 'error') passwordRef.current?.focus();
  }, [phase]);
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-7 w-full rounded-lg border border-line/24 bg-scrim/40 px-4 py-3.5 text-left font-mono text-[13px] shadow-soft"
    >
      {/* One blank terminal line after the command, then the prompts sit tight together. */}
      <PromptLine className="mb-2.5">
        <span className="text-fg-subtle">$</span>
        <span className="text-fg">{startupCopy.signIn.command}</span>
      </PromptLine>
      <PromptLine>
        <span className="w-21 shrink-0 text-cyan">{startupCopy.signIn.usernamePrompt}</span>
        <input
          aria-label={startupCopy.signIn.usernameLabel}
          autoComplete="username"
          autoFocus
          spellCheck={false}
          disabled={busy}
          value={username}
          onChange={(event) => onUsername(event.target.value)}
          className={promptInput}
        />
      </PromptLine>
      <PromptLine>
        <span className="w-21 shrink-0 text-cyan">{startupCopy.signIn.passwordPrompt}</span>
        <input
          ref={passwordRef}
          aria-label={startupCopy.signIn.passwordLabel}
          type="password"
          autoComplete="current-password"
          disabled={busy}
          value={password}
          onChange={(event) => onPassword(event.target.value)}
          className={promptInput}
        />
        <button
          type="submit"
          disabled={busy}
          className="flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11.5px] text-fg-subtle transition duration-micro ease-expo hover:bg-tint/6 hover:text-fg disabled:opacity-40"
        >
          {startupCopy.signIn.submit} <CornerDownLeft size={12} aria-hidden="true" />
        </button>
      </PromptLine>
      <div aria-live="polite">
        <AnimatePresence initial={false}>
          {output ? (
            <motion.p
              key={output.text}
              data-slot="sign-in-output"
              className={`overflow-hidden ${output.tone}`}
              initial={{ opacity: 0, height: 0, marginTop: 0 }}
              animate={{ opacity: 1, height: 'auto', marginTop: 10 }}
              exit={{ opacity: 0, height: 0, marginTop: 0 }}
              transition={uiTransition}
            >
              {output.text}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </form>
  );
}
