import type { GraphStateFields, StateField } from '../types.js';
import { isolate } from './isolation.js';
import { checkSerializable, evaluatePure, pureFailure, type PureFailure } from './pure.js';

/**
 * Applying an author's update to a committed state boundary.
 *
 * Three properties hold here and each is load-bearing somewhere else in the design:
 *
 * - **One boundary.** Every reducer reads the value from the *committed* state, never from a
 *   partially reduced candidate, so reducers cannot observe each other's results and their order is
 *   not a hidden part of the contract.
 * - **All or nothing.** The candidate is built beside `current`, which is never mutated. A reducer
 *   that throws halfway through leaves nothing partial to commit, which is what lets the caller
 *   write state, result and history in one transaction and mean it.
 * - **No implicit clears.** Omitting a key is the only way to leave a field unchanged; an own key
 *   whose value is `undefined` is rejected, so a typo cannot quietly erase a field.
 */
export type ReduceOutcome =
  | {
      readonly ok: true;
      /** The new boundary. Reference-equal to `current` when the update changed nothing. */
      readonly state: Record<string, unknown>;
    }
  | { readonly ok: false; readonly failure: PureFailure };

export function reduceState(input: {
  readonly fields: GraphStateFields<Record<string, unknown>, Record<string, unknown>>;
  readonly current: Record<string, unknown>;
  readonly update: unknown;
  /** The graph this state belongs to, so a rejection names where the field should have been. */
  readonly graphKey: string;
}): ReduceOutcome {
  const { fields, current, update, graphKey } = input;
  // An absent update is not an empty update: it means the emitter chose to change nothing, and it
  // publishes no new state boundary at all.
  if (update === undefined) return { ok: true, state: current };
  if (!isPlainObject(update)) {
    return pureFailure(
      'invalid_update_shape',
      `A state update must be a plain object; received ${describeShape(update)}.`,
    );
  }

  const keys = Object.keys(update);
  for (const key of keys) {
    const field = fieldFor(fields, key);
    if (!field) {
      return pureFailure(
        'unknown_state_field',
        `Graph '${graphKey}' has no state field '${key}'.`,
        { field: key, graphKey },
      );
    }
    if (update[key] === undefined) {
      return pureFailure(
        'implicit_clear_rejected',
        `State field '${key}' was set to undefined. Omit the key to leave it unchanged, or use an explicit clear.`,
        { field: key, graphKey },
      );
    }
  }
  if (keys.length === 0) return { ok: true, state: current };

  const candidate: Record<string, unknown> = { ...current };
  for (const key of keys) {
    // Non-null: the loop above already rejected every key without a field.
    const field = fieldFor(fields, key)!;
    const reduced = evaluatePure({
      what: `Reducer for state field '${key}'`,
      failureCode: 'reducer_failed',
      run: () => field.reduce(isolate(current[key]), isolate(update[key])),
      serializeAs: key,
    });
    if (!reduced.ok) return reduced;
    candidate[key] = reduced.value;
  }

  // The whole candidate, not just the fields that moved: a reducer can return a value that is
  // individually fine and still produce a state that is not, and the boundary is what gets stored.
  const unserializable = checkSerializable(candidate, '');
  if (unserializable) {
    return pureFailure(
      'unserializable_state',
      `Reduced state for graph '${graphKey}' ${unserializable.message}`,
      { path: unserializable.path, graphKey },
    );
  }
  return { ok: true, state: candidate };
}

/**
 * Every own key of a freshly initialized state must have a declared reducer.
 *
 * Checked at graph entry rather than at the first update, because a field with no reducer is a
 * field nothing can ever change: discovering it at entry names the graph's `init`, while
 * discovering it later names whichever unlucky node first tried to write it.
 */
export function assertDeclaredStateFields(input: {
  readonly fields: GraphStateFields<Record<string, unknown>, Record<string, unknown>>;
  readonly state: unknown;
  readonly graphKey: string;
}): PureFailure | null {
  if (!isPlainObject(input.state)) {
    return {
      code: 'invalid_update_shape',
      message: `Graph '${input.graphKey}' init must return a plain object; received ${describeShape(input.state)}.`,
    };
  }
  for (const key of Object.keys(input.state)) {
    if (fieldFor(input.fields, key)) continue;
    return {
      code: 'unknown_state_field',
      message: `Graph '${input.graphKey}' init returned '${key}', which has no declared reducer.`,
      detail: { field: key, graphKey: input.graphKey },
    };
  }
  return null;
}

function fieldFor(
  fields: GraphStateFields<Record<string, unknown>, Record<string, unknown>>,
  key: string,
): StateField<unknown, unknown> | null {
  // Own-property only: a field named `constructor` or `toString` must come from the author's
  // registration, never from `Object.prototype`.
  if (!Object.prototype.hasOwnProperty.call(fields, key)) return null;
  const field = (fields as Record<string, unknown>)[key];
  return isRegisteredField(field) ? field : null;
}

function isRegisteredField(value: unknown): value is StateField<unknown, unknown> {
  return (
    isPlainObject(value) &&
    (value as { isagiKind?: unknown }).isagiKind === 'state-field' &&
    typeof (value as { reduce?: unknown }).reduce === 'function'
  );
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function describeShape(value: unknown) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
