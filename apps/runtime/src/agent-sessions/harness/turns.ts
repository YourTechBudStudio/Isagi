import type { AgentHarness } from '@isagi/contracts';

import { deriveClaudeTurnEdges } from './claude/turns.js';
import { deriveCodexTurnEdges } from './codex/turns.js';
import { deriveOpenCodeTurnEdges } from './opencode/turns.js';
import { derivePiTurnEdges } from './pi/turns.js';
import type { HarnessObservationRecord } from './projection.js';

export type HarnessTurnEdge =
  | {
      readonly type: 'turn_started';
      readonly harnessSessionId: string;
      readonly seq: number;
      readonly recordedAt: string;
    }
  | {
      readonly type: 'turn_ended';
      readonly harnessSessionId: string;
      readonly seq: number;
      readonly recordedAt: string;
    }
  | {
      readonly type: 'turn_failed';
      readonly harnessSessionId: string;
      readonly seq: number | null;
      readonly recordedAt: string;
      readonly reason: 'session_died' | 'harness_error' | 'new_start_supersedes';
    };

export function deriveHarnessTurnEdges(
  harness: AgentHarness,
  records: readonly HarnessObservationRecord[],
): readonly HarnessTurnEdge[] {
  if (harness === 'pi') return synthesizeSupersededTurns(derivePiTurnEdges(records));
  if (harness === 'opencode') {
    return synthesizeSupersededTurns(deriveOpenCodeTurnEdges(records));
  }
  if (harness === 'claude') return synthesizeSupersededTurns(deriveClaudeTurnEdges(records));
  if (harness === 'codex') return synthesizeSupersededTurns(deriveCodexTurnEdges(records));
  return [];
}

function synthesizeSupersededTurns(edges: readonly HarnessTurnEdge[]): readonly HarnessTurnEdge[] {
  const synthesized: HarnessTurnEdge[] = [];
  let activeStart: Extract<HarnessTurnEdge, { readonly type: 'turn_started' }> | null = null;

  for (const edge of edges) {
    if (edge.type === 'turn_started') {
      if (activeStart) {
        synthesized.push({
          type: 'turn_failed',
          harnessSessionId: activeStart.harnessSessionId,
          seq: null,
          recordedAt: activeStart.recordedAt,
          reason: 'new_start_supersedes',
        });
      }
      activeStart = edge;
      synthesized.push(edge);
      continue;
    }

    if (activeStart) activeStart = null;
    synthesized.push(edge);
  }

  return synthesized;
}
