import assert from 'node:assert/strict';
import test from 'node:test';

import { isUnclaimedEscape } from './escape.js';

test('an Escape nothing handled is unclaimed', () => {
  assert.equal(isUnclaimedEscape({ key: 'Escape', defaultPrevented: false }), true);
});

test('an Escape an inner handler prevented is claimed, so zen and the drawer leave it alone', () => {
  assert.equal(isUnclaimedEscape({ key: 'Escape', defaultPrevented: true }), false);
});

test('other keys are never an unclaimed Escape', () => {
  assert.equal(isUnclaimedEscape({ key: 'Enter', defaultPrevented: false }), false);
});
