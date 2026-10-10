// The desktop main process's log output: every `Effect.log*` becomes the `[desktop] …` console line main has always
// written, Debug/Info on stdout and Warning/Error on stderr. The runtime child's own output is not logged through here:
// it is a protocol (supervisor records, the ready line) and `runtime-process/logging.ts` writes it directly.
import { Cause, Console, Formatter, Logger, References, type LogLevel } from 'effect';

/**
 * The console arguments for one log call: `[desktop] <first message part>`, then the remaining parts unchanged (so an
 * object is rendered by the console exactly as a `console.*` call would render it), then each log annotation as
 * `key=value`, then the attached cause.
 */
export function desktopLogArguments(
  message: unknown,
  annotations: Readonly<Record<string, unknown>>,
  cause: Cause.Cause<unknown>,
): ReadonlyArray<unknown> {
  const [first, ...rest] = Array.isArray(message) ? message : [message];
  const parts: unknown[] =
    typeof first === 'string' ? [`[desktop] ${first}`, ...rest] : ['[desktop]', first, ...rest];
  for (const [key, value] of Object.entries(annotations)) {
    parts.push(`${key}=${typeof value === 'string' ? value : Formatter.format(value)}`);
  }
  if (cause.reasons.length > 0) parts.push(`\n${Cause.pretty(cause)}`);
  return parts;
}

const consoleMethod = (level: LogLevel.LogLevel) => {
  switch (level) {
    case 'Warn':
      return 'warn' as const;
    case 'Error':
    case 'Fatal':
      return 'error' as const;
    case 'Debug':
    case 'Trace':
      return 'debug' as const;
    default:
      return 'info' as const;
  }
};

/** Writes through the fiber's `Console`, so a test can capture the lines by providing its own. */
export const desktopConsoleLogger: Logger.Logger<unknown, void> = Logger.make(
  ({ logLevel, message, cause, fiber }) => {
    const console = fiber.getRef(Console.Console);
    const parts = desktopLogArguments(
      message,
      fiber.getRef(References.CurrentLogAnnotations),
      cause,
    );
    console[consoleMethod(logLevel)](...parts);
  },
);

/**
 * The logger set for the desktop runtime. It replaces the default set, so `Logger.tracerLogger` is listed explicitly:
 * without it, log lines inside `Effect.fn` spans would stop being recorded as span events.
 */
export const DesktopLogger = Logger.layer([desktopConsoleLogger, Logger.tracerLogger]);
