import type { WorkflowFailureCode } from '@isagi/contracts';

import { IsolationError } from './isolation.js';
import { assertSerializable, UnserializableValueError } from './serializable.js';

/**
 * Evaluating one author-supplied pure callback and classifying what it did.
 *
 * Every pure seam in the interpreter — `parameters`, `init`, `choose`, `output`, `onResult`, and
 * each `reduce` — has the same three ways to go wrong and only the first is specific to the seam:
 * it throws, it returns a thenable, or it returns a value that cannot be persisted. Giving them one
 * evaluator is what keeps `async_pure_callback` and `unserializable_state` from being re-derived
 * (and re-worded) at five call sites.
 *
 * This is deliberately plain TypeScript. Author callbacks are synchronous and pure by contract, so
 * there is no operational work here to make visible — the fallible IO that persists the result is
 * the segment's, and it lives at the Effect boundary above.
 */
export interface PureFailure {
  readonly code: WorkflowFailureCode;
  readonly message: string;
  /** Structured context for the attempt's `failure_detail` slot. Always serializable. */
  readonly detail?: Record<string, unknown> | undefined;
}

export type PureResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly failure: PureFailure;
    };

export function pureFailure(
  code: WorkflowFailureCode,
  message: string,
  detail?: Record<string, unknown>,
): { readonly ok: false; readonly failure: PureFailure } {
  return {
    ok: false,
    failure: detail === undefined ? { code, message } : { code, message, detail },
  };
}

export function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export interface PureEvaluation<A> {
  /** What the callback is, in the author's vocabulary: `"graph init"`, `"edge 'review-out'"`. */
  readonly what: string;
  /** The failure code for a callback that threw. Each seam owns its own. */
  readonly failureCode: WorkflowFailureCode;
  readonly run: () => A;
  /**
   * Where the returned value lands in persistence, when it lands anywhere.
   *
   * Supplying it turns on the serializability gate and names the JSON root in the diagnostic. A
   * callback whose value is only inspected — a display name, say — leaves it out.
   */
  readonly serializeAs?: string | undefined;
}

export function evaluatePure<A>(evaluation: PureEvaluation<A>): PureResult<A> {
  let value: A;
  try {
    value = evaluation.run();
  } catch (cause) {
    // An isolation failure is reported against the *seam*, not as a serialization error: the
    // offending value went in, not out, and telling an author their output is unserializable when
    // their input was would send them to the wrong place.
    if (cause instanceof IsolationError) {
      return pureFailure(evaluation.failureCode, `${evaluation.what} could not be isolated.`, {
        cause: cause.message,
      });
    }
    return pureFailure(evaluation.failureCode, `${evaluation.what} threw.`, {
      cause: errorMessage(cause),
    });
  }
  if (isThenable(value)) {
    return pureFailure(
      'async_pure_callback',
      `${evaluation.what} returned a promise. Pure callbacks must be synchronous.`,
    );
  }
  if (evaluation.serializeAs !== undefined) {
    const unserializable = checkSerializable(value, evaluation.serializeAs);
    if (unserializable) {
      return pureFailure('unserializable_state', `${evaluation.what} ${unserializable.message}`, {
        path: unserializable.path,
      });
    }
  }
  return { ok: true, value };
}

export function checkSerializable(
  value: unknown,
  path: string,
): { readonly path: string; readonly message: string } | null {
  try {
    assertSerializable(value, path);
    return null;
  } catch (cause) {
    if (cause instanceof UnserializableValueError) {
      return { path: cause.path, message: `returned a value that ${cause.detail}.` };
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
