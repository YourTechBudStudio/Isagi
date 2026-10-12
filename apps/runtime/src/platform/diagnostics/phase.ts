import { Effect, Exit } from 'effect';

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

/**
 * Runs `effect` as a named diagnostic phase: it publishes the phase marker the event-loop watchdog reads, and logs the
 * phase's start, completion and failure at `Debug` (shown when `ISAGI_RUNTIME_DEBUG` is on), annotated with `phase`,
 * the context and `elapsedMs`.
 */
export const diagnosticPhase = Effect.fnUntraced(function* <A, E, R>(
  phase: string,
  context: DiagnosticContext,
  effect: Effect.Effect<A, E, R>,
) {
  const cleaned = cleanContext(context);
  const startedAt = Date.now();
  const log = (message: string, annotations: DiagnosticContext, ...rest: ReadonlyArray<unknown>) =>
    Effect.logDebug(message, ...rest).pipe(
      Effect.annotateLogs({ phase, ...cleaned, ...cleanContext(annotations) }),
    );
  // Publish the marker unconditionally: the watchdog ships in every build,
  // independent of ISAGI_RUNTIME_DEBUG, and relies on it for lag attribution. Only
  // the verbose trace below is `Debug`.
  setMarker(phase, cleaned, startedAt);
  yield* log('Diagnostic phase started', {});

  const exit = yield* Effect.exit(effect);
  const elapsedMs = Date.now() - startedAt;
  clearMarker(phase);

  if (Exit.isSuccess(exit)) {
    yield* log('Diagnostic phase completed', { elapsedMs });
    return exit.value;
  }

  yield* log('Diagnostic phase failed', { elapsedMs }, exit.cause);
  return yield* Effect.failCause(exit.cause);
});

function setMarker(phase: string, context: DiagnosticContext, startedAt: number) {
  currentDiagnosticMarker = { phase, context, startedAt };
}

function clearMarker(phase: string) {
  if (currentDiagnosticMarker?.phase === phase) currentDiagnosticMarker = undefined;
}

export function getDiagnosticMarker() {
  return currentDiagnosticMarker;
}

function cleanContext(context: DiagnosticContext) {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as Record<string, Exclude<DiagnosticContextValue, undefined>>;
}
