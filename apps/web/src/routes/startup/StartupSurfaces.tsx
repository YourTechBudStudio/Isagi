import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Fragment, type ReactNode } from 'react';

import { Button } from '../../components/Button.js';
import { startupCopy } from '../../copy/index.js';
import { canQuit, requestQuit } from '../../lib/desktop-bridge.js';
import { surfaceTransition, uiTransition } from '../../lib/motion.js';
import { runtimeFailureRows, type RuntimeFailureDiagnostic } from './runtime-failure.js';

// The startup gate is one continuous boot surface, not a family of screens: the
// mark, a progress track, and one line of status share a single centered column,
// and state changes morph that column in place. The track is a determinate boot
// narrative — fill *position* says which boot beat we're in (reach the runtime →
// probe the environment → first-run setup → open), fill *color* says how it's
// going: blue→violet running, amber blocked on the user, red only for the
// runtime itself being gone.

export type BootView =
  | { kind: 'connecting' }
  | { kind: 'environment_pending' }
  | { kind: 'opening' }
  | { kind: 'runtime_unreachable'; error: string; retrying: boolean; onRetry: () => void }
  // The runtime is terminally gone — it never started, or it died after readiness.
  // Unlike the retryable `runtime_unreachable`, the only way forward is to restart
  // or quit the whole app; the surface never implies process or session survival.
  // `diagnostic` carries the facts to display; `onRestart`/`onQuit` are
  // host-supplied (mocked by the dev fixture in Phase 03, real bridge callbacks
  // in Phase 04, which also owns how the diagnostic is framed and kept safe).
  | {
      kind: 'runtime_failed';
      diagnostic: RuntimeFailureDiagnostic;
      onRestart: () => void;
      onQuit: () => void;
    }
  | { kind: 'config_invalid'; diagnostic: string | null }
  // First-run setup, mounted as the third boot beat. The owner (OnboardingFlow)
  // supplies the unfolded content and drives `live` (a save or retry is running),
  // the whisper, and `stepKey` (form vs results) so step changes crossfade.
  | { kind: 'setup'; live: boolean; whisper: string | null; stepKey: string; children: ReactNode };

type BootKind = BootView['kind'];
type TrackTone = 'running' | 'blocked' | 'error';

// Fill percent per boot beat: reach the runtime (→25), probe inventory and
// config (→50), first-run setup (→75), open (→100). Loading states sit
// mid-beat; a blocker freezes the fill at the beat that failed, so the track
// shows where boot stopped. Already-onboarded launches simply never render the
// setup beat — the fill runs 50→100 straight through.
const FILL: Record<BootKind, number> = {
  connecting: 17,
  environment_pending: 42,
  setup: 75,
  opening: 100,
  runtime_unreachable: 25,
  // The runtime is boot beat one; when it is terminally gone the track freezes at
  // the foundation, same position as the retryable state but held in error tone.
  runtime_failed: 25,
  config_invalid: 50,
};

// Views that compact the mark and unfold content below the track.
const COMPACT_KINDS: readonly BootKind[] = [
  'runtime_unreachable',
  'runtime_failed',
  'config_invalid',
  'setup',
];

// The diagnostic-bearing blocker states get a wider column so multi-line
// diagnostics have room to read. Loading states and onboarding (`setup`) keep the
// calm narrow column.
const WIDE_KINDS: readonly BootKind[] = ['runtime_unreachable', 'runtime_failed', 'config_invalid'];

function trackTone(view: BootView): { tone: TrackTone; live: boolean } {
  switch (view.kind) {
    case 'connecting':
    case 'environment_pending':
      return { tone: 'running', live: true };
    case 'opening':
      return { tone: 'running', live: false };
    // Setup waits on the user: the track holds completely still until a save or
    // retry is actually running.
    case 'setup':
      return { tone: 'running', live: view.live };
    case 'runtime_unreachable':
      return view.retrying ? { tone: 'running', live: true } : { tone: 'error', live: false };
    // Terminal: a genuine runtime error, and nothing is retrying, so the track is
    // still — error tone, no live shimmer.
    case 'runtime_failed':
      return { tone: 'error', live: false };
    case 'config_invalid':
      return { tone: 'blocked', live: false };
  }
}

