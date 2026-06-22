import type { AgentHarness } from '@isagi/contracts';

import type { AgentSessionHarnessJsonlRead } from './ledger.js';
import { compareOpenCodeRecords } from './opencode/order.js';

export interface HarnessObservationRecord {
  readonly recordedAt: string;
  readonly seq: number;
  readonly ptyProcessId: number | null;
  readonly harness: AgentHarness;
  readonly nativeEvent: string;
  readonly event: unknown;
}

export interface HarnessObservationProjection {
  readonly fingerprint: string;
  readonly recordsByHarnessSessionId: ReadonlyMap<string, readonly HarnessObservationRecord[]>;
}

export function buildHarnessObservationProjection(
  jsonlReads: readonly AgentSessionHarnessJsonlRead[],
): HarnessObservationProjection {
  const recordsByHarnessSessionId = new Map<string, HarnessObservationRecord[]>();
  for (const read of jsonlReads) {
    for (const record of read.records) {
      const existing = recordsByHarnessSessionId.get(record.harnessSessionId) ?? [];
      existing.push({
        recordedAt: record.recordedAt,
        seq: 0,
        ptyProcessId: record.ptyProcessId,
        harness: record.harness,
        nativeEvent: record.nativeEvent,
        event: record.event,
      });
      recordsByHarnessSessionId.set(record.harnessSessionId, existing);
    }
  }
  for (const records of recordsByHarnessSessionId.values()) {
    records.sort(recordComparator(records));
    records.forEach((record, index) => {
      records[index] = { ...record, seq: index };
    });
  }
  const sortedEntries = [...recordsByHarnessSessionId.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return {
    fingerprint: JSON.stringify(
      sortedEntries.map(([harnessSessionId, records]) => [
        harnessSessionId,
        records.map((record) => [
          record.recordedAt,
          record.harness,
          record.nativeEvent,
          record.event,
        ]),
      ]),
    ),
    recordsByHarnessSessionId,
  };
}

export function emptyHarnessObservationProjection(): HarnessObservationProjection {
  return { fingerprint: '[]', recordsByHarnessSessionId: new Map() };
}

function recordComparator(records: readonly HarnessObservationRecord[]) {
  if (records[0]?.harness === 'opencode') return compareOpenCodeRecords;
  return (left: HarnessObservationRecord, right: HarnessObservationRecord) =>
    left.recordedAt.localeCompare(right.recordedAt);
}
