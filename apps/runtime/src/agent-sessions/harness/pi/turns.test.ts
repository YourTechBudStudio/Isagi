import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { derivePiTurnEdges } from './turns.js';

test('Pi turn edges start and end a normal turn', () => {
  assert.deepEqual(
    derivePiTurnEdges([record('agent_start', 0), record('agent_end', 1, { pending: false })]),
    [
      { type: 'turn_started', harnessSessionId: '', seq: 0, recordedAt: time(0) },
      { type: 'turn_ended', harnessSessionId: '', seq: 1, recordedAt: time(1) },
    ],
  );
});

test('Pi turn edges do not end while pending messages are draining', () => {
  assert.deepEqual(
    derivePiTurnEdges([record('agent_start', 0), record('agent_end', 1, { pending: true })]),
    [{ type: 'turn_started', harnessSessionId: '', seq: 0, recordedAt: time(0) }],
  );
});

test('Pi turn edges use sanitized assistant stopReason as harness error source', () => {
  assert.deepEqual(
    derivePiTurnEdges([
      record('agent_start', 0),
      agentError(1, 'error'),
      record('agent_end', 2, { pending: false }),
    ]),
    [
      { type: 'turn_started', harnessSessionId: '', seq: 0, recordedAt: time(0) },
      {
        type: 'turn_failed',
        harnessSessionId: '',
        seq: 1,
        recordedAt: time(1),
        reason: 'harness_error',
      },
    ],
  );
});

function record(
  nativeEvent: 'agent_start' | 'agent_end',
  seq: number,
  options: { readonly pending?: boolean | null } = {},
): HarnessObservationRecord {
  return {
    recordedAt: time(seq),
    seq,
    ptyProcessId: 20,
    harness: 'pi',
    nativeEvent,
    event: {
      nativeEvent,
      context: { hasPendingMessages: options.pending ?? null },
    },
  };
}

function agentError(seq: number, stopReason: 'error' | 'aborted'): HarnessObservationRecord {
  return {
    recordedAt: time(seq),
    seq,
    ptyProcessId: 20,
    harness: 'pi',
    nativeEvent: 'agent_error',
    event: {
      nativeEvent: 'agent_error',
      sourceNativeEvent: 'message_end',
      stopReason,
      context: { hasPendingMessages: null },
    },
  };
}

function time(seq: number) {
  return `2026-06-18T00:00:0${seq}.000Z`;
}
