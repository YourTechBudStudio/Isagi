/**
 * Turn-edge evaluation: the pure half of deciding whether an agent turn we asked for has finished.
 *
 * No service dependencies and no persistence — these functions take the harness observer's raw turn
 * edges and a durable submission boundary, and classify. The durable half (persisting the fixed
 * association, settling the operation) belongs to the operation service; the delivery half belongs
 * to the wait resolver.
 */

export type TerminalTurnEdge = {
  readonly type: 'turn_ended' | 'turn_failed';
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly seq?: number | null | undefined;
  readonly recordedAt: string;
  readonly reason?: string | undefined;
};

export type TurnStartedEdge = {
  readonly type: 'turn_started';
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly seq?: number | null | undefined;
  readonly recordedAt: string;
};

export type WorkflowObservedTurnEdge = TurnStartedEdge | TerminalTurnEdge;

/** The submission boundary a search is bounded by. Both fields are durable before the PTY write. */
export interface TurnSubmissionBoundary {
  readonly agentSessionId: number;
  /** The operation's `submission_watermark`, persisted *before* the write it describes. */
  readonly sentAt: string;
}

/**
 * The association between our submission and a native turn.
 *
 * `fixed` is written once and never revisited: after it, a later `turn_started` is not ambiguity but
 * ordinary session activity, and the terminal paired to the fixed start is delivered whatever it
 * says — including a `turn_failed` carrying `new_start_supersedes`, which is a confirmed
 * interruption rather than a reason to stop believing the association.
 */
export type TurnAssociation =
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'fixed';
      readonly attribution: 'inferred_by_watermark';
      readonly startSeq: number | null;
      readonly harnessSessionId: string;
      readonly startedAt: string;
    }
  | { readonly kind: 'ambiguous'; readonly startCount: number };

export function isTerminalTurnEdge(edge: { readonly type: string }): edge is TerminalTurnEdge {
  return edge.type === 'turn_ended' || edge.type === 'turn_failed';
}

export function hasInFlightTurn(edges: readonly WorkflowObservedTurnEdge[]) {
  const activeByHarnessSessionId = new Map<string, number | null>();
  for (const edge of edges) {
    if (edge.type === 'turn_started') {
      activeByHarnessSessionId.set(
        edge.harnessSessionId,
        typeof edge.seq === 'number' ? edge.seq : null,
      );
      continue;
    }
    const activeSeq = activeByHarnessSessionId.get(edge.harnessSessionId);
    if (activeSeq === undefined) continue;
    if (typeof edge.seq !== 'number' || edge.seq === activeSeq) {
      activeByHarnessSessionId.delete(edge.harnessSessionId);
    }
  }
  return activeByHarnessSessionId.size > 0;
}

/**
 * Classify our submission against the session's turn edges — run exactly once per operation, at the
 * first evaluation that finds any start at or after the watermark.
 *
 * Two or more starts are ambiguity **only while the first is still open**. Once a terminal edge
 * pairs to the first start, that start is the turn our prompt caused and it has already closed; a
 * later start is then unrelated activity, not a competing candidate. Counting every subsequent start
 * instead would discard the confirmed `new_start_supersedes` terminal the harness actually produces
 * and block a run whose turn the runtime can explain.
 */
export function selectTurnAssociation(
  boundary: TurnSubmissionBoundary,
  edges: readonly WorkflowObservedTurnEdge[],
): TurnAssociation {
  const starts = startsAfterWatermark(boundary, edges);
  const first = starts[0];
  if (!first) return { kind: 'pending' };
  if (starts.length > 1 && terminalPairedToStart(first, boundary, edges) === null) {
    return { kind: 'ambiguous', startCount: starts.length };
  }
  return {
    kind: 'fixed',
    attribution: 'inferred_by_watermark',
    startSeq: typeof first.seq === 'number' ? first.seq : null,
    harnessSessionId: first.harnessSessionId,
    startedAt: first.recordedAt,
  };
}

/**
 * The terminal edge closing an association that was already fixed and persisted.
 *
 * Reads only the persisted correlation, never a fresh selection, so later starts cannot rewrite what
 * an earlier incarnation decided.
 *
 * Pairing is decided by the **terminal's** sequence, not the start's. A native provider terminal
 * always carries the opening seq it closes, and must match it exactly — a numeric terminal never
 * falls back to a different opening sequence. Only a terminal with no sequence at all is an
 * uncorrelated failure (a session death, say), and those are paired chronologically against the
 * durable lower bound, which is the watermark this submission was recorded with.
 */
export function terminalForFixedAssociation(
  input: {
    readonly agentSessionId: number;
    /** The durable lower bound: the operation's `submission_watermark`, or a known start time. */
    readonly sentAt: string;
    readonly harnessSessionId: string;
    readonly startSeq: number | null;
  },
  edges: readonly WorkflowObservedTurnEdge[],
): TerminalTurnEdge | null {
  return (
    edges
      .filter(
        (edge): edge is TerminalTurnEdge =>
          isTerminalTurnEdge(edge) &&
          edge.agentSessionId === input.agentSessionId &&
          edge.harnessSessionId === input.harnessSessionId &&
          (typeof edge.seq === 'number'
            ? edge.seq === input.startSeq
            : edge.recordedAt >= input.sentAt),
      )
      .sort(byRecordedAt)[0] ?? null
  );
}

/**
 * Selection and pairing in one step, for a caller holding no persisted association yet.
 *
 * Returns the terminal edge only when the association is unambiguous *and* closed. Ambiguity and an
 * open turn both read as `null` here; callers that must distinguish them use `selectTurnAssociation`
 * directly, because one of those answers blocks a run and the other simply keeps waiting.
 */
export function findSatisfiedTerminalTurnEdge(
  boundary: TurnSubmissionBoundary,
  edges: readonly WorkflowObservedTurnEdge[],
): TerminalTurnEdge | null {
  const association = selectTurnAssociation(boundary, edges);
  if (association.kind !== 'fixed') return null;
  return terminalForFixedAssociation(
    {
      agentSessionId: boundary.agentSessionId,
      sentAt: boundary.sentAt,
      harnessSessionId: association.harnessSessionId,
      startSeq: association.startSeq,
    },
    edges,
  );
}

function startsAfterWatermark(
  boundary: TurnSubmissionBoundary,
  edges: readonly WorkflowObservedTurnEdge[],
): readonly TurnStartedEdge[] {
  return edges
    .filter(
      (edge): edge is TurnStartedEdge =>
        edge.type === 'turn_started' &&
        edge.agentSessionId === boundary.agentSessionId &&
        edge.recordedAt >= boundary.sentAt,
    )
    .sort(byRecordedAt);
}

function terminalPairedToStart(
  start: TurnStartedEdge,
  boundary: TurnSubmissionBoundary,
  edges: readonly WorkflowObservedTurnEdge[],
): TerminalTurnEdge | null {
  return terminalForFixedAssociation(
    {
      agentSessionId: boundary.agentSessionId,
      sentAt: start.recordedAt,
      harnessSessionId: start.harnessSessionId,
      startSeq: typeof start.seq === 'number' ? start.seq : null,
    },
    edges,
  );
}

function byRecordedAt(
  left: { readonly recordedAt: string },
  right: { readonly recordedAt: string },
) {
  return left.recordedAt.localeCompare(right.recordedAt);
}
