import type { AttentionState } from '@isagi/contracts';

import type { HarnessObservationRecord } from './projection.js';

export function deriveClaudeRunningAttention(
  records: readonly HarnessObservationRecord[],
): AttentionState {
  const latest = latestRelevantClaudeRecord(records);
  if (!latest) return 'idle';
  if (latest.nativeEvent === 'UserPromptSubmit') return 'working';
  if (latest.nativeEvent === 'Stop') return 'waiting';
  if (latest.nativeEvent === 'StopFailure') return 'error';
  if (latest.nativeEvent === 'Notification' && notificationType(latest) === 'idle_prompt') {
    return 'waiting';
  }
  return 'idle';
}

function latestRelevantClaudeRecord(records: readonly HarnessObservationRecord[]) {
  return records
    .filter(
      (record) =>
        record.harness === 'claude' &&
        (record.nativeEvent === 'UserPromptSubmit' ||
          record.nativeEvent === 'Notification' ||
          record.nativeEvent === 'Stop' ||
          record.nativeEvent === 'StopFailure'),
    )
    .at(-1);
}

function notificationType(record: HarnessObservationRecord) {
  const event = record.event;
  if (!event || typeof event !== 'object') return null;
  const envelope = event as {
    readonly notificationType?: unknown;
    readonly input?: { readonly notification_type?: unknown };
  };
  const type = envelope.notificationType ?? envelope.input?.notification_type;
  return typeof type === 'string' && type ? type : null;
}
