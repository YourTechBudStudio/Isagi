import process from 'node:process';

import { Cause, Effect, Exit } from 'effect';

type DiagnosticPrimitive = boolean | number | string | null;
export type DiagnosticContextValue =
  | DiagnosticPrimitive
  | readonly DiagnosticPrimitive[]
  | undefined;
export type DiagnosticContext = Readonly<Record<string, DiagnosticContextValue>>;

// Best-effort, process-global "which phase is active right now" marker, read by the
// always-on event-loop watchdog to name whichever phase was on the stack when the
// loop stalled. A single variable on purpose: it is a diagnostic hint, not state.
// Writes are last-writer-wins with clear-by-phase, so concurrent fibers never leak a
// stale marker (a mismatched clear is a no-op). The one tradeoff is deep nesting: an
// inner phase's clear drops the outer phase's marker. That is acceptable because a
// genuine hang never clears — the hung phase's effect never completes, so its marker
// persists and is what the watchdog reports.
let currentDiagnosticMarker:
  | {
      readonly phase: string;
      readonly context: DiagnosticContext;
      readonly startedAt: number;
    }
  | undefined;

export function diagnosticPhase<A, E, R>(
  phase: string,
  context: DiagnosticContext,
  effect: Effect.Effect<A, E, R>,
) {
  const debug = runtimeDiagnosticsEnabled();

  return Effect.gen(function* () {
    const cleaned = cleanContext(context);
    const startedAt = Date.now();
    // Publish the marker unconditionally: the watchdog ships in every build,
    // independent of ISAGI_RUNTIME_DEBUG, and relies on it for lag attribution. Only
    // the verbose console trace below is gated behind the debug flag.
    setMarker(phase, cleaned, startedAt);
    if (debug) {
      console.info(`[runtime] Diagnostic phase started phase=${phase}`, cleaned);
    }

    const exit = yield* Effect.exit(effect);
    const elapsedMs = Date.now() - startedAt;
    clearMarker(phase);

    if (Exit.isSuccess(exit)) {
      if (debug) {
        console.info(`[runtime] Diagnostic phase completed phase=${phase}`, {
          ...cleaned,
          elapsedMs,
        });
      }
      return exit.value;
    }

    if (debug) {
      console.warn(`[runtime] Diagnostic phase failed phase=${phase}`, {
        ...cleaned,
        elapsedMs,
        cause: Cause.pretty(exit.cause),
      });
    }
    return yield* Effect.failCause(exit.cause);
  });
}

function setMarker(phase: string, context: DiagnosticContext, startedAt: number) {
  currentDiagnosticMarker = { phase, context, startedAt };
}

function clearMarker(phase: string) {
  if (currentDiagnosticMarker?.phase === phase) currentDiagnosticMarker = undefined;
}

export function getDiagnosticMarker() {
  return currentDiagnosticMarker;
}

export function logDiagnosticEvent(
  event: string,
  context: DiagnosticContext,
  level: 'info' | 'warn' = 'info',
) {
  if (!runtimeDiagnosticsEnabled()) return;

  const message = `[runtime] Diagnostic event event=${event}`;
  const payload = cleanContext(context);
  if (level === 'warn') {
    console.warn(message, payload);
  } else {
    console.info(message, payload);
  }
}

export function runtimeDiagnosticsEnabled() {
  const value = process.env.ISAGI_RUNTIME_DEBUG;
  return value === '1' || value === 'true' || value === 'yes';
}

function cleanContext(context: DiagnosticContext) {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as Record<string, Exclude<DiagnosticContextValue, undefined>>;
}
