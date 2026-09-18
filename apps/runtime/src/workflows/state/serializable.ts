/**
 * The runtime's serialization boundary for author-supplied values.
 *
 * Everything a workflow persists — a frame's state, a graph's parameters, an outcome's output, an
 * emitted update, a normalized operation request — passes through here on its way to storage, and
 * the same canonical bytes are what get hashed. Keeping both in one module is what makes "the hash
 * identifies the stored bytes" true by construction rather than by two implementations agreeing.
 *
 * Pure TypeScript on purpose: this is validation and encoding, not operational work. The fallible
 * IO that *uses* it lives in the payload store's Effect boundary.
 */

/**
 * Why a value cannot be persisted, with the exact JSON path to the offending member.
 *
 * `JSON.stringify` alone is not a check: it silently drops `undefined` and functions, turns a
 * `Date` into a string that will not round-trip, and throws an unlocated error on a cycle. An
 * explicit walk is what turns "keep persisted state JSON-serializable" into a contract the runtime
 * enforces instead of advice an author is expected to remember.
 */
export class UnserializableValueError extends Error {
  readonly _tag = 'UnserializableValueError';
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${path || '<root>'} is not serializable: ${detail}`);
  }
}

const rejections: readonly {
  readonly matches: (value: object) => boolean;
  readonly detail: string;
}[] = [
  { matches: (value) => value instanceof Date, detail: 'a Date does not round-trip through JSON' },
  { matches: (value) => value instanceof Map, detail: 'a Map has no JSON representation' },
  { matches: (value) => value instanceof Set, detail: 'a Set has no JSON representation' },
  { matches: (value) => value instanceof RegExp, detail: 'a RegExp has no JSON representation' },
  { matches: (value) => value instanceof Error, detail: 'an Error has no JSON representation' },
  {
    matches: (value) => ArrayBuffer.isView(value),
    detail: 'a typed array has no JSON representation',
  },
  {
    matches: (value) => value instanceof ArrayBuffer,
    detail: 'an ArrayBuffer has no JSON representation',
  },
];

/**
 * Walks `value` and throws {@link UnserializableValueError} at the first member that cannot be
 * persisted. Returns nothing: it is a gate, not a converter, because silently converting is exactly
 * the lossiness this exists to prevent.
 */
export function assertSerializable(value: unknown, path = ''): void {
  walk(value, path, new Set());
}

function walk(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null) return;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new UnserializableValueError(path, `${String(value)} has no JSON representation`);
      }
      return;
    case 'undefined':
      throw new UnserializableValueError(path, 'undefined has no JSON representation');
    case 'function':
      throw new UnserializableValueError(path, 'a function cannot be persisted');
    case 'symbol':
      throw new UnserializableValueError(path, 'a symbol cannot be persisted');
    case 'bigint':
      throw new UnserializableValueError(path, 'a bigint has no JSON representation');
    default:
      break;
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw new UnserializableValueError(path, 'the value contains a cycle');
  }
  for (const rejection of rejections) {
    if (rejection.matches(object)) throw new UnserializableValueError(path, rejection.detail);
  }

  ancestors.add(object);
  if (Array.isArray(object)) {
    object.forEach((entry, index) => walk(entry, `${path}[${index}]`, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(object) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new UnserializableValueError(
        path,
        'a class instance cannot be persisted; use a plain object',
      );
    }
    for (const key of Object.keys(object)) {
      walk((object as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(object);
}

/**
 * The canonical JSON encoding: object keys sorted lexicographically by UTF-16 code unit, array
 * order preserved, no insignificant whitespace.
 *
 * Canonicalization is what makes content identity work — republishing an identical state boundary
 * costs one hash rather than one file — and it is also what makes an operation request fingerprint
 * stable across a callback that happens to build its object in a different key order.
 *
 * The value is validated first, so this never silently drops a member.
 */
export function canonicalJson(value: unknown): string {
  assertSerializable(value);
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * `Array.prototype.sort`'s default comparator already orders by UTF-16 code unit, but it does so by
 * stringifying first. Comparing the strings directly says what the ordering actually is, which
 * matters because this ordering is part of a hash other processes reproduce.
 */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Canonical bytes, in the encoding the threshold and the hash are both measured in: UTF-8. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}
