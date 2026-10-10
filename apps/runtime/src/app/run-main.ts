import process from 'node:process';

import { Cause, Exit, Runtime, type Effect } from 'effect';

/**
 * Exit codes for the runtime process: a program that completed or was interrupted (a requested shutdown) exits 0;
 * any failure or defect, including one raised while shutting down, exits 1. Effect's default teardown would exit 130
 * on interruption.
 */
export const runtimeTeardown: Runtime.Teardown = (exit, onExit) =>
  onExit(Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1);

const shutdownSignals = ['SIGINT', 'SIGTERM'] as const;

// `NodeRuntime.runMain` from `@effect/platform-node` is this plus a dependency we do not want (plan R1, critique C1).
const runMainWith = Runtime.makeRunMain(({ fiber, teardown }) => {
  let receivedSignal = false;
  const onSignal = () => {
    receivedSignal = true;
    fiber.interruptUnsafe(fiber.id);
  };
  // `once`, as the entry point did before: a second SIGINT/SIGTERM during a slow shutdown falls through to Node's
  // default handler and ends the process immediately.
  for (const signal of shutdownSignals) process.once(signal, onSignal);
  fiber.addObserver((exit) => {
    for (const signal of shutdownSignals) process.off(signal, onSignal);
    teardown(exit, (code) => {
      // Without a signal, a successful program ends with the event loop, so pending output is flushed.
      if (receivedSignal || code !== 0) process.exit(code);
    });
  });
});

/**
 * The runtime's process entry. Runs `program` as the main fiber: SIGINT/SIGTERM interrupt it so every finalizer runs
 * (HTTP server, services, child processes) before the process exits 0; a failure exits 1 (`runtimeTeardown`).
 */
export const runMain = <A, E>(
  program: Effect.Effect<A, E>,
  options: { readonly disableErrorReporting?: boolean | undefined } = {},
): void => runMainWith(program, { teardown: runtimeTeardown, ...options });
