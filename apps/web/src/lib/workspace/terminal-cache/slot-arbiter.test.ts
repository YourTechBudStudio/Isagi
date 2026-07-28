import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTerminalSlotArbiter } from './slot-arbiter.js';

describe('terminal destination slot arbitration', () => {
  it('gives the stable host to the newest slot and falls back through remaining live slots', () => {
    const moves: string[] = [];
    let empty = 0;
    const arbiter = createTerminalSlotArbiter(() => {
      empty += 1;
    });
    const first = arbiter.register({ appendHost: () => moves.push('first') });
    const second = arbiter.register({ appendHost: () => moves.push('second') });
    const third = arbiter.register({ appendHost: () => moves.push('third') });

    second.release();
    assert.deepEqual(moves, ['first', 'second', 'third']);
    third.release();
    assert.deepEqual(moves, ['first', 'second', 'third', 'first']);
    first.release();
    first.release();
    assert.equal(empty, 1);
  });
});
