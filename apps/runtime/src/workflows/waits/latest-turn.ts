import type { AgentTurnEvent, AgentTurnTarget } from '../types.js';

/**
 * The latest-turn rule: which agent turn answers an agent-turn wait.
 *
 * ```text
 * turns in session S that started at or after sentAt → take the LATEST
 *   running → keep waiting;  ended → deliver "ended";  failed → deliver "failed"
 * ```
 *
 * One rule for waiting, Resume and Retry. A newer turn always wins, so a turn the person started by
 * hand after a failure is what a Retry picks up. `sentAt` is the runtime's clock, captured just
 * before the prompt reached the PTY, and turn starts carry the harness's clock; the comparison is
 * `>=`, and a clock skew between the two is a known limitation.
 *
 * Pure: it classifies the harness observer's turn edges and nothing else.
 */

export type TurnEdge =
  | {
      readonly type: 'turn_started';
      readonly agentSessionId: number;
      readonly harnessSessionId: string;
      readonly seq?: number | null | undefined;
      readonly recordedAt: string;
    }
  | {
      readonly type: 'turn_ended' | 'turn_failed';
      readonly agentSessionId: number;
      readonly harnessSessionId: string;
      readonly seq?: number | null | undefined;
      readonly recordedAt: string;
      readonly reason?: string | undefined;
    };

type StartEdge = Extract<TurnEdge, { readonly type: 'turn_started' }>;
type TerminalEdge = Exclude<TurnEdge, StartEdge>;

/** The turn a wait resolved to, with what the conversation reader needs to find its reply. */
export interface LatestTurn {
  readonly event: AgentTurnEvent;
  readonly turn: {
    readonly harnessSessionId: string;
    readonly seq: number;
    readonly startedAt: string;
    readonly completedAt: string;
  } | null;
}

export type LatestTurnResult =
  | { readonly kind: 'waiting'; readonly started: boolean }
  | ({ readonly kind: 'delivered' } & LatestTurn);

export function latestTurn(target: AgentTurnTarget, edges: readonly TurnEdge[]): LatestTurnResult {
  const starts = edges
    .filter(
      (edge): edge is StartEdge =>
        edge.type === 'turn_started' &&
        edge.agentSessionId === target.agentSessionId &&
        edge.recordedAt >= target.sentAt,
    )
    .sort(byRecordedAt);
  const latest = starts.at(-1);
  if (!latest) return { kind: 'waiting', started: false };

  const terminal = terminalFor(latest, edges);
  if (!terminal) return { kind: 'waiting', started: true };
  const turn =
    typeof latest.seq === 'number'
      ? {
          harnessSessionId: latest.harnessSessionId,
          seq: latest.seq,
          startedAt: latest.recordedAt,
          completedAt: terminal.recordedAt,
        }
      : null;
  return { kind: 'delivered', event: turnEvent(terminal), turn };
}

/** Whether any turn is open in the session: a send into a busy session is refused. */
export function hasInFlightTurn(edges: readonly TurnEdge[]): boolean {
  const open = new Map<string, number | null>();
  for (const edge of edges) {
    if (edge.type === 'turn_started') {
      open.set(edge.harnessSessionId, typeof edge.seq === 'number' ? edge.seq : null);
      continue;
    }
    const seq = open.get(edge.harnessSessionId);
    if (seq === undefined) continue;
    if (typeof edge.seq !== 'number' || edge.seq === seq) open.delete(edge.harnessSessionId);
  }
  return open.size > 0;
}

/**
 * The terminal edge that closes a start: the same stream and sequence, or, for a terminal with no
 * sequence (a session death), the first one recorded after the start.
 */
function terminalFor(start: StartEdge, edges: readonly TurnEdge[]): TerminalEdge | null {
  return (
    edges
      .filter(
        (edge): edge is TerminalEdge =>
          edge.type !== 'turn_started' &&
          edge.agentSessionId === start.agentSessionId &&
          edge.harnessSessionId === start.harnessSessionId &&
          (typeof edge.seq === 'number' && typeof start.seq === 'number'
            ? edge.seq === start.seq
            : edge.recordedAt >= start.recordedAt),
      )
      .sort(byRecordedAt)[0] ?? null
  );
}

export function turnEvent(terminal: {
  readonly type: 'turn_ended' | 'turn_failed';
  readonly recordedAt: string;
  readonly reason?: string | undefined;
}): AgentTurnEvent {
  if (terminal.type === 'turn_ended') {
    return { kind: 'agent_turn', outcome: 'ended', recordedAt: terminal.recordedAt };
  }
  if (terminal.reason === 'session_died') {
    return {
      kind: 'agent_turn',
      outcome: 'interrupted',
      recordedAt: terminal.recordedAt,
      reason: 'session_died',
    };
  }
  return {
    kind: 'agent_turn',
    outcome: 'failed',
    recordedAt: terminal.recordedAt,
    reason: terminal.reason ?? 'harness_error',
  };
}

function byRecordedAt(
  left: { readonly recordedAt: string },
  right: { readonly recordedAt: string },
) {
  return left.recordedAt.localeCompare(right.recordedAt);
}
