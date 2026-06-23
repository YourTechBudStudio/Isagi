import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentHarness } from '@isagi/contracts';

import type { HarnessObservationRecord } from './projection.js';
import { deriveHarnessTurnEdges } from './turns.js';

test('generic turn derivation fails an in-flight turn superseded by a new start', () => {
  const cases: readonly {
    readonly harness: AgentHarness;
    readonly startEvent: string;
  }[] = [
    { harness: 'pi', startEvent: 'agent_start' },
    { harness: 'opencode', startEvent: 'chat.message' },
    { harness: 'claude', startEvent: 'UserPromptSubmit' },
    { harness: 'codex', startEvent: 'UserPromptSubmit' },
  ];

  for (const { harness, startEvent } of cases) {
    assert.deepEqual(
      deriveHarnessTurnEdges(harness, [
        record(harness, startEvent, 0),
        record(harness, startEvent, 1),
      ]),
      [
        { type: 'turn_started', harnessSessionId: '', seq: 0, recordedAt: time(0) },
        {
          type: 'turn_failed',
          harnessSessionId: '',
          seq: null,
          recordedAt: time(0),
          reason: 'new_start_supersedes',
        },
        { type: 'turn_started', harnessSessionId: '', seq: 1, recordedAt: time(1) },
      ],
      harness,
    );
  }
});

function record(harness: AgentHarness, nativeEvent: string, seq: number): HarnessObservationRecord {
  return {
    recordedAt: time(seq),
    seq,
    ptyProcessId: 20 + seq,
    harness,
    nativeEvent,
    event: { nativeEvent, input: { hook_event_name: nativeEvent } },
  };
}

function time(index: number) {
  return `2026-06-18T00:00:0${index}.000Z`;
}
