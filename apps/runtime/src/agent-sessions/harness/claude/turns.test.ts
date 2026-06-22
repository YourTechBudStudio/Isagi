import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { deriveClaudeTurnEdges } from './turns.js';

test('Claude turn edges start on prompts and end on Stop', () => {
  assert.deepEqual(deriveClaudeTurnEdges([record('UserPromptSubmit', 0), record('Stop', 1)]), [
    { type: 'turn_started', harnessSessionId: '', seq: 0, recordedAt: time(0) },
    { type: 'turn_ended', harnessSessionId: '', seq: 1, recordedAt: time(1) },
  ]);
});

test('Claude turn edges fail on StopFailure and ignore subagent records', () => {
  assert.deepEqual(
    deriveClaudeTurnEdges([
      record('UserPromptSubmit', 0),
      record('SubagentStop', 1),
      record('StopFailure', 2),
    ]),
    [
      { type: 'turn_started', harnessSessionId: '', seq: 0, recordedAt: time(0) },
      {
        type: 'turn_failed',
        harnessSessionId: '',
        seq: 2,
        recordedAt: time(2),
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
    harness: 'claude',
    nativeEvent,
    event: {
      nativeEvent,
      notificationType: null,
      input: { hook_event_name: nativeEvent },
    },
  };
}

function time(index: number) {
  return `2026-06-18T00:00:0${index}.000Z`;
}
