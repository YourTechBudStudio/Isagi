import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTerminalReplayGate } from './replay-gate.js';

const ANSI_REPLAY = ['\u001b[2J', 'first\r\n', '\u001b[?2026hpartial'];

describe('terminal replay gate', () => {
  it('writes ANSI-shaped replay bytes before held live bytes exactly once', () => {
    const writes: string[] = [];
    const gate = createTerminalReplayGate({ write: (data) => writes.push(data) });
    for (const chunk of ANSI_REPLAY) gate.pushOutput(chunk);
    assert.equal(gate.beginSettling(), true);
    gate.pushOutput(' live-one');
    gate.pushOutput('\u001b[?2026l live-two');

    assert.deepEqual(writes, ANSI_REPLAY);
    assert.equal(gate.reveal(), true);
    assert.equal(gate.reveal(), false);
    assert.equal(gate.drain(), true);
    assert.equal(gate.drain(), false);
    assert.deepEqual(writes, [...ANSI_REPLAY, ' live-one', '\u001b[?2026l live-two']);
  });

  it('rejects an overflowing UTF-8 chunk atomically and clears held data', () => {
    const writes: string[] = [];
    const gate = createTerminalReplayGate({
      write: (data) => writes.push(data),
      byteLength: (data) => (data === 'overflow' ? 8 * 1024 * 1024 : 1),
    });
    gate.beginSettling();
    gate.pushOutput('held');
    const failure = gate.pushOutput('overflow');

    assert.deepEqual(failure, {
      type: 'held_live_overflow',
      limitBytes: 8 * 1024 * 1024,
      heldBytes: 1,
      incomingBytes: 8 * 1024 * 1024,
    });
    assert.equal(gate.reveal(), false);
    assert.equal(gate.drain(), false);
    assert.deepEqual(writes, []);
  });

  it('cancellation prevents reveal, drain, and later delivery', () => {
    const writes: string[] = [];
    const gate = createTerminalReplayGate({ write: (data) => writes.push(data) });
    gate.beginSettling();
    gate.pushOutput('held');
    gate.cancel();

    assert.equal(gate.reveal(), false);
    assert.equal(gate.drain(), false);
    gate.pushOutput('stale');
    assert.deepEqual(writes, []);
  });
});
