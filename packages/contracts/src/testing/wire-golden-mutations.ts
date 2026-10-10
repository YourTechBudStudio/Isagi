/**
 * Deterministic adversarial inputs for the contract wire goldens.
 *
 * Shared by the capture tool (`scripts/wire-golden-capture.ts`) and the golden test
 * (`src/wire-goldens.test.ts`). The capture stores each probe's accept/reject decision; the test
 * replays the same mutation against the current schema. Keep this file pure (no imports) and never
 * change an existing mutation: the stored goldens identify probes by these values.
 */
export type Mutation =
  | { readonly op: 'null' }
  | { readonly op: 'string' }
  | { readonly op: 'zero' }
  | { readonly op: 'extraKey' }
  | { readonly op: 'drop'; readonly key: string }
  | { readonly op: 'wrongType'; readonly key: string }
  | { readonly op: 'nullKey'; readonly key: string }
  | { readonly op: 'number'; readonly key: string; readonly value: number }
  | { readonly op: 'emptyString'; readonly key: string }
  | { readonly op: 'extraElement' }
  | { readonly op: 'emptyArray' };

export const mutationsOf = (wire: unknown): ReadonlyArray<Mutation> => {
  const out: Mutation[] = [{ op: 'null' }, { op: 'string' }, { op: 'zero' }];
  if (wire && typeof wire === 'object' && !Array.isArray(wire)) {
    out.push({ op: 'extraKey' });
    const record = wire as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      out.push({ op: 'drop', key }, { op: 'wrongType', key }, { op: 'nullKey', key });
      // Boundary values catch lost or loosened filters (int, positive, between, minLength).
      if (typeof record[key] === 'number') {
        for (const value of [-1, 0, 0.5]) out.push({ op: 'number', key, value });
      }
      if (typeof record[key] === 'string' && record[key] !== '') {
        out.push({ op: 'emptyString', key });
      }
    }
  }
  if (Array.isArray(wire)) out.push({ op: 'extraElement' }, { op: 'emptyArray' });
  return out;
};

export const applyMutation = (wire: unknown, mutation: Mutation): unknown => {
  const record = wire as Record<string, unknown>;
  switch (mutation.op) {
    case 'null':
      return null;
    case 'string':
      return 'not-a-wire-value';
    case 'zero':
      return 0;
    case 'extraKey':
      return { ...record, __unknownKey: 1 };
    case 'drop': {
      const { [mutation.key]: _dropped, ...rest } = record;
      return rest;
    }
    case 'wrongType':
      return {
        ...record,
        [mutation.key]: typeof record[mutation.key] === 'string' ? 12345 : '__wrong_type__',
      };
    case 'nullKey':
      return { ...record, [mutation.key]: null };
    case 'number':
      return { ...record, [mutation.key]: mutation.value };
    case 'emptyString':
      return { ...record, [mutation.key]: '' };
    case 'extraElement':
      return [...(wire as ReadonlyArray<unknown>), '__extra_element__'];
    case 'emptyArray':
      return [];
  }
};
