import type { AttentionState } from '@isagi/contracts';

import { type CodexRolloutLifecycleRecord } from './codex/lifecycle.js';
import { harnessDefinition } from './definitions.js';
import { derivePiRunningAttention } from './pi/attention.js';
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

export interface ActiveHarnessTurn {
  readonly seq: number;
  readonly recordedAt: string;
  readonly ptyProcessId: number | null;
}

export interface HarnessLifecycleDiagnostic {
  readonly code:
    | 'malformed_optional_field'
    | 'missing_native_turn_id'
    | 'unknown_native_turn'
    | 'unknown_status_shape'
    | 'unsupported_native_shape'
    | 'missing_native_artifact'
    | 'native_session_error'
    | 'native_turn_aborted'
    | 'missing_native_event_id'
    | 'unmatched_user_input_completion';
  readonly recordedAt: string;
  readonly detail?: string;
}

export interface HarnessLifecycleResult {
  readonly activeTurn: ActiveHarnessTurn | null;
  readonly terminalEdges: readonly Extract<
    HarnessTurnEdge,
    { readonly type: 'turn_ended' | 'turn_failed' }
  >[];
  readonly attention: AttentionState;
  readonly diagnostics: readonly HarnessLifecycleDiagnostic[];
}

export function emptyHarnessLifecycle(): HarnessLifecycleResult {
  return { activeTurn: null, terminalEdges: [], attention: 'idle', diagnostics: [] };
}

export function reduceHarnessLifecycle(input: {
  readonly harness: HarnessObservationRecord['harness'];
  readonly records: readonly HarnessObservationRecord[];
  readonly codexRecords?: readonly CodexRolloutLifecycleRecord[] | undefined;
}): HarnessLifecycleResult {
  return harnessDefinition(input.harness).lifecycle.reduce(input);
}

/**
 * Reducers retain terminal history and the current active turn. This projects
 * that state into the paired edge stream consumed by workflows. A terminal
 * edge always carries the opening sequence, so its start can be reconstructed
 * without timestamp matching.
 */
export function lifecycleTurnEdges(input: {
  readonly lifecycle: HarnessLifecycleResult;
  readonly openingRecordedAt: (seq: number) => string | null;
}): readonly HarnessTurnEdge[] {
  type Terminal = HarnessLifecycleResult['terminalEdges'][number];
  const turns: Array<{
    readonly seq: number;
    readonly startRecordedAt: string | null;
    readonly terminal: Terminal | null;
  }> = [];
  for (const terminal of input.lifecycle.terminalEdges) {
    if (typeof terminal.seq !== 'number') continue;
    turns.push({
      seq: terminal.seq,
      startRecordedAt: input.openingRecordedAt(terminal.seq),
      terminal,
    });
  }
  if (input.lifecycle.activeTurn) {
    turns.push({
      seq: input.lifecycle.activeTurn.seq,
      startRecordedAt: input.lifecycle.activeTurn.recordedAt,
      terminal: null,
    });
  }
  turns.sort((left, right) => left.seq - right.seq);
  return turns.flatMap((turn) => {
    if (!turn.startRecordedAt) return turn.terminal ? [turn.terminal] : [];
    const start: HarnessTurnEdge = {
      type: 'turn_started',
      harnessSessionId: '',
      seq: turn.seq,
      recordedAt: turn.startRecordedAt,
    };
    return turn.terminal ? [start, turn.terminal] : [start];
  });
}

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
    ptyProcessId: record?.ptyProcessId ?? null,
  };
}
