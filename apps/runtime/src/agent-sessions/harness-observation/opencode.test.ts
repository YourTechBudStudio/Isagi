import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveOpenCodeRunningAttention } from './opencode.js';
import type { HarnessObservationRecord } from './projection.js';

test('OpenCode running attention uses session.status only', () => {
  assert.equal(deriveOpenCodeRunningAttention([]), 'idle');
  assert.equal(deriveOpenCodeRunningAttention([record('busy')]), 'working');
  assert.equal(deriveOpenCodeRunningAttention([record({ type: 'busy' })]), 'working');
  assert.equal(deriveOpenCodeRunningAttention([record('idle')]), 'waiting');
  assert.equal(deriveOpenCodeRunningAttention([nestedRecord({ type: 'idle' })]), 'waiting');
  assert.equal(deriveOpenCodeRunningAttention([record('error')]), 'error');
  assert.equal(deriveOpenCodeRunningAttention([record('unknown')]), 'idle');
});

test('OpenCode running attention ignores non-status and non-OpenCode records', () => {
  assert.equal(
    deriveOpenCodeRunningAttention([
      { ...record('idle'), nativeEvent: 'session.idle' },
      { ...record('idle'), harness: 'pi' },
      record('busy'),
    ]),
    'working',
  );
});

function record(status: string | { readonly type: string }): HarnessObservationRecord {
  return {
    recordedAt: new Date().toISOString(),
    harness: 'opencode',
    nativeEvent: 'session.status',
    event: {
      nativeEvent: 'session.status',
      status,
    },
  };
}

function nestedRecord(status: string | { readonly type: string }): HarnessObservationRecord {
  return {
    recordedAt: new Date().toISOString(),
    harness: 'opencode',
    nativeEvent: 'session.status',
    event: {
      nativeEvent: 'session.status',
      event: {
        id: 'evt_1',
        type: 'session.status',
        properties: {
          sessionID: 'ses_1',
          status,
        },
      },
      status: null,
    },
  };
}
