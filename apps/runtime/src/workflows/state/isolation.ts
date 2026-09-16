/**
 * The boundary between a committed state snapshot and an author's callback.
 *
 * Every pure callback — `init`, `parameters`, `choose`, `output`, `onResult`, and every `reduce` —
 * is handed an isolated copy rather than the value the interpreter is holding. Two properties come
 * from that, and both matter:
 *
 * - a callback that mutates its argument throws instead of corrupting a live snapshot, because the
 *   copy is deeply frozen;
 * - two reducers running against the same committed boundary cannot observe each other, because
 *   each holds its own copy.
 *
 * `structuredClone` is what does the copying, and it is also the first gate: it rejects functions
 * and other non-cloneable values outright, before a callback can be handed something that would
 * fail later at the serialization boundary with a worse message.
 */

/** A value that could not be isolated, which is an author error rather than a runtime defect. */
export class IsolationError extends Error {
  readonly _tag = 'IsolationError';
  constructor(cause: unknown) {
    super(`Value cannot be isolated for a pure callback: ${describe(cause)}`);
  }
}

export function isolate<T>(value: T): T {
  let cloned: T;
  try {
    cloned = structuredClone(value);
  } catch (cause) {
    throw new IsolationError(cause);
  }
  return deepFreeze(cloned);
}

/**
 * Freezes in place, depth-first, tolerating cycles.
 *
 * `structuredClone` preserves cycles, so the seen set is not defensive dressing: a self-referential
 * state object would otherwise recurse forever between the clone and the freeze.
 */
export function deepFreeze<T>(value: T, seen: Set<object> = new Set()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as unknown as object;
  if (seen.has(object)) return value;
  seen.add(object);
  Object.freeze(object);
  for (const key of Object.keys(object)) {
    deepFreeze((object as Record<string, unknown>)[key], seen);
  }
  return value;
}

function describe(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
