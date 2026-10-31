import { Config, Effect, Layer, Logger, References } from 'effect';

// Read as a plain string defaulting to "", then parsed by `isRuntimeDebugValue`. `Config.Boolean` would change what
// users can write today (`ISAGI_RUNTIME_DEBUG=on` turning debug on, `ISAGI_RUNTIME_DEBUG=TRUE` failing startup).
const runtimeDebug = Config.String('ISAGI_RUNTIME_DEBUG').pipe(
  Config.withDefault(''),
  Config.map(isRuntimeDebugValue),
);

/**
 * The runtime's loggers, provided once around the whole program (never inside a module layer, where it would not
 * reach request fibers):
 *
 * - one logfmt line per entry, so multi-line causes stay one forwarded record in the desktop host;
 * - `Debug`/`Info` to stdout and `Warning`/`Error` to stderr, the split `console.info`/`console.warn` gave before;
 * - `Debug` entries only when `ISAGI_RUNTIME_DEBUG` enables them (what `runtimeDiagnosticsEnabled` gated);
 * - `Logger.tracerLogger` listed explicitly: `Logger.layer([...])` replaces the whole logger set, so without it log
 *   entries would stop becoming span events.
 *
 * The `ISAGI_RUNTIME_READY` and `ISAGI_RUNTIME_STARTUP_FAILED` protocol lines are written directly, never through
 * this logger.
 */
export const RuntimeLogger: { readonly layer: Layer.Layer<never, Config.ConfigError> } = {
  layer: Layer.unwrap(
    Effect.map(runtimeDebug, (debug) =>
      Layer.mergeAll(
        Logger.layer([Logger.withLeveledConsole(Logger.formatLogFmt), Logger.tracerLogger]),
        Layer.succeed(References.MinimumLogLevel, debug ? 'Debug' : 'Info'),
      ),
    ),
  ),
};

/** Today's `ISAGI_RUNTIME_DEBUG` rule: exactly `1`, `true` or `yes`; anything else (including unset) is off. */
export function isRuntimeDebugValue(value: string) {
  return value === '1' || value === 'true' || value === 'yes';
}
