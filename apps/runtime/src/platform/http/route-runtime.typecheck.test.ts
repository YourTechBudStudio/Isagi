import { Data, Effect } from 'effect';

import type { RouteRuntime } from './route-runtime.js';

/**
 * A route runs only effects that cannot fail: its failures are mapped to an answer before the run site, so a typed
 * failure can never be squashed into a rejection and answered as `api_unhandled_error`. Each `@ts-expect-error` below
 * is a mistake `tsc` must reject (`pnpm typecheck` fails if any of them compiles).
 */

class UnmappedFailure extends Data.TaggedError('UnmappedFailure')<{}> {}

export function routeRuntimeTypingMistakes(runtime: RouteRuntime<never>) {
  // @ts-expect-error a fallible effect cannot be run on the route runtime
  void runtime.runPromise(Effect.fail(new UnmappedFailure()));

  // @ts-expect-error a forked connection effect must handle its own failures
  runtime.runFork(Effect.fail(new UnmappedFailure()));

  void runtime.runPromise(Effect.succeed(1));
  runtime.runFork(Effect.void);
}
