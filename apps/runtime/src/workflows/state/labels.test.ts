import assert from 'node:assert/strict';
import test from 'node:test';

import { captureLabel, maxLabelLength } from './labels.js';

test('a label names the row from its argument', () => {
  assert.equal(
    captureLabel((state: { round: number }) => `Round ${state.round}`, { round: 2 }),
    'Round 2',
  );
});

test('a label that throws, returns a non-string or returns nothing leaves the name empty', () => {
  assert.equal(
    captureLabel(() => {
      throw new Error('boom');
    }, {}),
    null,
  );
  assert.equal(
    captureLabel(() => 7, {}),
    null,
  );
  assert.equal(
    captureLabel(() => '', {}),
    null,
  );
  assert.equal(captureLabel(undefined, {}), null);
});

test('a label cannot mutate the state it reads', () => {
  const state = { items: [1] };
  assert.equal(
    captureLabel((value: { items: number[] }) => {
      value.items.push(2);
      return 'x';
    }, state),
    null,
  );
  assert.deepEqual(state.items, [1]);
});

test('a long label is cut without splitting a surrogate pair', () => {
  const long = `${'a'.repeat(maxLabelLength - 1)}😀tail`;
  const captured = captureLabel(() => long, {});
  assert.equal(captured, 'a'.repeat(maxLabelLength - 1));
});
