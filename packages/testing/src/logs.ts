// Captures Effect log output so a test can assert on it instead of mocking `console`.
import { Cause, Formatter, Logger, References, type LogLevel } from 'effect';

export interface CapturedLog {
  readonly level: LogLevel.LogLevel;
  /** The logged message parts joined by a space; non-string parts are rendered with Effect's formatter. */
  readonly message: string;
  /** Log annotations (`Effect.annotateLogs`) active when the line was logged. */
  readonly annotations: Readonly<Record<string, unknown>>;
  /** `Cause.pretty` of the cause attached to the log call, or `undefined` when there was none. */
  readonly cause: string | undefined;
}

const render = (part: unknown): string =>
  typeof part === 'string' ? part : Formatter.format(part);

/**
 * A logger that records every line into `lines`. Provide `layer` to the effect under test; it replaces the current
 * loggers, so nothing is printed. Lines below the minimum log level (default `Info`) never reach a logger; provide
 * `References.MinimumLogLevel` to capture `Debug`.
 */
export const makeLogCapture = () => {
  const lines: CapturedLog[] = [];
  const logger = Logger.make(({ logLevel, message, cause, fiber }) => {
    lines.push({
      level: logLevel,
      message: (Array.isArray(message) ? message : [message]).map(render).join(' '),
      annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
      cause: cause.reasons.length > 0 ? Cause.pretty(cause) : undefined,
    });
  });
  return { lines, layer: Logger.layer([logger]) };
};
