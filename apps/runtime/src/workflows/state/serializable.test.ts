import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSerializable,
  canonicalBytes,
  canonicalJson,
  UnserializableValueError,
} from './serializable.js';

/** `assert.throws` does not hand back the error, and these tests assert on its contents. */
function capture(run: () => unknown): UnserializableValueError {
  try {
    run();
  } catch (cause) {
    assert.ok(
      cause instanceof UnserializableValueError,
      `expected UnserializableValueError, got ${String(cause)}`,
    );
    return cause;
  }
  throw new assert.AssertionError({ message: 'Expected the value to be rejected.' });
}

test('rejects every value JSON would silently lose, naming the exact path', () => {
  const cases: readonly [unknown, string][] = [
    [{ a: { b: undefined } }, '.a.b'],
    [{ a: [1, () => 1] }, '.a[1]'],
    [{ a: Symbol('s') }, '.a'],
    [{ a: 1n }, '.a'],
    [{ a: Number.NaN }, '.a'],
    [{ a: Number.POSITIVE_INFINITY }, '.a'],
    [{ a: new Date() }, '.a'],
    [{ a: new Map() }, '.a'],
    [{ a: new Set() }, '.a'],
    [{ a: /x/ }, '.a'],
    [{ a: new Error('boom') }, '.a'],
    [{ a: new Uint8Array(1) }, '.a'],
  ];

  for (const [value, path] of cases) {
    // The path is the point. "Your state is not serializable" is not actionable; ".a.b" is.
    assert.equal(capture(() => assertSerializable(value)).path, path, `for ${String(path)}`);
  }
});

test('rejects a class instance and a cycle rather than producing a lossy encoding', () => {
  class Point {
    constructor(readonly x: number) {}
  }
  assert.match(capture(() => assertSerializable({ p: new Point(1) })).message, /class instance/);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.match(capture(() => assertSerializable(cyclic)).message, /cycle/);

  // A null-prototype object is a plain bag of data, so it is accepted.
  const bare = Object.create(null) as Record<string, unknown>;
  bare.a = 1;
  assert.doesNotThrow(() => assertSerializable(bare));
});

test('a repeated object is not mistaken for a cycle', () => {
  const shared = { a: 1 };
  // Two references to one object along *different* branches is ordinary data. Tracking visited
  // objects globally rather than per-path would reject this, which would reject a lot of real state.
  assert.doesNotThrow(() => assertSerializable({ left: shared, right: shared }));
});

test('canonical JSON sorts keys and preserves array order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1}}');
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  // Two objects that differ only by insertion order must hash the same, which is what makes
  // content identity and request fingerprinting work at all.
  assert.equal(
    canonicalJson({ x: 1, y: [{ b: 1, a: 2 }] }),
    canonicalJson({ y: [{ a: 2, b: 1 }], x: 1 }),
  );
});

test('canonical bytes are UTF-8, so size is measured in what is actually stored', () => {
  // One character, four bytes. Measuring JavaScript string length here would misclassify a state
  // boundary full of non-ASCII text as small enough to inline.
  assert.equal(canonicalBytes('😀').byteLength, Buffer.from('"😀"', 'utf8').byteLength);
  assert.equal(canonicalBytes('😀').byteLength, 6);
});

test('a recorded JSON null is encoded, not dropped', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson({ a: null }), '{"a":null}');
});
