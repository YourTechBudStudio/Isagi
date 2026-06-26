import process from 'node:process';

import { Cause, Effect, Exit } from 'effect';

type DiagnosticPrimitive = boolean | number | string | null;
export type DiagnosticContextValue =
  | DiagnosticPrimitive
  | readonly DiagnosticPrimitive[]
  | undefined;
export type DiagnosticContext = Readonly<Record<string, DiagnosticContextValue>>;

export function diagnosticPhase<A, E, R>(
  phase: string,
  context: DiagnosticContext,
  effect: Effect.Effect<A, E, R>,
) {
  if (!runtimeDiagnosticsEnabled()) return effect;

  return Effect.gen(function* () {
    const startedAt = Date.now();
    yield* Effect.sync(() => {
      console.info(`[runtime] Diagnostic phase started phase=${phase}`, cleanContext(context));
    });

    const exit = yield* Effect.exit(effect);
    const elapsedMs = Date.now() - startedAt;
    if (Exit.isSuccess(exit)) {
      yield* Effect.sync(() => {
        console.info(`[runtime] Diagnostic phase completed phase=${phase}`, {
          ...cleanContext(context),
          elapsedMs,
        });
      });
      return exit.value;
    }

    yield* Effect.sync(() => {
      console.warn(`[runtime] Diagnostic phase failed phase=${phase}`, {
        ...cleanContext(context),
        elapsedMs,
        cause: Cause.pretty(exit.cause),
      });
    });
    return yield* Effect.failCause(exit.cause);
  });
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
