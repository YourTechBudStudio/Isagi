import type { HarnessObservationRecord } from '../projection.js';

export function compareOpenCodeRecords(
  left: HarnessObservationRecord,
  right: HarnessObservationRecord,
) {
  const leftKey = openCodeOrderKey(left);
  const rightKey = openCodeOrderKey(right);
  if (leftKey && rightKey && leftKey !== rightKey) return leftKey.localeCompare(rightKey);
  return left.recordedAt.localeCompare(right.recordedAt);
}

function openCodeOrderKey(record: HarnessObservationRecord) {
  const event = record.event;
  if (!event || typeof event !== 'object') return null;
  const object = event as {
    readonly orderKey?: unknown;
    readonly event?: { readonly id?: unknown };
  };
  return stringValue(object.orderKey) ?? sortableOpenCodeId(stringValue(object.event?.id));
}

function sortableOpenCodeId(id: string | null) {
  if (!id) return null;
  const separator = id.indexOf('_');
  return separator >= 0 ? id.slice(separator + 1) : id;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : null;
}
