// THROWAWAY MOCK for #65 — presentation only. Delete this folder and the
// `/__mock/sign-in` route in App.tsx once the sign-in view is implemented.
// Nothing here talks to the runtime; submit is simulated.
//
// Chosen direction: the "shell prompt" sign-in — the form reads like
// `$ isagi login` in a terminal, on the boot surface (compact mark + track).

import { CornerDownLeft } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { uiTransition } from '../../lib/motion.js';

// ---------------------------------------------------------------------------
// Simulated sign-in. Valid pair: isagi / isagi. Username "offline" simulates a
// transport failure. Wrong attempts grow the delay like the real throttle:
// min(250ms × 2^(failures−1), 5s).
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'pending' | 'failed' | 'unreachable' | 'success';

interface SignIn {
  username: string;
  password: string;
  phase: Phase;
  /** Pending long enough that the throttle is visibly holding. */
  slow: boolean;
  setUsername: (value: string) => void;
  setPassword: (value: string) => void;
  submit: () => void;
}

const PRESETS = {
  empty: { label: 'Empty', username: '', password: '', phase: 'idle', slow: false },
  filled: {
    label: 'Filled',
    username: 'noorain',
    password: 'hunter22',
    phase: 'idle',
    slow: false,
  },
  pending: {
    label: 'Submitting',
    username: 'noorain',
    password: 'hunter22',
    phase: 'pending',
    slow: false,
  },
  slow: {
    label: 'Throttled',
    username: 'noorain',
    password: 'hunter22',
    phase: 'pending',
    slow: true,
  },
  failed: {
    label: 'Wrong password',
    username: 'noorain',
    password: 'hunter22',
    phase: 'failed',
    slow: false,
  },
  unreachable: {
    label: 'Unreachable',
    username: 'noorain',
    password: 'hunter22',
    phase: 'unreachable',
    slow: false,
  },
  success: {
    label: 'Signed in',
    username: 'noorain',
    password: 'hunter22',
    phase: 'success',
    slow: false,
  },
} as const satisfies Record<
  string,
  { label: string; username: string; password: string; phase: Phase; slow: boolean }
>;

type PresetKey = keyof typeof PRESETS;

function useSimulatedSignIn(preset: PresetKey, presetNonce: number): SignIn {
  const initial = PRESETS[preset];
  const [username, setUsername] = useState<string>(initial.username);
  const [password, setPassword] = useState<string>(initial.password);
  const [phase, setPhase] = useState<Phase>(initial.phase);
  const [slow, setSlow] = useState<boolean>(initial.slow);
  const failures = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const next = PRESETS[preset];
    setUsername(next.username);
    setPassword(next.password);
    setPhase(next.phase);
    setSlow(next.slow);
    failures.current = next.phase === 'failed' ? 3 : 0;
  }, [preset, presetNonce]);

  const submit = () => {
    if (phase === 'pending' || phase === 'success') return;
    const ok = username === 'isagi' && password === 'isagi';
    const offline = username === 'offline';
    const throttle = ok || offline ? 0 : Math.min(250 * 2 ** failures.current, 5000);
    setPhase('pending');
    setSlow(false);
    timers.current.push(window.setTimeout(() => setSlow(true), 1200));
    timers.current.push(
      window.setTimeout(() => {
        timers.current.forEach(clearTimeout);
        timers.current = [];
        setSlow(false);
        if (ok) {
          failures.current = 0;
          setPhase('success');
        } else if (offline) {
          setPhase('unreachable');
        } else {
          failures.current += 1;
          setPhase('failed');
        }
      }, 450 + throttle),
    );
  };

  return { username, password, phase, slow, setUsername, setPassword, submit };
}

const busy = (s: SignIn) => s.phase === 'pending' || s.phase === 'success';

// ---------------------------------------------------------------------------
// Copy — drafts, would move to copy/startup.ts and copy/errors.ts.
// ---------------------------------------------------------------------------

const copy = {
  username: 'Username',
  password: 'Password',
  command: 'isagi login',
  usernamePrompt: 'username:',
  passwordPrompt: 'password:',
  submit: 'sign in',
  checking: '# checking…',
  slow: '# taking a beat after the last miss…',
  failed: 'auth_login_failed · that pair didn’t match.',
  unreachable: 'error · runtime unreachable. is it still running?',
  success: 'ok · reloading…',
  whisper: "// it's a lock, not a vault",
};

function outputLine(s: SignIn): { text: string; tone: string } | null {
  if (s.phase === 'pending')
    return { text: s.slow ? copy.slow : copy.checking, tone: 'text-fg-subtle' };
  if (s.phase === 'failed') return { text: copy.failed, tone: 'text-amber' };
  if (s.phase === 'unreachable') return { text: copy.unreachable, tone: 'text-error' };
  if (s.phase === 'success') return { text: copy.success, tone: 'text-idle' };
  return null;
}

// ---------------------------------------------------------------------------
// Boot-surface pieces, copied from StartupSurfaces so the mock stands alone.
// ---------------------------------------------------------------------------

function Mark() {
  return (
    <div className="font-display text-[21px] leading-none font-semibold tracking-[-0.035em] text-fg">
      Isagi
    </div>
  );
}

