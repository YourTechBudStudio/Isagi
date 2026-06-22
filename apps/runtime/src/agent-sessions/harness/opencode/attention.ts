import type { AttentionState } from '@isagi/contracts';

import type { HarnessObservationRecord } from '../projection.js';
import { compareOpenCodeRecords } from './order.js';

export function deriveOpenCodeRunningAttention(
  records: readonly HarnessObservationRecord[],
): AttentionState {
  const latest = latestRelevantOpenCodeRecord(records);
  if (!latest) return 'idle';
  if (latest.nativeEvent === 'session.error') return 'error';

  const status = openCodeSessionStatus(latest);
  if (status === 'busy') return 'working';
  if (status === 'idle') return 'waiting';
  return 'idle';
}

function latestRelevantOpenCodeRecord(records: readonly HarnessObservationRecord[]) {
  return records
    .filter(
      (record) =>
        record.harness === 'opencode' &&
        (record.nativeEvent === 'session.status' || record.nativeEvent === 'session.error'),
    )
    .sort(compareOpenCodeRecords)
    .at(-1);
}

function openCodeSessionStatus(record: HarnessObservationRecord) {
  const event = record.event;
  if (!event || typeof event !== 'object') return null;
  const envelope = event as {
    readonly status?: unknown;
    readonly event?: {
      readonly status?: unknown;
      readonly properties?: {
        readonly status?: unknown;
        readonly session?: { readonly status?: unknown };
      };
    };
  };
  return (
    statusValue(envelope.status) ??
    statusValue(envelope.event?.properties?.status) ??
    statusValue(envelope.event?.properties?.session?.status) ??
    statusValue(envelope.event?.status) ??
    null
  );
}

function statusValue(status: unknown) {
  if (typeof status === 'string' && status) return status;
  if (status && typeof status === 'object') {
    const type = (status as { readonly type?: unknown }).type;
    if (typeof type === 'string' && type) return type;
  }
  return null;
}
