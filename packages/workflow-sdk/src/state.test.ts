import assert from 'node:assert/strict';
import test from 'node:test';

import { isWorkflowBranded } from './brand.js';
import { field, reduce } from './state.js';

type Feedback = { readonly id: string; readonly text: string };

const identity = (value: Feedback) => value.id;

test('every shipped reducer is a branded state field', () => {
  for (const registration of [
    reduce.replace<string>(),
    reduce.add(),
    reduce.append<number>(),
    reduce.union<string>(),
    reduce.collection<Feedback>(identity),
    reduce.optional<number>(),
    reduce.custom<number, string>((current, update) => current + update.length),
    field<string>({ reduce: (_current, update) => update }),
  ]) {
    assert.ok(isWorkflowBranded(registration, 'state-field'));
    assert.equal(typeof registration.reduce, 'function');
  }
});

test('replace substitutes the update wholesale', () => {
  assert.equal(reduce.replace<string>().reduce('old', 'new'), 'new');
});

test('add accumulates, so a round counter survives a loop', () => {
  const rounds = reduce.add();
  assert.equal(rounds.reduce(2, 1), 3);
  assert.equal(rounds.reduce(2, -2), 0);
});

test('append accepts one value or several and never mutates the input', () => {
  const notes = reduce.append<string>();
  const current = ['a'];
  assert.deepEqual(notes.reduce(current, 'b'), ['a', 'b']);
  assert.deepEqual(notes.reduce(current, ['b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(current, ['a'], 'the prior boundary must be left untouched');
});

test('union ignores values already present and preserves first-seen order', () => {
  const tags = reduce.union<string>();
  assert.deepEqual(tags.reduce(['a', 'b'], 'a'), ['a', 'b']);
  assert.deepEqual(tags.reduce(['a'], ['c', 'b', 'c']), ['a', 'c', 'b']);
});

test('collection adds, replaces by identity, removes by id, and clears', () => {
  const feedback = reduce.collection<Feedback>(identity);
  const first: Feedback = { id: 'f1', text: 'tighten the intro' };
  const second: Feedback = { id: 'f2', text: 'cite the source' };

  const added = feedback.reduce([], { op: 'add', values: [first, second] });
  assert.deepEqual(added, [first, second]);

  const revised: Feedback = { id: 'f1', text: 'the intro is fine now' };
  const replaced = feedback.reduce(added, { op: 'add', values: [revised] });
  assert.deepEqual(replaced, [revised, second], 'an add for a known id replaces it in place');

  assert.deepEqual(feedback.reduce(replaced, { op: 'remove', ids: ['f1'] }), [second]);
  assert.deepEqual(feedback.reduce(replaced, { op: 'clear' }), []);
  assert.deepEqual(added, [first, second], 'the prior boundary must be left untouched');
});

test('optional distinguishes an explicit clear from setting a value', () => {
  const reviewer = reduce.optional<number>();
  assert.equal(reviewer.reduce(null, { set: 7 }), 7);
  assert.equal(reviewer.reduce(7, { clear: true }), null);
});

test('custom carries an author reducer whose update type differs from its value type', () => {
  const summary = reduce.custom<string, readonly string[]>((current, update) =>
    [current, ...update].filter(Boolean).join(' · '),
  );
  assert.equal(summary.reduce('', ['one', 'two']), 'one · two');
});
