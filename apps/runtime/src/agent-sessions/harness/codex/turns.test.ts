import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { deriveCodexTurnEdges } from './turns.js';

test('Codex turn edges start on prompts and end on Stop', () => {
  assert.deepEqual(deriveCodexTurnEdges([record('UserPromptSubmit', 0), record('Stop', 1)]), [
    { type: 'turn_started', harnessSessionId: '', seq: 0, recordedAt: time(0) },
    { type: 'turn_ended', harnessSessionId: '', seq: 1, recordedAt: time(1) },
  ]);
});

test('Codex turn edges use the first Stop for a turn and ignore unsupported records', () => {
  assert.deepEqual(
    deriveCodexTurnEdges([
      record('SessionStart', 0),
      record('UserPromptSubmit', 1),
      record('Stop', 2, { turn_id: 'turn-1' }),
      record('Stop', 3, { turn_id: 'turn-1' }),
    ]),
    [
      { type: 'turn_started', harnessSessionId: '', seq: 1, recordedAt: time(1) },
      { type: 'turn_ended', harnessSessionId: '', seq: 2, recordedAt: time(2) },
    ],
  );
});

function record(
  nativeEvent: string,
  seq: number,
  input: Record<string, unknown> = {},
): HarnessObservationRecord {
  return {
    recordedAt: time(seq),
    seq,
    ptyProcessId: 20,
    harness: 'codex',
    nativeEvent,
    event: {
      nativeEvent,
      notificationType: null,
      input: { hook_event_name: nativeEvent, ...input },
    },
  };
}

function time(index: number) {
  return `2026-06-18T00:00:0${index}.000Z`;
}
