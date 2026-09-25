#!/usr/bin/env node
import process from 'node:process';

import { runCli } from './main.js';

// The process boundary: set the exit status and let Node exit on its own, so everything written to
// stdout — including streamed evidence bytes — is flushed first. Never `process.exit()`.
runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
  env: process.env,
}).then(
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
