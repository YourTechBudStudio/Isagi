import type { AttentionState } from '@isagi/contracts';

import type { HarnessObservationRecord } from './projection.js';

export function derivePiRunningAttention(
  records: readonly HarnessObservationRecord[],
): AttentionState {
  const latest = latestRelevantPiRecord(records);
  if (!latest) return 'idle';
  if (latest.nativeEvent === 'agent_start') return 'working';
  if (latest.nativeEvent === 'agent_end') {
    const pending = pendingState(latest);
    return pending === false ? 'waiting' : pending === true ? 'working' : 'idle';
  }
  return 'idle';
}

function latestRelevantPiRecord(records: readonly HarnessObservationRecord[]) {
  return records
    .filter(
      (record) =>
        record.harness === 'pi' &&
        (record.nativeEvent === 'agent_start' || record.nativeEvent === 'agent_end'),
    )
    .at(-1);
}

function pendingState(record: HarnessObservationRecord) {
  const event = record.event;
  if (!event || typeof event !== 'object') return null;
  const context = (event as { readonly context?: unknown }).context;
  if (!context || typeof context !== 'object') return null;
  const pending = (context as { readonly hasPendingMessages?: unknown }).hasPendingMessages;
  return typeof pending === 'boolean' ? pending : null;
}
