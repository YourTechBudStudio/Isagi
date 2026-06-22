import type { HarnessObservationRecord } from '../projection.js';
import type { HarnessTurnEdge } from '../turns.js';

export function deriveCodexTurnEdges(
  records: readonly HarnessObservationRecord[],
): readonly HarnessTurnEdge[] {
  const edges: HarnessTurnEdge[] = [];
  let terminalSeenForCurrentTurn = true;
  for (const record of records) {
    if (record.harness !== 'codex') continue;
    if (record.nativeEvent === 'UserPromptSubmit') {
      terminalSeenForCurrentTurn = false;
      edges.push({
        type: 'turn_started',
        harnessSessionId: '',
        seq: record.seq,
        recordedAt: record.recordedAt,
      });
      continue;
    }
    if (!terminalSeenForCurrentTurn && record.nativeEvent === 'Stop') {
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
