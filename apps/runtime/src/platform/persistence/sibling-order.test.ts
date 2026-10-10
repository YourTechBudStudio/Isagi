import assert from 'node:assert/strict';
import test from 'node:test';

import { compactedRankChanges, moveBefore } from './sibling-order.js';

test('moves a sibling to the start of the list', () => {
  assert.deepEqual(moveBefore([1, 2, 3], 3, 1), [3, 1, 2]);
});

test('moves a sibling before a later anchor', () => {
  assert.deepEqual(moveBefore([1, 2, 3, 4], 1, 4), [2, 3, 1, 4]);
});

test('moves a sibling before an earlier anchor', () => {
  assert.deepEqual(moveBefore([1, 2, 3, 4], 4, 2), [1, 4, 2, 3]);
});

test('a null anchor appends to the end', () => {
  assert.deepEqual(moveBefore([1, 2, 3], 1, null), [2, 3, 1]);
});

test('moving an item before itself leaves the sequence untouched', () => {
  assert.deepEqual(moveBefore([1, 2, 3], 2, 2), [1, 2, 3]);
});

test('an already-effective placement produces the same sequence', () => {
  assert.deepEqual(moveBefore([1, 2, 3], 2, 3), [1, 2, 3]);
});

test('appending an item that is already last produces the same sequence', () => {
  assert.deepEqual(moveBefore([1, 2, 3], 3, null), [1, 2, 3]);
});

test('a single-item list is unchanged by any legal move', () => {
  assert.deepEqual(moveBefore([1], 1, null), [1]);
  assert.deepEqual(moveBefore([1], 1, 1), [1]);
});

test('rank changes cover only the rows whose position moved', () => {
  const stored = [
    { id: 1, sortOrder: 0 },
    { id: 2, sortOrder: 1 },
    { id: 3, sortOrder: 2 },
  ];
  assert.deepEqual(compactedRankChanges(stored, [1, 3, 2]), [
    { id: 3, sortOrder: 1 },
    { id: 2, sortOrder: 2 },
  ]);
});

test('an already-compact sequence produces no rank changes', () => {
  const stored = [
    { id: 1, sortOrder: 0 },
    { id: 2, sortOrder: 1 },
  ];
  assert.deepEqual(compactedRankChanges(stored, [1, 2]), []);
});

test('a block tied at zero is repaired even when the order is unchanged', () => {
  const stored = [
    { id: 1, sortOrder: 0 },
    { id: 2, sortOrder: 0 },
    { id: 3, sortOrder: 0 },
  ];
  assert.deepEqual(compactedRankChanges(stored, [1, 2, 3]), [
    { id: 2, sortOrder: 1 },
    { id: 3, sortOrder: 2 },
  ]);
});
