import type { HarnessObservationRecord } from '../projection.js';
import type { HarnessTurnEdge } from '../turns.js';

export function deriveClaudeTurnEdges(
  records: readonly HarnessObservationRecord[],
): readonly HarnessTurnEdge[] {
  const edges: HarnessTurnEdge[] = [];
  for (const record of records) {
    if (record.harness !== 'claude') continue;
    if (record.nativeEvent === 'UserPromptSubmit') {
      edges.push({
        type: 'turn_started',
        harnessSessionId: '',
        seq: record.seq,
        recordedAt: record.recordedAt,
      });
      continue;
    }
    if (record.nativeEvent === 'Stop') {
      edges.push({
        type: 'turn_ended',
        harnessSessionId: '',
        seq: record.seq,
        recordedAt: record.recordedAt,
      });
      continue;
    }
    if (record.nativeEvent === 'StopFailure') {
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
