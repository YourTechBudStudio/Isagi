import type { HarnessObservationRecord } from '../projection.js';
import type { HarnessTurnEdge } from '../turns.js';

export function derivePiTurnEdges(
  records: readonly HarnessObservationRecord[],
): readonly HarnessTurnEdge[] {
  const edges: HarnessTurnEdge[] = [];
  let terminalSeenForCurrentTurn = false;
  for (const record of records) {
    if (record.harness !== 'pi') continue;
    if (record.nativeEvent === 'agent_start') {
      terminalSeenForCurrentTurn = false;
      edges.push({
        type: 'turn_started',
        harnessSessionId: '',
        seq: record.seq,
        recordedAt: record.recordedAt,
      });
      continue;
    }
    if (
      !terminalSeenForCurrentTurn &&
      record.nativeEvent === 'agent_error' &&
      piStopReason(record) !== null
    ) {
      terminalSeenForCurrentTurn = true;
      edges.push({
        type: 'turn_failed',
        harnessSessionId: '',
        seq: record.seq,
        recordedAt: record.recordedAt,
        reason: 'harness_error',
      });
      continue;
    }
    if (
      !terminalSeenForCurrentTurn &&
      record.nativeEvent === 'agent_end' &&
      pendingState(record) !== true
    ) {
      terminalSeenForCurrentTurn = true;
      edges.push({
        type: 'turn_ended',
        harnessSessionId: '',
        seq: record.seq,
        recordedAt: record.recordedAt,
      });
    }
  }
  return edges;
}

function piStopReason(record: HarnessObservationRecord): 'error' | 'aborted' | null {
  const event = eventObject(record.event);
  const stopReason = event.stopReason;
  return stopReason === 'error' || stopReason === 'aborted' ? stopReason : null;
}

function pendingState(record: HarnessObservationRecord): boolean | null {
  const event = eventObject(record.event);
  const context = eventObject(event.context);
  return typeof context.hasPendingMessages === 'boolean' ? context.hasPendingMessages : null;
}

function eventObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
