import type { AgentHarness } from '@isagi/contracts';

export interface HarnessObservationRecord {
  readonly recordedAt: string;
  readonly seq: number;
  readonly ptyProcessId: number | null;
  readonly harness: AgentHarness;
  readonly nativeEvent: string;
  readonly event: unknown;
}

export interface HarnessObservationProjection {
  readonly recordsByHarnessSessionId: ReadonlyMap<string, readonly HarnessObservationRecord[]>;
}

export function harnessObservationProjectionFromRecords(
  recordsByHarnessSessionId: ReadonlyMap<string, readonly HarnessObservationRecord[]>,
): HarnessObservationProjection {
  return { recordsByHarnessSessionId };
}

export function emptyHarnessObservationProjection(): HarnessObservationProjection {
  return { recordsByHarnessSessionId: new Map() };
}
