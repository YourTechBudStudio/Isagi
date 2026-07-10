import assert from 'node:assert/strict';
import test from 'node:test';

import { reducePiLifecycle } from './lifecycle.js';
import type { HarnessObservationRecord } from './projection.js';

test('shared lifecycle surface delegates Pi to its existing start/end and pending-message semantics', () => {
  const records: HarnessObservationRecord[] = [
    record('agent_start', 0, null),
    record('agent_end', 1, true),
    record('agent_end', 2, false),
  ];
  const lifecycle = reducePiLifecycle(records);
  assert.equal(lifecycle.activeTurn, null);
  assert.equal(lifecycle.attention, 'waiting');
  assert.deepEqual(lifecycle.terminalEdges, [
    { type: 'turn_ended', harnessSessionId: '', seq: 0, recordedAt: time(2) },
  ]);
});

test('Pi explicit abort fails the active turn and drives error attention', () => {
  const lifecycle = reducePiLifecycle([
    record('agent_start', 0, null),
    {
      ...record('agent_error', 1, null),
      event: { stopReason: 'aborted' },
    },
  ]);
  assert.equal(lifecycle.terminalEdges[0]?.type, 'turn_failed');
  assert.equal(lifecycle.attention, 'error');
});

function record(
  nativeEvent: string,
  seq: number,
  pending: boolean | null,
): HarnessObservationRecord {
  return {
    recordedAt: time(seq),
    seq,
    ptyProcessId: 20,
    harness: 'pi',
    nativeEvent,
    event: { context: { hasPendingMessages: pending } },
  };
}

function time(index: number) {
  return `2026-07-09T00:00:0${index}.000Z`;
}
