#!/usr/bin/env node
import { runCli } from './cli.js';

runCli().catch((error: unknown) => {
  process.stderr.write(
    `Workflow verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
