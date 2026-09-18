import { isolate } from '../state/isolation.js';
import { isThenable } from '../state/pure.js';
import { errorMessage } from '../state/pure.js';

/**
 * Dynamic display names, and the rules that keep them cosmetic.
 *
 * A label is a fact about what the run was doing *then*, not a view over current state, so it is
 * evaluated exactly once — at the commit that creates the record it names — and never recomputed by
 * Retry, Resume or a restart. It is never identity: `graph_key`, `node_id`, `frame_id` and
 * `execution_id` are unaffected, and the inspector keeps the stable reference visible beside it.
 *
 * Above all it is never load-bearing. A label that throws, returns a non-string or returns an empty
 * string leaves `display_name` null and produces a diagnostic; it cannot fail a segment, because a
 * cosmetic name must not be able to break a run. That is why this function returns a value instead
 * of an Effect that can fail: there is no failure channel for the caller to handle.
 */
export interface CapturedLabel {
  /** `null` when no label was declared, or when the declared one did not produce a usable name. */
  readonly displayName: string | null;
  /** Present only when a declared label failed, for the caller to record as `label_failed`. */
  readonly diagnostic: { readonly what: string; readonly reason: string } | null;
}

const noLabel: CapturedLabel = { displayName: null, diagnostic: null };

export function captureLabel(input: {
  /** What is being named, for the diagnostic: `"graph 'review'"`, `"node 'askWriter'"`. */
  readonly what: string;
  /**
   * The author's callback, whose parameter type is erased.
   *
   * A bundle is compiled against its own copy of the SDK, so by the time a registration reaches the
   * interpreter its real state and parameter types are gone; `never` is how that erasure is stated
   * without widening the SDK's own signatures.
   */
  readonly label: ((argument: never) => string) | undefined;
  /** Produced lazily, so a label that was never declared costs no clone of the state. */
  readonly argument: () => unknown;
}): CapturedLabel {
  const label = input.label;
  if (typeof label !== 'function') return noLabel;
  let produced: unknown;
  try {
    produced = label(isolate(input.argument()) as never);
  } catch (cause) {
    return failed(input.what, `it threw: ${errorMessage(cause)}`);
  }
  if (isThenable(produced)) return failed(input.what, 'it returned a promise');
  if (typeof produced !== 'string') {
    return failed(input.what, `it returned ${produced === null ? 'null' : typeof produced}`);
  }
  // An empty name is not a name. Treated as a failed capture rather than silently stored, so the
  // reason a record shows its stable reference is visible rather than mysterious.
  if (produced.length === 0) return failed(input.what, 'it returned an empty string');
  // Length is bounded by the persistence boundary's shared normalizer, which also refuses to split
  // a surrogate pair; nothing is truncated here so there is one place that decides.
  return { displayName: produced, diagnostic: null };
}

function failed(what: string, reason: string): CapturedLabel {
  return { displayName: null, diagnostic: { what, reason } };
}
