import { Data, Effect, FiberSet, type Scope } from 'effect';

import { errorMessage } from '../state/pure.js';

/**
 * The one place the engine crosses the workflow SDK's Promise-shaped authoring contract, in both
 * directions.
 *
 * The SDK surface is plain TypeScript by design: a workflow author writes `async` functions and
 * receives `ctx` objects whose methods return promises. The engine is Effect. So:
 *
 * - **Effect → Promise** (`open`): an author-facing context (`ctx` of a node function, the
 *   `placement()` context) runs each call as a fiber in an engine-scoped `FiberSet`. The fiber
 *   inherits the engine's services (logger, tracer), and engine shutdown interrupts it, so the
 *   author's promise rejects instead of acting after the runtime stopped. A context closes when the
 *   author function it was handed to returns; a call after that rejects with the context's own
 *   message. v4 rejects with the failure itself, so an author sees the runtime-authored `message` of
 *   the tagged error that failed the call.
 * - **Promise → Effect** (`call`): calling author code (`command`, `parse`, `placement`, a node
 *   function). A throw or a rejection becomes `AuthorCodeFailed`, carrying the author's own error as
 *   `cause`. Author promises cannot be cancelled; interrupting the caller only stops waiting.
 *
 * Nothing else in the runtime runs an Effect for author code or awaits author code directly.
 */
export interface AuthorBridge {
  /** A context for one author function. `closedMessage` is what a call after `close()` rejects with. */
  readonly open: (closedMessage: string) => AuthorContext;
  /** Calls author code. `label` names it in the failure, in the author's vocabulary. */
  readonly call: <A>(
    label: string,
    f: () => PromiseLike<A> | A,
  ) => Effect.Effect<A, AuthorCodeFailed>;
}

export interface AuthorContext {
  /** Runs `effect` for the author, as a promise. The only Effect → Promise conversion in the runtime. */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly close: () => void;
}

/** Author code threw or rejected. `message` is the author's own, verbatim. */
export class AuthorCodeFailed extends Data.TaggedError('AuthorCodeFailed')<{
  readonly label: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The engine's bridge, scoped to the engine: its scope closing interrupts every bridged call in flight. */
export const makeAuthorBridge: Effect.Effect<AuthorBridge, never, Scope.Scope> = Effect.gen(
  function* () {
    const calls = yield* FiberSet.make();
    const runPromise = yield* FiberSet.runtimePromise(calls)<never>();
    return {
      open: (closedMessage) => {
        let closed = false;
        return {
          run: (effect) => (closed ? Promise.reject(new Error(closedMessage)) : runPromise(effect)),
          close: () => {
            closed = true;
          },
        };
      },
      call: (label, f) =>
        Effect.tryPromise({
          try: async () => f(),
          catch: (cause) => new AuthorCodeFailed({ label, message: errorMessage(cause), cause }),
        }),
    } satisfies AuthorBridge;
  },
);
