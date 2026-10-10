import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AtomRegistry } from 'effect/reactivity';

import { makeChannel, makeLatestWins, sessionObject } from './channel.js';

test('session objects are per registry and stable', () => {
  const facts = sessionObject(() => makeChannel<string>());
  const a = AtomRegistry.make();
  const b = AtomRegistry.make();
  assert.equal(a.get(facts), a.get(facts));
  assert.notEqual(a.get(facts), b.get(facts));
  const seen: string[] = [];
  a.get(facts).subscribe((value) => seen.push(value));
  b.get(facts).publish('other registry');
  a.get(facts).publish('mine');
  assert.deepEqual(seen, ['mine']);
  a.dispose();
  b.dispose();
});

test('a channel delivers to the listeners present when a publish starts; unsubscribing stops later ones', () => {
  const channel = makeChannel<number>();
  const seen: string[] = [];
  let unsubscribeSecond = () => {};
  const unsubscribeFirst = channel.subscribe((value) => {
    seen.push(`first:${value}`);
    unsubscribeSecond();
  });
  unsubscribeSecond = channel.subscribe((value) => seen.push(`second:${value}`));
  channel.publish(1);
  unsubscribeFirst();
  channel.publish(2);
  assert.deepEqual(seen, ['first:1', 'second:1']);
});

test('a throwing listener is logged; the other listeners still run and publish does not throw', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const channel = makeChannel<number>();
  const seen: string[] = [];
  channel.subscribe((value) => seen.push(`first:${value}`));
  channel.subscribe(() => {
    throw new Error('subscriber bug');
  });
  channel.subscribe((value) => seen.push(`third:${value}`));

  assert.doesNotThrow(() => channel.publish(1));
  channel.publish(2);

  assert.deepEqual(seen, ['first:1', 'third:1', 'first:2', 'third:2']);
  assert.equal(logged.mock.callCount(), 2);
});

test('latest wins per key: only the newest claim for a key stays latest', () => {
  const writes = makeLatestWins<number>();
  const first = writes.claim(7);
  const other = writes.claim(8);
  assert.equal(first(), true);
  const second = writes.claim(7);
  assert.equal(first(), false, 'superseded by a newer write for the same key');
  assert.equal(second(), true);
  assert.equal(other(), true, 'other keys are independent');
});
