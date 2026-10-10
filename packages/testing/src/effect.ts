// The two ways an Isagi test runs an Effect. Pick one per test, deliberately:
//   runScoped         live clock plus a scope that closes when the effect ends. The mechanical replacement for
//                     `Effect.runPromise` in existing tests; use it for anything doing real IO.
//   runWithTestClock  TestClock + TestConsole plus a scope. Only for time-driven behavior (schedules, retries,
//                     timeouts) that the test advances with `TestClock.adjust`. Never the default: an IO test with a
//                     real timeout would wait forever on a clock nobody advances.
// Both reject with the squashed failure or defect (not a wrapper), so `assert.rejects(run(e), SomeTaggedError)` and
// `assert.rejects(run(e), /message/)` keep working.
import { Cause, Effect, Exit, Layer, type Scope } from 'effect';
import { TestClock, TestConsole } from 'effect/testing';

const settle = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

/** Runs `effect` with the live clock inside a fresh scope, closed (finalizers run) before the promise settles. */
export const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  settle(Effect.scoped(effect));

// A fresh clock and console per run: `Effect.provide` builds the layer anew when no outer memo map exists.
const testEnvironment = Layer.mergeAll(TestClock.layer(), TestConsole.layer);

/**
 * Runs `effect` inside a fresh scope with a TestClock (time moves only through `TestClock.adjust`) and a TestConsole
 * (read with `TestConsole.logLines`/`errorLines`).
 */
export const runWithTestClock = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  settle(effect.pipe(Effect.scoped, Effect.provide(testEnvironment)));
