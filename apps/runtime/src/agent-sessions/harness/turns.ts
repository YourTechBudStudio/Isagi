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
      readonly reason: 'session_died' | 'harness_error';
    };

export function deriveHarnessTurnEdges(
  harness: AgentHarness,
  records: readonly HarnessObservationRecord[],
): readonly HarnessTurnEdge[] {
  if (harness === 'pi') return derivePiTurnEdges(records);
  if (harness === 'opencode') return deriveOpenCodeTurnEdges(records);
  if (harness === 'claude') return deriveClaudeTurnEdges(records);
  if (harness === 'codex') return deriveCodexTurnEdges(records);
  return [];
}
