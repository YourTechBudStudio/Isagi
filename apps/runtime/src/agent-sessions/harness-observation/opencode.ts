import type { AttentionState } from '@isagi/contracts';

import type { HarnessObservationRecord } from './projection.js';

export function deriveOpenCodeRunningAttention(
  records: readonly HarnessObservationRecord[],
): AttentionState {
  const latest = latestRelevantOpenCodeRecord(records);
  if (!latest) return 'idle';

  const status = openCodeSessionStatus(latest);
  if (status === 'busy') return 'working';
  if (status === 'idle') return 'waiting';
  if (status === 'error' || status === 'failed') return 'error';
  return 'idle';
}

function latestRelevantOpenCodeRecord(records: readonly HarnessObservationRecord[]) {
  return records
    .filter((record) => record.harness === 'opencode' && record.nativeEvent === 'session.status')
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

function compareOpenCodeRecords(left: HarnessObservationRecord, right: HarnessObservationRecord) {
  const leftId = openCodeEventId(left);
  const rightId = openCodeEventId(right);
  if (leftId && rightId && leftId !== rightId) return leftId.localeCompare(rightId);
  return left.recordedAt.localeCompare(right.recordedAt);
}

function openCodeEventId(record: HarnessObservationRecord) {
  const event = record.event;
  if (!event || typeof event !== 'object') return null;
  const id = (event as { readonly event?: { readonly id?: unknown } }).event?.id;
  return typeof id === 'string' && id ? id : null;
}

function statusValue(status: unknown) {
  if (typeof status === 'string' && status) return status;
  if (status && typeof status === 'object') {
    const type = (status as { readonly type?: unknown }).type;
    if (typeof type === 'string' && type) return type;
  }
  return null;
}
