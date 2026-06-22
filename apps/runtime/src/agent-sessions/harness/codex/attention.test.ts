import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { deriveCodexRunningAttention } from './attention.js';

test('Codex running attention treats prompt submit as working and stop as waiting', () => {
  assert.equal(deriveCodexRunningAttention([]), 'idle');
  assert.equal(deriveCodexRunningAttention([record('UserPromptSubmit')]), 'working');
  assert.equal(deriveCodexRunningAttention([record('Stop')]), 'waiting');
});

test('Codex running attention ignores non-Codex and unsupported records', () => {
  assert.equal(
    deriveCodexRunningAttention([
      { ...record('Stop'), harness: 'claude' },
      { ...record('Stop'), nativeEvent: 'SessionStart' },
      record('UserPromptSubmit'),
    ]),
    'working',
  );
});

function record(nativeEvent: string): HarnessObservationRecord {
  return {
    recordedAt: new Date().toISOString(),
    harness: 'codex',
    nativeEvent,
    event: {
      nativeEvent,
      notificationType: null,
      input: { hook_event_name: nativeEvent },
    },
  };
}
