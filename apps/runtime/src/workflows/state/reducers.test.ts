import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { field, reduce } from '@yourtechbudstudio/isagi-workflow-sdk';

import type { GraphStateFields } from '../types.js';
import { deepFreeze, isolate } from './isolation.js';
import { assertDeclaredStateFields, reduceState } from './reducers.js';

type AnyFields = GraphStateFields<Record<string, unknown>, Record<string, unknown>>;

const fields = {
  title: reduce.replace<string>(),
  rounds: reduce.add(),
  notes: reduce.append<string>(),
  tags: reduce.union<string>(),
  reviewers: reduce.collection<{ readonly id: string; readonly name: string }>((value) => value.id),
  summary: reduce.optional<string>(),
} as unknown as AnyFields;

const current = {
  title: 'draft',
  rounds: 1,
  notes: ['first'],
  tags: ['a'],
  reviewers: [{ id: 'r1', name: 'Ada' }],
  summary: null,
};

function apply(update: unknown, over: Record<string, unknown> = current) {
  return reduceState({ fields, current: over, update, graphKey: 'reviewed-document' });
}

function expectFailure(outcome: ReturnType<typeof apply>) {
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  return outcome.failure;
}

describe('reduceState', () => {
  it('leaves every omitted field untouched and returns the same boundary for an absent update', () => {
    const outcome = apply(undefined);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.state, current, 'an absent update publishes no new boundary');
  });

  it('applies only the named fields and keeps the rest byte-identical', () => {
    const outcome = apply({ rounds: 2, notes: 'second' });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.state, {
      ...current,
      rounds: 3,
      notes: ['first', 'second'],
    });
    assert.deepEqual(current.notes, ['first'], 'the committed boundary is never mutated');
  });

  it('accepts update types that differ from the stored types across every shipped reducer', () => {
    const outcome = apply({
      rounds: 4,
      notes: ['b', 'c'],
      tags: ['a', 'b'],
      reviewers: { op: 'add', values: [{ id: 'r2', name: 'Grace' }] },
      summary: { set: 'done' },
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.state.rounds, 5);
    assert.deepEqual(outcome.state.notes, ['first', 'b', 'c']);
    assert.deepEqual(outcome.state.tags, ['a', 'b'], 'union does not duplicate an existing member');
    assert.deepEqual(outcome.state.reviewers, [
      { id: 'r1', name: 'Ada' },
      { id: 'r2', name: 'Grace' },
    ]);
    assert.equal(outcome.state.summary, 'done');
  });

  it('clears and removes explicitly rather than by inference', () => {
    const cleared = apply({ summary: { clear: true }, reviewers: { op: 'remove', ids: ['r1'] } });
    assert.equal(cleared.ok, true);
    if (!cleared.ok) return;
    assert.equal(cleared.state.summary, null);
    assert.deepEqual(cleared.state.reviewers, []);

    const emptied = apply({ reviewers: { op: 'clear' } });
    assert.equal(emptied.ok, true);
    if (!emptied.ok) return;
    assert.deepEqual(emptied.state.reviewers, []);
  });

  it('rejects an own undefined rather than treating it as a clear', () => {
    const failure = expectFailure(apply({ summary: undefined }));
    assert.equal(failure.code, 'implicit_clear_rejected');
    assert.deepEqual(failure.detail?.field, 'summary');
  });

  it('rejects a key that names no declared field, naming the key and the graph', () => {
    const failure = expectFailure(apply({ nope: 1 }));
    assert.equal(failure.code, 'unknown_state_field');
    assert.deepEqual(failure.detail, { field: 'nope', graphKey: 'reviewed-document' });
  });

  it('rejects an update that is not a plain object', () => {
    assert.equal(expectFailure(apply(['rounds'])).code, 'invalid_update_shape');
    assert.equal(expectFailure(apply(7)).code, 'invalid_update_shape');
    assert.equal(expectFailure(apply(null)).code, 'invalid_update_shape');
  });

  it('never reaches a field reachable only through the prototype chain', () => {
    const failure = expectFailure(apply({ toString: 'nope' }));
    assert.equal(failure.code, 'unknown_state_field');
  });

  it('commits nothing when one reducer throws part-way through', () => {
    const exploding = {
      ...fields,
      rounds: field<number, number>({
        reduce: () => {
          throw new Error('reducer exploded');
        },
      }),
    } as unknown as AnyFields;
    const outcome = reduceState({
      fields: exploding,
      current,
      update: { title: 'changed', rounds: 1 },
      graphKey: 'reviewed-document',
    });
    const failure = expectFailure(outcome);
    assert.equal(failure.code, 'reducer_failed');
    assert.match(failure.message, /rounds/);
    assert.equal(current.title, 'draft', 'the earlier field was not written to the boundary');
  });

  it('reduces every field from the committed boundary, so reducers cannot observe each other', () => {
    const seen: unknown[] = [];
    const observing = {
      ...fields,
      title: field<string, string>({
        reduce: (currentValue, update) => {
          seen.push(currentValue);
          return update;
        },
      }),
      rounds: field<number, number>({
        reduce: (currentValue, update) => {
          seen.push(currentValue);
          return currentValue + update;
        },
      }),
    } as unknown as AnyFields;
    const outcome = reduceState({
      fields: observing,
      current,
      update: { title: 'next', rounds: 1 },
      graphKey: 'reviewed-document',
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(seen, ['draft', 1]);
  });

  it('rejects a reducer that returns a thenable', () => {
    const asyncField = {
      ...fields,
      title: field<string, string>({ reduce: () => Promise.resolve('x') as unknown as string }),
    } as unknown as AnyFields;
    const failure = expectFailure(
      reduceState({
        fields: asyncField,
        current,
        update: { title: 'next' },
        graphKey: 'reviewed-document',
      }),
    );
    assert.equal(failure.code, 'async_pure_callback');
  });

  it('rejects unserializable reduced values, naming the JSON path', () => {
    class Thing {
      readonly kind = 'thing';
    }
    for (const value of [new Date(), new Map(), new Thing()]) {
      const bad = {
        ...fields,
        title: field<string, string>({ reduce: () => value as unknown as string }),
      } as unknown as AnyFields;
      const failure = expectFailure(
        reduceState({
          fields: bad,
          current,
          update: { title: 'next' },
          graphKey: 'reviewed-document',
        }),
      );
      assert.equal(failure.code, 'unserializable_state');
      assert.equal(failure.detail?.path, 'title');
    }
  });

  it('rejects a cycle introduced by a reducer', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const bad = {
      ...fields,
      title: field<string, string>({ reduce: () => cyclic as unknown as string }),
    } as unknown as AnyFields;
    const failure = expectFailure(
      reduceState({ fields: bad, current, update: { title: 'x' }, graphKey: 'g' }),
    );
    assert.equal(failure.code, 'unserializable_state');
  });

  it('throws inside a reducer that mutates its isolated input rather than corrupting the boundary', () => {
    const mutating = {
      ...fields,
      notes: field<readonly string[], string>({
        reduce: (currentValue, update) => {
          (currentValue as string[]).push(update);
          return currentValue;
        },
      }),
    } as unknown as AnyFields;
    const failure = expectFailure(
      reduceState({ fields: mutating, current, update: { notes: 'x' }, graphKey: 'g' }),
    );
    assert.equal(failure.code, 'reducer_failed');
    assert.deepEqual(current.notes, ['first']);
  });
});

