// Records Effect log lines so a test can assert on them instead of mocking `console`. Providing `layer` replaces the
// current loggers, so nothing is printed.
import { Formatter, Logger, type LogLevel } from 'effect';

export const makeLogCapture = () => {
  const lines: Array<{ readonly level: LogLevel.LogLevel; readonly message: string }> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    const parts: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message];
    const render = (part: unknown) => (typeof part === 'string' ? part : Formatter.format(part));
    lines.push({ level: logLevel, message: parts.map(render).join(' ') });
  });
  return { lines, layer: Logger.layer([logger]) };
};
