import assert from 'node:assert/strict';
import test from 'node:test';

import { tabStep, verticalIndex } from './list-navigation.js';

test('Up and Down step one item and stop at the ends', () => {
  assert.equal(verticalIndex('ArrowDown', 1, 4), 2);
  assert.equal(verticalIndex('ArrowUp', 1, 4), 0);
  assert.equal(verticalIndex('ArrowDown', 3, 4), 3);
  assert.equal(verticalIndex('ArrowUp', 0, 4), 0);
});

test('Home and End go to the first and last item', () => {
  assert.equal(verticalIndex('Home', 2, 4), 0);
  assert.equal(verticalIndex('End', 0, 4), 3);
});

test('with nothing selected, Up and Down both land on the first item', () => {
  assert.equal(verticalIndex('ArrowDown', -1, 4), 0);
  assert.equal(verticalIndex('ArrowUp', -1, 4), 0);
  assert.equal(verticalIndex('End', -1, 4), 3);
});

test('an empty list goes nowhere, whatever the key', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    assert.equal(verticalIndex(key, -1, 0), null);
  }
});

test('keys a list does not own fall through', () => {
  for (const key of ['ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Tab', 'a']) {
    assert.equal(verticalIndex(key, 1, 4), null);
  }
});

test('the tab strip wraps Left and Right, and Home and End go to the ends', () => {
  assert.equal(tabStep('ArrowRight', 0, 4), 1);
  assert.equal(tabStep('ArrowRight', 3, 4), 0);
  assert.equal(tabStep('ArrowLeft', 0, 4), 3);
  assert.equal(tabStep('ArrowLeft', 2, 4), 1);
  assert.equal(tabStep('Home', 2, 4), 0);
  assert.equal(tabStep('End', 1, 4), 3);
});

test('the tab strip leaves Up, Down and other keys alone', () => {
  for (const key of ['ArrowUp', 'ArrowDown', 'Enter', 'Tab']) {
    assert.equal(tabStep(key, 1, 4), null);
  }
});
