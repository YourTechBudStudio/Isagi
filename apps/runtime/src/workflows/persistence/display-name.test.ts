import assert from 'node:assert/strict';
import test from 'node:test';

import { maxDisplayNameLength, normalizeDisplayName } from './display-name.js';

test('a name that is not a usable string is stored as absent', () => {
  // All of these mean "this record has no display name". The repository deliberately draws no
  // conclusion about *why*: a label that threw, one that returned the wrong type and one that was
  // never declared arrive here identically, and the interpreter is what tells them apart.
  for (const value of [undefined, null, '', 42, {}, [], true, Symbol('s')]) {
    assert.equal(normalizeDisplayName(value), null, `for ${String(value)}`);
  }
});

test('a usable name is kept exactly, including its whitespace', () => {
  assert.equal(normalizeDisplayName('Draft review'), 'Draft review');
  // Not trimmed. The author chose the string, and quietly rewriting it would be a naming policy
  // this boundary has no business inventing.
  assert.equal(normalizeDisplayName('  spaced  '), '  spaced  ');
  assert.equal(
    normalizeDisplayName('x'.repeat(maxDisplayNameLength)),
    'x'.repeat(maxDisplayNameLength),
  );
});

test('a runaway name is bounded', () => {
  const bounded = normalizeDisplayName('n'.repeat(5000));
  assert.equal(bounded?.length, maxDisplayNameLength);
  assert.equal(bounded, 'n'.repeat(maxDisplayNameLength));
});

test('truncation never leaves half of a surrogate pair behind', () => {
  // An emoji is two UTF-16 code units, so a fixed-index slice can land between them and produce a
  // lone surrogate — which is not valid UTF-8 and round-trips through JSON and SQLite as a
  // replacement character.
  const emoji = '😀';
  assert.equal(emoji.length, 2);
  // 199 single-unit characters, then an emoji straddling positions 199 and 200.
  const straddling = `${'a'.repeat(maxDisplayNameLength - 1)}${emoji}`;
  const bounded = normalizeDisplayName(straddling)!;
  assert.equal(bounded.length, maxDisplayNameLength - 1);
  assert.equal(bounded, 'a'.repeat(maxDisplayNameLength - 1));
  assert.equal(JSON.parse(JSON.stringify(bounded)), bounded, 'the stored name is a valid string');
  assert.ok(!/[\uD800-\uDBFF]$/.test(bounded));

  // An emoji that ends exactly on the boundary is kept whole.
  const aligned = `${'a'.repeat(maxDisplayNameLength - 2)}${emoji}`;
  assert.equal(normalizeDisplayName(`${aligned}tail`), aligned);
});
