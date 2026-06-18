import { Cause, Effect, Exit, Option, Runtime } from 'effect';

export type RuntimeEffectRunOptions = {
  readonly signal?: AbortSignal | undefined;
};

export async function runRuntimeEffect<A, E>(
  effect: Effect.Effect<A, E>,
  options?: RuntimeEffectRunOptions | undefined,
): Promise<A> {
  const runOptions = options?.signal ? { signal: options.signal } : undefined;
  const exit = await Effect.runPromiseExit(effect, runOptions);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  throw failureFromCause(exit.cause);
}

export function unwrapRuntimeFailure(error: unknown): unknown {
  if (!Runtime.isFiberFailure(error)) {
    return error;
  }

  return failureFromCause(error[Runtime.FiberFailureCauseId]);
}

function failureFromCause<E>(cause: Cause.Cause<E>): unknown {
  const failure = Cause.failureOption(cause);
  return Option.isSome(failure) ? failure.value : Runtime.makeFiberFailure(cause);
}
