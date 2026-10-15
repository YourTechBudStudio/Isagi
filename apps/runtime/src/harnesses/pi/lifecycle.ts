import type { ActiveHarnessTurn, HarnessLifecycleResult, HarnessTurnEdge } from '../lifecycle.js';
import type { HarnessObservationRecord } from '../projection.js';
import { derivePiRunningAttention } from './attention.js';
import { derivePiTurnEdges } from './turns.js';

/**
 * Pi deliberately keeps its proven extension semantics while sharing the
 * authoritative lifecycle result consumed by the observer.
 */
export function reducePiLifecycle(
  records: readonly HarnessObservationRecord[],
): HarnessLifecycleResult {
  const edges = derivePiTurnEdges(records);
  let activeTurn: ActiveHarnessTurn | null = null;
  const terminalEdges: Extract<HarnessTurnEdge, { readonly type: 'turn_ended' | 'turn_failed' }>[] =
    [];
  for (const edge of edges) {
    if (edge.type === 'turn_started') {
      if (activeTurn) {
        terminalEdges.push({
          type: 'turn_failed',
          harnessSessionId: '',
          seq: activeTurn.seq,
          recordedAt: edge.recordedAt,
          reason: 'new_start_supersedes',
        });
      }
      activeTurn = activeTurnForRecord(edge, records);
      continue;
    }
    if (activeTurn && (edge.type === 'turn_ended' || edge.type === 'turn_failed')) {
      terminalEdges.push({ ...edge, seq: activeTurn.seq });
      activeTurn = null;
    }
  }
  const lastTerminal = terminalEdges.at(-1);
  const attention =
    !activeTurn && lastTerminal?.type === 'turn_failed'
      ? 'error'
      : derivePiRunningAttention(records);
  return {
    activeTurn,
    terminalEdges,
    attention,
    diagnostics: [],
  };
}

function activeTurnForRecord(
  edge: Extract<HarnessTurnEdge, { readonly type: 'turn_started' }>,
  records: readonly HarnessObservationRecord[],
): ActiveHarnessTurn {
  const record = records.find((candidate) => candidate.seq === edge.seq);
  return {
    seq: edge.seq,
    recordedAt: edge.recordedAt,
    incarnation: record?.incarnation ?? null,
  };
}
