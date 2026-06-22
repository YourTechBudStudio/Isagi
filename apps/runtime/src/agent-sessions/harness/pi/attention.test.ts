import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { derivePiRunningAttention } from './attention.js';

test('Pi running attention uses agent_start and agent_end pending-message semantics', () => {
  assert.equal(derivePiRunningAttention([]), 'idle');
  assert.equal(derivePiRunningAttention([record('agent_start')]), 'working');
  assert.equal(derivePiRunningAttention([record('agent_end', false)]), 'waiting');
  assert.equal(derivePiRunningAttention([record('agent_end', true)]), 'working');
  assert.equal(derivePiRunningAttention([record('agent_end', null)]), 'waiting');
});

test('Pi running attention ignores non-Pi records', () => {
  assert.equal(
    derivePiRunningAttention([
      { ...record('agent_end', false), harness: 'opencode' },
      record('agent_start'),
    ]),
    'working',
  );
});

function record(
  nativeEvent: 'agent_start' | 'agent_end',
  hasPendingMessages: boolean | null = null,
): HarnessObservationRecord {
  return {
    recordedAt: new Date().toISOString(),
    harness: 'pi',
    nativeEvent,
    event: {
      nativeEvent,
      context: { hasPendingMessages },
    },
  };
}
