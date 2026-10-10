import { Cause, Effect, Exit, Option } from 'effect';

export type RuntimeEffectRunOptions = {
  readonly signal?: AbortSignal | undefined;
};

/**
 * Runs a runtime-client effect for a Promise caller. It rejects with the typed failure itself (the
 * same instance the effect failed with), else the defect, else an interruption error, so callers
 * classify the rejection directly; there is no wrapper to unwrap.
 */
export async function runRuntimeEffect<A, E>(
  effect: Effect.Effect<A, E>,
  options?: RuntimeEffectRunOptions | undefined,
): Promise<A> {
  const runOptions = options?.signal ? { signal: options.signal } : undefined;
  const exit = await Effect.runPromiseExit(effect, runOptions);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  const failure = Cause.findErrorOption(exit.cause);
  throw Option.isSome(failure) ? failure.value : Cause.squash(exit.cause);
}
