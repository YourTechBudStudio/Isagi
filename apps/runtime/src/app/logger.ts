import { Config, Data, Effect, Layer, Logger, References } from 'effect';

/** Process settings the runtime reads from its environment, parsed exactly as the pre-Effect entry point did. */
export interface RuntimeSettings {
  /** `HOST`; unset or empty means the loopback interface. */
  readonly host: string;
  /** `PORT`; unset or empty means 0 (any free port). */
  readonly port: number;
  /** `ISAGI_RUNTIME_DEBUG` is `1`, `true` or `yes`: `Debug` log entries are shown. */
  readonly debug: boolean;
}

/** A process setting the runtime cannot start with. Its message is the startup failure line users see. */
export class InvalidRuntimeSetting extends Data.TaggedError('InvalidRuntimeSetting')<{
  readonly setting: 'PORT';
  readonly value: string;
}> {
  override get message() {
    return `Invalid ${this.setting} value: ${this.value}`;
  }
}

const defaultHost = '127.0.0.1';

// Every setting is read as a plain string defaulting to "", then parsed by the rules below. `Config.Boolean` and
// numeric schemas would change what users can write today (`ISAGI_RUNTIME_DEBUG=on` turning debug on and
// `ISAGI_RUNTIME_DEBUG=TRUE` failing startup, `PORT=8080abc` being rejected), so they are deliberately not used.
const setting = (name: string) => Config.String(name).pipe(Config.withDefault(''));

const runtimeDebug = setting('ISAGI_RUNTIME_DEBUG').pipe(Config.map(isRuntimeDebugValue));

/**
 * Reads `HOST`, `PORT` and `ISAGI_RUNTIME_DEBUG` from the current `ConfigProvider` (the process environment unless a
 * test provides another). A bad `PORT` fails with `InvalidRuntimeSetting`, which the entry point reports as a startup
 * failure.
 */
export const RuntimeSettings: Effect.Effect<
  RuntimeSettings,
  Config.ConfigError | InvalidRuntimeSetting
> = Effect.gen(function* () {
  const raw = yield* Config.all({
    host: setting('HOST'),
    port: setting('PORT'),
    debug: runtimeDebug,
  });
  const port = parsePort(raw.port);
  if (port === undefined) {
    return yield* new InvalidRuntimeSetting({ setting: 'PORT', value: raw.port });
  }
  return { host: raw.host === '' ? defaultHost : raw.host, port, debug: raw.debug };
});

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

/** Empty means 0; otherwise `Number.parseInt(value, 10)` must be an integer in 0–65535 (so `8080abc` is 8080). */
function parsePort(value: string): number | undefined {
  if (!value) return 0;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}
