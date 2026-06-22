import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { deriveOpenCodeRunningAttention } from './attention.js';

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

test('OpenCode running attention orders native events when async JSONL appends invert records', () => {
  assert.equal(
    deriveOpenCodeRunningAttention([
      nestedRecord({ type: 'idle' }, 'evt_edc18e4690011k2xiktqEoZ1ZO'),
      nestedRecord({ type: 'busy' }, 'evt_edc18e467001l6dAVUPbMoHzSd'),
    ]),
    'waiting',
  );
});

function record(status: string | { readonly type: string }): HarnessObservationRecord {
  return {
    recordedAt: new Date().toISOString(),
    seq: 0,
    ptyProcessId: 20,
    harness: 'opencode',
    nativeEvent: 'session.status',
    event: {
      nativeEvent: 'session.status',
      status,
    },
  };
}

function nestedRecord(
  status: string | { readonly type: string },
  id = 'evt_1',
): HarnessObservationRecord {
  return {
    recordedAt: '2026-06-18T18:57:59.420Z',
    seq: 0,
    ptyProcessId: 20,
    harness: 'opencode',
    nativeEvent: 'session.status',
    event: {
      nativeEvent: 'session.status',
      event: {
        id,
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
