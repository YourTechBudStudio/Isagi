import type { HarnessObservationRecord } from '../projection.js';

export function compareOpenCodeRecords(
  left: HarnessObservationRecord,
  right: HarnessObservationRecord,
) {
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