function statusText(view: BootView): string | null {
  if (view.kind === 'connecting') return startupCopy.connecting.status;
  if (view.kind === 'environment_pending') return startupCopy.environmentPending.status;
  if (view.kind === 'opening') return startupCopy.opening.status;
  return null;
}

function whisperText(view: BootView): string | null {
  if (view.kind === 'connecting') return startupCopy.connecting.aside;
  if (view.kind === 'environment_pending') return startupCopy.environmentPending.aside;
  if (view.kind === 'setup') return view.whisper;
  return null;
}

function BootMark({ compact }: { compact: boolean }) {
  return (
    <div
      className={`font-display leading-none font-semibold tracking-[-0.035em] text-fg transition-all duration-surface ease-expo motion-reduce:transition-none ${
        compact ? 'text-[21px]' : 'text-[38px]'
      }`}
    >
      Isagi
    </div>
  );
}

const TRACK_BG: Record<TrackTone, string> = {
  running: 'bg-line/16',
  blocked: 'bg-amber/10',
  error: 'bg-error/10',
};

const FILL_BG: Record<TrackTone, string> = {
  running: 'bg-linear-to-r from-blue to-violet',
  blocked: 'bg-amber/60',
  error: 'bg-error/55',
};

function BootTrack({
  percent,
  tone,
  live,
  compact,
}: {
  percent: number;
  tone: TrackTone;
  live: boolean;
  compact: boolean;
}) {
  return (
    <div
      className={`relative h-0.75 rounded-full transition-all duration-surface ease-expo motion-reduce:transition-none ${
        compact ? 'mt-4.5 w-[150px]' : 'mt-6.5 w-[190px]'
      } ${TRACK_BG[tone]}`}
    >
      <div
        className={`absolute inset-y-0 left-0 rounded-full transition-all duration-surface ease-expo motion-reduce:transition-none ${FILL_BG[tone]}`}
        style={{ width: `${percent}%` }}
      >
        {live ? (
          <>
            {/* A light ray sweeping the filled length, so a long-lived phase
                still reads as alive while the fill holds position. Clipped to
                the fill; the tip below overflows it on purpose. */}
            <span aria-hidden="true" className="absolute inset-0 overflow-hidden rounded-full">
              <span className="absolute inset-y-0 left-0 w-1/2 animate-ray bg-linear-to-r from-transparent via-white/45 to-transparent motion-reduce:animate-none" />
            </span>
            {/* The live tip — a soft violet glow breathing at the leading edge
                while a check runs. Calm ambient motion, never a spinner. */}
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

function BootStatus({ text }: { text: string }) {
  return (
    // Fixed height so status swaps crossfade in place without nudging the column.
    <div className="mt-4 h-4.5">
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={text}
          className="font-mono text-[12px] text-fg-subtle"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={uiTransition}
        >
          {text}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

export function BootTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="mt-5.5 font-display text-[20px] font-semibold tracking-tight text-fg">
      {children}
    </h1>
  );
}

export function BootBody({ children }: { children: ReactNode }) {
  return <p className="mt-2 max-w-[52ch] text-[13px] leading-[1.55] text-fg-muted">{children}</p>;
}

function DiagnosticChip({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'muted';
  children: ReactNode;
}) {
  const styles =
    tone === 'error'
      ? 'border-error/24 bg-error/8 text-error'
      : 'border-line/40 bg-white/4 text-fg-muted';
  return (
    <p
      data-slot="diagnostic-chip"
      className={`mt-3.5 max-w-[72ch] overflow-x-auto rounded-sm border px-3 py-2 text-left font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap ${styles}`}
    >
      {children}
    </p>
  );
}

function BootActions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex gap-2.5">{children}</div>;
}

function BootDetail({ view }: { view: BootView }) {
  if (view.kind === 'setup') {
    return <>{view.children}</>;
  }
  if (view.kind === 'config_invalid') {
    return (
      <>
        <BootTitle>{startupCopy.configInvalid.title}</BootTitle>
        <BootBody>{startupCopy.configInvalid.body}</BootBody>
        {view.diagnostic ? (
          <DiagnosticChip tone="muted">
            {startupCopy.configInvalid.diagnosticLabel} · {view.diagnostic}
          </DiagnosticChip>
        ) : null}
        {canQuit() ? (
          <BootActions>
            <Button variant="secondary" size="sm" onClick={requestQuit}>
              {startupCopy.configInvalid.quit}
            </Button>
          </BootActions>
        ) : null}
      </>
    );
  }
  if (view.kind === 'runtime_unreachable') {
    return (
      <>
        <BootTitle>{startupCopy.runtimeUnreachable.title}</BootTitle>
        <BootBody>{startupCopy.runtimeUnreachable.body}</BootBody>
        <DiagnosticChip>{view.error}</DiagnosticChip>
        <BootActions>
          <Button variant="primary" size="sm" disabled={view.retrying} onClick={view.onRetry}>
            {view.retrying
              ? startupCopy.runtimeUnreachable.retrying
              : startupCopy.runtimeUnreachable.retry}
          </Button>
        </BootActions>
      </>
    );
  }
  if (view.kind === 'runtime_failed') {
    const rows = runtimeFailureRows(view.diagnostic);
    return (
      <>
        <BootTitle>{startupCopy.runtimeFailed.title}</BootTitle>
        <BootBody>{startupCopy.runtimeFailed.body}</BootBody>
        {rows.length > 0 ? (
          // One error chip; each present fact on its own line via pre-wrap. Labels
          // are dimmed so the red stays on the values, not the whole block. Only
          // inline nodes live inside the chip's <p>.
          <DiagnosticChip>
            {rows.map((row, index) => (
              <Fragment key={row.key}>
                {index > 0 ? '\n' : null}
                <span className="text-error/55">{startupCopy.runtimeFailed.rows[row.key]} · </span>
                {row.value}
              </Fragment>
            ))}
          </DiagnosticChip>
        ) : (
          <DiagnosticChip tone="muted">{startupCopy.runtimeFailed.unavailable}</DiagnosticChip>
        )}
        <BootActions>
          <Button variant="primary" size="sm" onClick={view.onRestart}>
            {startupCopy.runtimeFailed.restart}
          </Button>
          <Button variant="secondary" size="sm" onClick={view.onQuit}>
            {startupCopy.runtimeFailed.quit}
          </Button>
        </BootActions>
      </>
    );
  }
  return null;
}

/**
 * The one boot surface. Render it persistently and swap `view` — the mark
 * compacts, the track advances or freezes, and detail unfolds, all in place.
 */
export function BootSurface({ view }: { view: BootView }) {
  const compact = COMPACT_KINDS.includes(view.kind);
  const wide = WIDE_KINDS.includes(view.kind);
  const { tone, live } = trackTone(view);
  const status = statusText(view);
  const whisper = whisperText(view);
  const detailKey = view.kind === 'setup' ? `setup-${view.stepKey}` : view.kind;

  return (
    // Honor prefers-reduced-motion for the boot-detail/track/status transforms —
    // Framer defaults to ignoring it, so the detail unfold would otherwise still
    // translate. Scoped to BootSurface so StartupGate's opening-overlay motion,
    // which wraps this, is deliberately left alone.
    <MotionConfig reducedMotion="user">
      <div className="canvas-atmosphere relative grid h-screen place-items-center overflow-hidden p-6">
        <div
          className={`flex w-full flex-col items-center text-center ${wide ? 'max-w-2xl' : 'max-w-100'}`}
        >
          <BootMark compact={compact} />
          <BootTrack percent={FILL[view.kind]} tone={tone} live={live} compact={compact} />
          <AnimatePresence mode="wait" initial={false}>
            {status ? (
              <motion.div key="status" exit={{ opacity: 0, y: -4 }} transition={uiTransition}>
                <BootStatus text={status} />
              </motion.div>
            ) : (
              <motion.div
                key={detailKey}
                className="flex flex-col items-center"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={surfaceTransition}
              >
                <BootDetail view={view} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {whisper ? (
            <motion.p
              key={whisper}
              className="absolute right-0 bottom-5 left-0 text-center font-mono text-[11.5px] text-fg-subtle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.55 }}
              exit={{ opacity: 0 }}
              transition={uiTransition}
            >
              {whisper}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
