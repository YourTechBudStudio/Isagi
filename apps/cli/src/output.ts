import type { CliIo } from './context.js';
import type { ErrorDocument } from './errors.js';

/**
 * How results and failures reach the terminal.
 *
 * With `--json`, stdout carries exactly one JSON document: the result or `{ "error": … }`. Without
 * it, a result prints as indented JSON and a failure as one stderr line. A raw command's stdout is
 * its bytes, so its failure always goes to stderr (as JSON under `--json`).
 */
export function renderResult(io: CliIo, value: unknown, json: boolean): Promise<void> {
  return write(io.stdout, `${JSON.stringify(value, null, json ? undefined : 2)}\n`);
}

export function renderFailure(
  io: CliIo,
  document: ErrorDocument,
  mode: { readonly json: boolean; readonly raw: boolean },
): Promise<void> {
  if (mode.json) {
    return write(mode.raw ? io.stderr : io.stdout, `${JSON.stringify({ error: document })}\n`);
  }
  const reason = document.reason === undefined ? '' : ` (${document.reason})`;
  return write(io.stderr, `isagi: ${document.code}${reason}: ${document.message}\n`);
}

export function renderText(io: CliIo, text: string): Promise<void> {
  return write(io.stdout, text.endsWith('\n') ? text : `${text}\n`);
}

/** `2` for a command line the CLI refused before doing anything; `1` for every other failure. */
export function exitCodeFor(document: ErrorDocument): 1 | 2 {
  return document.code === 'cli_usage_invalid' ? 2 : 1;
}

function write(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}
