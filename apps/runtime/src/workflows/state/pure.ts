import { IsolationError } from './isolation.js';
import { assertSerializable, UnserializableValueError } from './serializable.js';

/**
 * Evaluating one author-supplied pure callback.
 *
 * Every pure step — `parameters`, `init`, `choose`, `output`, `onResult`, each `reduce` — can go
 * wrong in the same three ways: it throws, it returns a thenable, or it returns a value that cannot
 * be stored. The caller decides which error stage that is; this only says what went wrong.
 *
 * Plain TypeScript: author callbacks are synchronous by contract, so there is no operational work
 * here.
 */
export type PureResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

export function pureFailure(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message };
}

export function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function evaluatePure<A>(evaluation: {
  /** What the callback is, in the author's vocabulary: `"graph 'review' init"`. */
  readonly what: string;
  readonly run: () => A;
  /** Turns on the serializability check, naming the JSON root in the message. */
  readonly serializeAs?: string | undefined;
}): PureResult<A> {
  let value: A;
  try {
    value = evaluation.run();
  } catch (cause) {
    if (cause instanceof IsolationError) {
      return pureFailure(`${evaluation.what} could not be isolated: ${cause.message}`);
    }
    return pureFailure(`${evaluation.what} threw: ${errorMessage(cause)}`);
  }
  if (isThenable(value)) {
    return pureFailure(
      `${evaluation.what} returned a promise. Pure callbacks must be synchronous.`,
    );
  }
  if (evaluation.serializeAs !== undefined) {
    const unserializable = checkSerializable(value, evaluation.serializeAs);
    if (unserializable) return pureFailure(`${evaluation.what} ${unserializable}`);
  }
  return { ok: true, value };
}

/** Why a value cannot be stored, or null when it can. */
export function checkSerializable(value: unknown, path: string): string | null {
  try {
    assertSerializable(value, path);
    return null;
  } catch (cause) {
    if (cause instanceof UnserializableValueError) {
      return `returned a value that cannot be stored at ${cause.path || '<root>'}: ${cause.detail}.`;
    }
    throw cause;
  }
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}
