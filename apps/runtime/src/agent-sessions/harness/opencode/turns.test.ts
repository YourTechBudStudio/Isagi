import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { deriveOpenCodeTurnEdges } from './turns.js';

test('OpenCode turn edges start on chat.message and end on session.idle', () => {
  assert.deepEqual(
    deriveOpenCodeTurnEdges([record('chat.message', 0), record('session.idle', 1)]),
    [
      { type: 'turn_started', harnessSessionId: '', seq: 0, recordedAt: time(0) },
      { type: 'turn_ended', harnessSessionId: '', seq: 1, recordedAt: time(1) },
    ],
  );
});

test('OpenCode turn edges fail on session.error', () => {
  assert.deepEqual(
    deriveOpenCodeTurnEdges([record('chat.message', 0), record('session.error', 1)]),
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

function record(nativeEvent: string, seq: number): HarnessObservationRecord {
  return {
    recordedAt: time(seq),
    seq,
    ptyProcessId: 20,
    harness: 'opencode',
    nativeEvent,
    event: {
      nativeEvent,
      event: {
        type: nativeEvent,
        properties: { sessionID: 'opencode-session-1' },
      },
    },
  };
}

function time(index: number) {
  return `2026-06-18T00:00:0${index}.000Z`;
}
