import { brand, type WorkflowBrand } from './brand.js';

/**
 * One state field's reducer. `Value` is what the field stores; `Update` is what a node, edge, or
 * subgraph mapping emits for it. They are independent on purpose: a field can store a list and
 * accept an add/remove command, or store a nullable value and accept an explicit clear.
 */
export interface StateField<Value, Update> extends WorkflowBrand {
  readonly isagiKind: 'state-field';
  readonly reduce: (current: Value, update: Update) => Value;
}

export function field<Value, Update = Value>(spec: {
  readonly reduce: (current: Value, update: Update) => Value;
}): StateField<Value, Update> {
  return { ...brand('state-field'), reduce: spec.reduce };
}

/**
 * One resolved update type per `State` key: the override where the author supplied one, the stored
 * type otherwise.
 *
 * Mapping over `keyof State` rather than `keyof Overrides` is what makes an omitted key fall back
 * instead of disappearing.
 */
export type ResolvedUpdates<State, Overrides> = {
  [K in keyof State]: K extends keyof Overrides ? Overrides[K] : State[K];
};

/**
 * Rejects override keys that name no `State` field.
 *
 * `Partial<Record<keyof State, unknown>>` alone does not do this: excess-property checking applies
 * to fresh object literals, not to type arguments, so a type carrying extra properties satisfies
 * it. Forcing every key outside `keyof State` to `never` turns a typo into a compile error at
 * `createGraph` instead of a runtime `unknown_state_field`.
 */
export type NoExtraUpdateKeys<Overrides, Allowed extends PropertyKey> = Record<
  Exclude<keyof Overrides, Allowed>,
  never
>;

/** Every `State` key needs a field registration; `-?` makes a missing one a type error. */
export type GraphStateFields<State, Resolved> = {
  readonly [K in keyof State]-?: StateField<State[K], Resolved[K & keyof Resolved]>;
};

/**
 * What any emitter may write. An absent key means "unchanged"; there is no implicit clear, and the
 * runtime rejects an own key whose value is `undefined`.
 */
export type GraphUpdate<Resolved> = { readonly [K in keyof Resolved]?: Resolved[K] };

/** Command-shaped collection update, so removal is an interpreted update rather than an inference. */
export type CollectionUpdate<V> =
  | { readonly op: 'add'; readonly values: readonly V[] }
  | { readonly op: 'remove'; readonly ids: readonly string[] }
  | { readonly op: 'clear' };

/** Explicit clearing for a nullable field, so `null` is never confused with "not supplied". */
export type OptionalUpdate<V> = { readonly set: V } | { readonly clear: true };

/**
 * The shipped reducers. All pure and synchronous: reduction happens inside the transaction that
 * commits a segment boundary, so a reducer that awaited or performed IO would break atomicity.
 */
export const reduce = {
  replace<V>(): StateField<V, V> {
    return field<V, V>({ reduce: (_current, update) => update });
  },
  add(): StateField<number, number> {
    return field<number, number>({ reduce: (current, update) => current + update });
  },
  append<V>(): StateField<readonly V[], V | readonly V[]> {
    return field<readonly V[], V | readonly V[]>({
      reduce: (current, update) => [
        ...current,
        ...(Array.isArray(update) ? update : [update as V]),
      ],
    });
  },
  union<V extends string | number>(): StateField<readonly V[], V | readonly V[]> {
    return field<readonly V[], V | readonly V[]>({
      reduce: (current, update) => {
        const additions = Array.isArray(update) ? update : [update as V];
        const seen = new Set<V>(current);
        const next = [...current];
        for (const value of additions) {
          if (seen.has(value)) continue;
          seen.add(value);
          next.push(value);
        }
        return next;
      },
    });
  },
  collection<V>(identity: (value: V) => string): StateField<readonly V[], CollectionUpdate<V>> {
    return field<readonly V[], CollectionUpdate<V>>({
      reduce: (current, update) => {
        switch (update.op) {
          case 'clear':
            return [];
          case 'remove': {
            const removed = new Set(update.ids);
            return current.filter((value) => !removed.has(identity(value)));
          }
          case 'add': {
            const next = [...current];
            for (const value of update.values) {
              const id = identity(value);
              const existing = next.findIndex((candidate) => identity(candidate) === id);
              if (existing === -1) next.push(value);
              else next[existing] = value;
            }
            return next;
          }
        }
      },
    });
  },
  optional<V>(): StateField<V | null, OptionalUpdate<V>> {
    return field<V | null, OptionalUpdate<V>>({
      reduce: (_current, update) => ('clear' in update ? null : update.set),
    });
  },
  custom<V, U>(reduceFn: (current: V, update: U) => V): StateField<V, U> {
    return field<V, U>({ reduce: reduceFn });
  },
};
