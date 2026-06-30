import type { HarnessObservationRecord } from '../projection.js';
import type { HarnessTurnEdge } from '../turns.js';

export function deriveOpenCodeTurnEdges(
  records: readonly HarnessObservationRecord[],
): readonly HarnessTurnEdge[] {
  const edges: HarnessTurnEdge[] = [];
  let terminalSeenForCurrentTurn = true;
  for (const record of records) {
    if (record.harness !== 'opencode') continue;
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
    if (terminalSeenForCurrentTurn) continue;
    if (record.nativeEvent === 'session.idle') {
      terminalSeenForCurrentTurn = true;
      edges.push({
        type: 'turn_ended',
        harnessSessionId: '',
        seq: record.seq,
        recordedAt: record.recordedAt,
      });
      continue;
    }
    if (record.nativeEvent === 'session.error') {
      terminalSeenForCurrentTurn = true;
      edges.push({
        type: 'turn_failed',
        harnessSessionId: '',
        seq: record.seq,
        recordedAt: record.recordedAt,
        reason: 'harness_error',
      });
    }
  }
  return edges;
}
