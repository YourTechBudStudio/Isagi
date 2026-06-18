import type { AgentHarness } from '@isagi/contracts';

import type { AgentSessionHarnessJsonlRead } from '../artifacts.js';

export interface HarnessObservationRecord {
  readonly recordedAt: string;
  readonly harness: AgentHarness;
  readonly nativeEvent: string;
  readonly event: unknown;
}

export interface HarnessObservationProjection {
  readonly fingerprint: string;
  readonly recordsByPtyProcessId: ReadonlyMap<number, readonly HarnessObservationRecord[]>;
}

export function buildHarnessObservationProjection(
  jsonlReads: readonly AgentSessionHarnessJsonlRead[],
): HarnessObservationProjection {
  const recordsByPtyProcessId = new Map<number, HarnessObservationRecord[]>();
  for (const read of jsonlReads) {
    for (const record of read.records) {
      const existing = recordsByPtyProcessId.get(record.ptyProcessId) ?? [];
      existing.push({
        recordedAt: record.recordedAt,
        harness: record.harness,
        nativeEvent: record.nativeEvent,
        event: record.event,
      });
      recordsByPtyProcessId.set(record.ptyProcessId, existing);
    }
  }
  for (const records of recordsByPtyProcessId.values()) {
    records.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }
  return {
    fingerprint: JSON.stringify(
      [...recordsByPtyProcessId.entries()].map(([ptyProcessId, records]) => [
        ptyProcessId,
        records.map((record) => [
          record.recordedAt,
          record.harness,
          record.nativeEvent,
          record.event,
        ]),
      ]),
    ),
    recordsByPtyProcessId,
  };
}

export function emptyHarnessObservationProjection(): HarnessObservationProjection {
  return { fingerprint: '[]', recordsByPtyProcessId: new Map() };
}
