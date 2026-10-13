import type { AgentHarness } from '@isagi/contracts';

import type { Incarnation } from './incarnation.js';

export interface HarnessObservationRecord {
  readonly recordedAt: string;
  readonly seq: number;
  /** The execution that wrote this hook record, or `null` when it carries no marker. */
  readonly incarnation: Incarnation | null;
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
