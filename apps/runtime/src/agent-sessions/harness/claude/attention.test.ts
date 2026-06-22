import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { deriveClaudeRunningAttention } from './attention.js';

test('Claude running attention treats prompt submit as working and stop as waiting', () => {
  assert.equal(deriveClaudeRunningAttention([]), 'idle');
  assert.equal(deriveClaudeRunningAttention([record('UserPromptSubmit')]), 'working');
  assert.equal(deriveClaudeRunningAttention([record('Stop')]), 'waiting');
  assert.equal(deriveClaudeRunningAttention([record('StopFailure')]), 'error');
});

test('Claude running attention treats idle notification as waiting', () => {
  assert.equal(deriveClaudeRunningAttention([notificationRecord('idle_prompt')]), 'waiting');
  assert.equal(deriveClaudeRunningAttention([notificationRecord('permission_prompt')]), 'idle');
  assert.equal(deriveClaudeRunningAttention([nestedNotificationRecord('idle_prompt')]), 'waiting');
});

test('Claude running attention ignores non-Claude records', () => {
  assert.equal(
    deriveClaudeRunningAttention([
      { ...record('Stop'), harness: 'codex' },
      record('UserPromptSubmit'),
    ]),
    'working',
  );
});

function record(
  nativeEvent: 'UserPromptSubmit' | 'Stop' | 'StopFailure',
): HarnessObservationRecord {
  return {
    recordedAt: new Date().toISOString(),
    harness: 'claude',
    nativeEvent,
    event: {
      nativeEvent,
      notificationType: null,
      input: { hook_event_name: nativeEvent },
    },
  };
}

function notificationRecord(notificationType: string): HarnessObservationRecord {
  return {
    recordedAt: new Date().toISOString(),
    harness: 'claude',
    nativeEvent: 'Notification',
    event: {
      nativeEvent: 'Notification',
      notificationType,
      input: { hook_event_name: 'Notification', notification_type: notificationType },
    },
  };
}

function nestedNotificationRecord(notificationType: string): HarnessObservationRecord {
  return {
    recordedAt: new Date().toISOString(),
    harness: 'claude',
    nativeEvent: 'Notification',
    event: {
      nativeEvent: 'Notification',
      input: { hook_event_name: 'Notification', notification_type: notificationType },
    },
  };
}