describe('assertDeclaredStateFields', () => {
  it('accepts a state whose every own key has a reducer', () => {
    assert.equal(
      assertDeclaredStateFields({ fields, state: current, graphKey: 'reviewed-document' }),
      null,
    );
  });

  it('names the undeclared field an init returned', () => {
    const failure = assertDeclaredStateFields({
      fields,
      state: { ...current, stray: 1 },
      graphKey: 'reviewed-document',
    });
    assert.equal(failure?.code, 'unknown_state_field');
    assert.match(failure?.message ?? '', /stray/);
  });

  it('rejects an init that returned something other than an object', () => {
    assert.equal(
      assertDeclaredStateFields({ fields, state: [], graphKey: 'g' })?.code,
      'invalid_update_shape',
    );
  });
});

describe('isolate', () => {
  it('deeply freezes the copy and leaves the source mutable', () => {
    const source = { nested: { list: [1, 2] } };
    const copy = isolate(source);
    assert.throws(() => {
      (copy.nested.list as number[]).push(3);
    });
    source.nested.list.push(3);
    assert.deepEqual(source.nested.list, [1, 2, 3]);
    assert.deepEqual(copy.nested.list, [1, 2]);
  });

  it('rejects a value that cannot be cloned', () => {
    assert.throws(() => isolate({ run: () => 1 }), /cannot be isolated/);
  });

  it('tolerates a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    const frozen = deepFreeze(cyclic);
    assert.equal(Object.isFrozen(frozen), true);
  });
});
