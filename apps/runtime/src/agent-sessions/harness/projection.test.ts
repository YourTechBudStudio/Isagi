import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentSessionHarnessJsonlRecord } from './ledger.js';
import { buildHarnessObservationProjection } from './projection.js';

test('projection assigns OpenCode seq after native-id canonical ordering', () => {
  const projection = buildHarnessObservationProjection([
    {
      path: '/tmp/opencode.harness.jsonl',
      ignoredLineCount: 0,
      records: [
        record({
          recordedAt: '2026-06-18T00:00:00.002Z',
          nativeEvent: 'session.idle',
          eventId: 'evt_edc18e4690011k2xiktqEoZ1ZO',
        }),
        record({
          recordedAt: '2026-06-18T00:00:00.001Z',
          nativeEvent: 'chat.message',
          eventId: 'evt_edc18e467001l6dAVUPbMoHzSd',
        }),
      ],
    },
  ]);

  const records = projection.recordsByHarnessSessionId.get('opencode-session-1') ?? [];
  assert.deepEqual(
    records.map((entry) => [entry.nativeEvent, entry.seq]),
    [
      ['chat.message', 0],
      ['session.idle', 1],
    ],
  );
});

function record(input: {
  readonly recordedAt: string;
  readonly nativeEvent: string;
  readonly eventId: string;
}): AgentSessionHarnessJsonlRecord {
  return {
    schemaVersion: 1,
    recordedAt: input.recordedAt,
    agentSessionId: 10,
    harnessSessionId: 'opencode-session-1',
    ptyProcessId: 20,
    harness: 'opencode',
    nativeEvent: input.nativeEvent,
    event: {
      nativeEvent: input.nativeEvent,
      event: {
        id: input.eventId,
        type: input.nativeEvent,
        properties: { sessionID: 'opencode-session-1' },
      },
    },
  };
}
