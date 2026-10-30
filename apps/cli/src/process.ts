import process from 'node:process';

import { runCli, type RunCliOptions } from './main.js';

/**
 * The process boundary, and the only place the CLI reads `process`: run one invocation with this
 * process's streams, directory and environment, then set the exit status and let Node exit on its
 * own, so everything written to stdout (including streamed checkpoint file bytes) is flushed first.
 * Never `process.exit()`.
 *
 * After `serve` hands off, the runtime's own `runMain` owns signals and may call `process.exit`;
 * that is fine because `serve` streams nothing.
 */
export function runCliProcess(argv: readonly string[], options: RunCliOptions): void {
  runCli(
    argv,
    { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd(), env: process.env },
    options,
  ).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `isagi: unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