function Track({ percent, error, live }: { percent: number; error: boolean; live: boolean }) {
  return (
    <div
      className={`relative mt-4.5 h-0.75 w-37.5 rounded-full transition-all duration-surface ease-expo ${
        error ? 'bg-error/10' : 'bg-line/16'
      }`}
    >
      <div
        className={`absolute inset-y-0 left-0 rounded-full transition-all duration-surface ease-expo ${
          error ? 'bg-error/55' : 'bg-linear-to-r from-blue to-violet'
        }`}
        style={{ width: `${percent}%` }}
      >
        {live ? (
          <>
            <span aria-hidden="true" className="absolute inset-0 overflow-hidden rounded-full">
              <span className="absolute inset-y-0 left-0 w-1/2 animate-ray bg-linear-to-r from-transparent via-white/45 to-transparent motion-reduce:animate-none" />
            </span>
            <span
              aria-hidden="true"
              className="absolute top-1/2 -right-2 size-4.5 -translate-y-1/2 animate-breathe rounded-full bg-radial from-violet/55 to-transparent to-70% motion-reduce:animate-none"
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sign-in view: a terminal-shaped form. Real inputs underneath, so
// password managers and autocomplete still work.
// ---------------------------------------------------------------------------

function PromptLine({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex items-center gap-2 py-1 ${className}`}>{children}</div>;
}

const promptInput =
  'min-w-0 flex-1 bg-transparent text-fg caret-violet outline-none disabled:opacity-60';

function SignInPrompt({ s }: { s: SignIn }) {
  const out = outputLine(s);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    s.submit();
  };

  return (
    <div className="flex w-full max-w-110 flex-col items-center">
      <Mark />
      <Track
        percent={s.phase === 'success' ? 50 : 25}
        error={s.phase === 'unreachable'}
        live={busy(s)}
      />
      <form
        onSubmit={onSubmit}
        className="mt-7 w-full rounded-lg border border-line/24 bg-scrim/40 px-4 py-3.5 text-left font-mono text-[13px] shadow-soft"
      >
        {/* One blank terminal line after the command, then the prompts sit tight together. */}
        <PromptLine className="mb-2.5">
          <span className="text-fg-subtle">$</span>
          <span className="text-fg">{copy.command}</span>
        </PromptLine>
        <PromptLine>
          <span className="w-21 shrink-0 text-cyan">{copy.usernamePrompt}</span>
          <input
            aria-label={copy.username}
            autoComplete="username"
            autoFocus
            spellCheck={false}
            disabled={busy(s)}
            value={s.username}
            onChange={(event) => s.setUsername(event.target.value)}
            className={promptInput}
          />
        </PromptLine>
        <PromptLine>
          <span className="w-21 shrink-0 text-cyan">{copy.passwordPrompt}</span>
          <input
            aria-label={copy.password}
            type="password"
            autoComplete="current-password"
            disabled={busy(s)}
            value={s.password}
            onChange={(event) => s.setPassword(event.target.value)}
            className={promptInput}
          />
          <button
            type="submit"
            disabled={busy(s)}
            className="flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11.5px] text-fg-subtle transition duration-micro ease-expo hover:bg-tint/6 hover:text-fg disabled:opacity-40"
          >
            {copy.submit} <CornerDownLeft size={12} />
          </button>
        </PromptLine>
        <div aria-live="polite">
          <AnimatePresence initial={false}>
            {out ? (
              <motion.p
                key={out.text}
                className={`overflow-hidden ${out.tone}`}
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                animate={{ opacity: 1, height: 'auto', marginTop: 10 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                transition={uiTransition}
              >
                {out.text}
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mock page: a state switcher (mock chrome, not design) over the view.
// ---------------------------------------------------------------------------

export function SignInMock() {
  const [preset, setPreset] = useState<PresetKey>('empty');
  const [nonce, setNonce] = useState(0);
  const s = useSimulatedSignIn(preset, nonce);

  return (
    <MotionConfig reducedMotion="user">
      <div className="canvas-atmosphere relative grid h-screen place-items-center overflow-hidden p-6">
        <div className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1.5 font-mono text-[11px]">
          <div className="flex gap-1 rounded-lg border border-line/20 bg-elevated/70 p-1 backdrop-blur-md">
            {(Object.keys(PRESETS) as PresetKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setPreset(key);
                  setNonce((n) => n + 1);
                }}
                className={`rounded-md px-2.5 py-1 transition duration-micro ease-expo ${
                  preset === key
                    ? 'bg-tint/10 text-fg'
                    : 'text-fg-subtle hover:bg-tint/6 hover:text-fg'
                }`}
              >
                {PRESETS[key].label}
              </button>
            ))}
          </div>
          <p className="text-fg-subtle opacity-70">
            live: isagi/isagi signs in, “offline” fails transport, anything else is a miss
          </p>
        </div>

        <SignInPrompt s={s} />

        <p className="absolute right-0 bottom-5 left-0 text-center font-mono text-[11.5px] text-fg-subtle opacity-55">
          {copy.whisper}
        </p>
      </div>
    </MotionConfig>
  );
}
