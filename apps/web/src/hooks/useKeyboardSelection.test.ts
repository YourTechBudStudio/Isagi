import assert from 'node:assert/strict';
import test from 'node:test';

import { moveIndex, snappedIndex } from './useKeyboardSelection.js';

test('moveIndex cycles and starts from the right edge', () => {
  assert.equal(moveIndex(0, 1, 3), 1);
  assert.equal(moveIndex(2, 1, 3), 0); // wraps forward
  assert.equal(moveIndex(0, -1, 3), 2); // wraps backward
  assert.equal(moveIndex(null, 1, 3), 0); // enters at the top going down
  assert.equal(moveIndex(null, -1, 3), 2); // enters at the bottom going up
  assert.equal(moveIndex(0, 1, 0), null); // empty list has no highlight
});

test('snappedIndex honours the default with an empty query', () => {
  assert.equal(snappedIndex('', 3, 1), 1);
  assert.equal(snappedIndex('', 3, null), null);
  assert.equal(snappedIndex('', 0, null), null);
});

test('snappedIndex highlights the first match once a query is typed', () => {
  // The Enter-selection fix: typing under a "no default" view still highlights
  // the first result so Enter selects it.
  assert.equal(snappedIndex('feature/new-room', 1, null), 0);
  assert.equal(snappedIndex('query', 3, 2), 0);
  assert.equal(snappedIndex('no-matches', 0, 1), null);
});
