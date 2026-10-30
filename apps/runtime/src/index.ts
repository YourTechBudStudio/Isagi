import process from 'node:process';

import { Cause, Effect, Layer } from 'effect';

import type { RuntimeEntryModule } from '@isagi/cli/serve-launch';

import { MainLayer } from './app/http-server.js';
import { launchInputsLayer } from './app/launch.js';
import { RuntimeLogger } from './app/logger.js';
import { runMain } from './app/run-main.js';
import { formatStartupFailure } from './app/startup-diagnostics.js';

/**
 * The runtime process, started by `isagi serve` (the only way a runtime starts): build the server and every service
 * from the launch `serve` resolved, then run until SIGINT/SIGTERM interrupts it, which releases everything (in the
 * order `app/http-server.ts` describes) and exits 0. Importing this module starts nothing.
 *
 * The logger is provided outermost so it reaches layer construction, request fibers and background fibers alike. A
 * construction failure becomes the `ISAGI_RUNTIME_STARTUP_FAILED` line the desktop host reports, then exit 1.
 */
export const serveRuntime: RuntimeEntryModule['serveRuntime'] = (launch) =>
  runMain(
    Layer.launch(MainLayer.pipe(Layer.provide(launchInputsLayer(launch)))).pipe(
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
    ),
    { disableErrorReporting: true },
  );
