import process from 'node:process';

import { Cause, Effect, Layer } from 'effect';

import { MainLayer } from './app/http-server.js';
import { RuntimeLogger } from './app/logger.js';
import { runMain } from './app/run-main.js';
import { formatStartupFailure } from './app/startup-diagnostics.js';

/**
 * The runtime process: build the server and every service, then run until SIGINT/SIGTERM interrupts it, which
 * releases everything in reverse order (`app/http-server.ts`) and exits 0.
 *
 * The logger is provided outermost so it reaches layer construction, request fibers and background fibers alike. A
 * construction failure becomes the `ISAGI_RUNTIME_STARTUP_FAILED` line the desktop host reports, then exit 1.
 */
const main = Layer.launch(MainLayer).pipe(
  Effect.provide(RuntimeLogger.layer),
  Effect.tapCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.void;
    // A failure alongside an interruption happened while shutting down, not while starting.
    if (Cause.hasInterrupts(cause)) {
      return Effect.sync(() =>
        process.stderr.write(`Runtime shutdown failed\n${Cause.pretty(cause)}\n`),
      );
    }
    return Effect.sync(() => process.stderr.write(`${formatStartupFailure(cause)}\n`));
  }),
);

runMain(main, { disableErrorReporting: true });
