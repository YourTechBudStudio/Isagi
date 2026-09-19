import type { WorkflowExecutionDto, WorkflowFrameDto } from '@isagi/contracts';

import type { WorkflowRunState } from '../../../lib/workspace/workflow/model.js';
import { executionAncestry } from './ancestry.js';
import type { InspectorSelection } from './selection.js';
import { parseInstant } from './timing.js';

/**
 * Every execution of the run, on one clock.
 *
 * Trace is the historical half of the inspector and is deliberately independent of the current pin:
 * rows come from recorded facts only, so a node the newest definition dropped still renders, with
 * its real identity, under the pin that actually ran it. Nothing here consults the descriptor.
 *
 * Two shapes it refuses to draw. It never adds callback and wait time together as though they were a
 * single measured span, because they are separate intervals with separate meanings; and it never
 * stretches an interval whose end was not observed into a bar that reaches "now", because that would
 * turn an unknown into a measurement.
 */

/**
 * One interval, in absolute milliseconds rather than as a fraction of the clock.
 *
 * The clock's end moves every second on a live run, so a fraction computed here would go stale every
 * second and every row in the run would have to be rebuilt to refresh it — work proportional to all
 * of retained history, once a second, forever. Absolute instants do not go stale: the component
 * converts the handful of rows it actually mounts.
 *
 * `end` is null for an interval that is genuinely still running; the caller substitutes the clock.
 */
export interface TraceBar {
  readonly start: number;
  readonly end: number | null;
  readonly kind: 'callback' | 'wait' | 'span';
  readonly open: boolean;
}

/**
 * A frame's own lifecycle, which no execution row can carry.
 *
 * Entering a graph and evaluating its output are segments the *frame* owns: both run author code,
 * both can fail, and neither has a node visit to hang from. A root graph whose setup threw has no
 * executions at all, so without a row of its own the run would read as "nothing has run yet" while
 * the thing that actually failed sat one query away and unreachable.
 *
 * It is deliberately not an execution. Its markers carry the frame's real identity — `frame_segment`
 * and `frame_output` — because synthesizing a node-execution id for a segment that never had one
 * would put a fabricated identifier on screen beside real ones.
 */
export interface TraceFrameRow {
  readonly kind: 'frame';
  readonly frameId: number;
  readonly graphKey: string;
  readonly displayName: string | null;
  readonly depth: number;
  readonly selection: InspectorSelection;
  readonly startedAt: number;
  /** When the frame completed, or null while it is still open. An unknown end carries no duration. */
  readonly endedAt: number | null;
  readonly endUnknown: boolean;
  readonly status: 'initializing' | 'active' | 'completed' | 'failed';
  readonly bars: readonly TraceBar[];
  /** Entering the graph: the author's own setup code. */
  readonly entry: {
    readonly selection: InspectorSelection;
    readonly at: number;
    readonly failed: boolean;
  } | null;
  /** The output the frame published, or the evaluation that tried and failed to produce one. */
  readonly output: {
    readonly selection: InspectorSelection;
    readonly at: number;
    readonly label: string;
    readonly kind: 'success' | 'failure' | 'unresolved';
  } | null;
}

export interface TraceExecutionRow {
  readonly kind: 'execution';
  readonly executionId: number;
  readonly selection: InspectorSelection;
  readonly depth: number;
  readonly nodeId: string;
  readonly nodeKind: WorkflowExecutionDto['nodeKind'];
  readonly displayName: string | null;
  readonly labelDiagnostic: string | null;
  readonly visitIndex: number;
  /** True when this node ran more than once in its frame, so the ordinal is worth showing. */
  readonly repeated: boolean;
  readonly status: WorkflowExecutionDto['status'];
  /**
   * Captures in this visit and everything beneath it.
   *
   * Subtree-inclusive, so a subgraph row's number covers its whole child frame — which is why the
   * row spells it `n inside` rather than as a bare count. Never summed across rows.
   */
  readonly evidenceCaptured: number;
  readonly isSubgraph: boolean;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly bars: readonly TraceBar[];
  /**
   * When the visit ended, or null while it is still running. An unknown end is `endUnknown`, and
   * carries no duration at all.
   */
  readonly endedAt: number | null;
  readonly endUnknown: boolean;
  readonly startedAt: number;
  /** A routing segment of this visit, drawn as its own marker rather than folded into the bar. */
  readonly routing: {
    readonly selection: InspectorSelection;
    readonly at: number;
    readonly chosen: string | null;
    readonly failed: boolean;
  } | null;
  /** The frame output this visit's child frame published, when it has one. */
  readonly outcome: {
    readonly selection: InspectorSelection;
    readonly at: number;
    readonly outcomeId: string;
    readonly kind: 'success' | 'failure';
  } | null;
}

export type TraceRow = TraceExecutionRow | TraceFrameRow;

export interface TraceModel {
  readonly rows: readonly TraceRow[];
  /** Rows visible with the current expansion, in order. Navigation and virtualization use this. */
  readonly visible: readonly TraceRow[];
  readonly startedAt: number;
  /** When the run ended, or null while it is still going. The caller supplies the clock. */
  readonly endedAt: number | null;
  /** Pause bands in absolute milliseconds; a null close is a pause that is still open. */
  readonly pauses: readonly { readonly start: number; readonly end: number | null }[];
  readonly ended: boolean;
}

/**
 * The run's history, independent of the clock.
 *
 * Nothing here depends on the current time, so the model is rebuilt only when the projection or the
 * expansion changes — never on a tick. That is what keeps a live inspector's per-second cost
 * proportional to what is on screen rather than to how long the run has been going.
 */
export function buildTraceModel(input: {
  readonly state: WorkflowRunState;
  readonly collapsed: ReadonlySet<number>;
}): TraceModel {
  const { state, collapsed } = input;
  const executions = orderedExecutions(state);

  const runStart =
    parseInstant(state.summary?.createdAt ?? null) ??
    (executions.length > 0 ? parseInstant(executions[0]!.startedAt) : null) ??
    0;
  const runEnd = parseInstant(state.summary?.endedAt ?? null);
  const ended = runEnd !== null;

  const repeats = new Map<string, number>();
  for (const execution of executions) {
    const key = `${execution.frameId}:${execution.nodeId}`;
    repeats.set(key, (repeats.get(key) ?? 0) + 1);
  }

  const rows: TraceRow[] = [];
  for (const execution of executions) {
    const ancestry = executionAncestry(state, execution);
    const startedAt = parseInstant(execution.startedAt) ?? runStart;
    const endedAt = parseInstant(execution.endedAt);
    const endUnknown = endedAt === null && execution.endCertainty === 'unknown';
    // An unknown end is drawn as a point, never stretched to the clock: nobody observed it running
    // for any particular length of time.
    const closeAt = endedAt ?? (endUnknown ? startedAt : null);

    const bars: TraceBar[] = [];
    if (execution.nodeKind === 'subgraph') {
      bars.push({ kind: 'span', start: startedAt, end: closeAt, open: closeAt === null });
    } else {
      const callbackStart = parseInstant(execution.callbackStartedAt);
      const callbackEnd = parseInstant(execution.callbackEndedAt);
      if (callbackStart !== null) {
        const stop = callbackEnd ?? (endUnknown ? callbackStart : null);
        bars.push({ kind: 'callback', start: callbackStart, end: stop, open: stop === null });
      }
      const waitStart = parseInstant(execution.waitArmedAt);
      const waitEnd = parseInstant(execution.waitDeliveredAt);
      if (waitStart !== null) {
        // A wait the run still records as armed is genuinely open; otherwise the execution's own
        // certainty governs, exactly as it does for the callback.
        const stillArmed = execution.wait?.status === 'armed';
        const stop = waitEnd ?? (stillArmed ? null : endUnknown ? waitStart : null);
        bars.push({ kind: 'wait', start: waitStart, end: stop, open: stop === null });
      }
    }

    const routing = execution.routing;
    const routingAt = parseInstant(routing?.endedAt ?? routing?.startedAt ?? null);
    const childOutput = execution.childFrame?.output ?? null;
    const childCompleted = parseInstant(execution.childFrame?.completedAt ?? null);

    rows.push({
      kind: 'execution',
      executionId: execution.executionId,
      selection: { kind: 'execution', executionId: execution.executionId },
      depth: ancestry.path.length,
      nodeId: execution.nodeId,
      nodeKind: execution.nodeKind,
      displayName: execution.displayName,
      labelDiagnostic: execution.labelDiagnostic,
      visitIndex: execution.visitIndex,
      repeated: (repeats.get(`${execution.frameId}:${execution.nodeId}`) ?? 0) > 1,
      status: execution.status,
      evidenceCaptured: execution.operationSummary.evidenceCaptured,
      isSubgraph: execution.nodeKind === 'subgraph',
      expandable: execution.nodeKind === 'subgraph' && execution.childFrameId !== null,
      expanded: !collapsed.has(execution.executionId),
      bars,
      endedAt,
      endUnknown,
      startedAt,
      routing:
        routing === null || routingAt === null
          ? null
          : {
              selection: { kind: 'routing', executionId: execution.executionId },
              at: routingAt,
              chosen: routing.chosen,
              failed: routing.failure !== null,
            },
      outcome:
        childOutput === null || childCompleted === null || execution.childFrame === null
          ? null
          : {
              selection: { kind: 'frame_output', frameId: execution.childFrame.frameId },
              at: childCompleted,
              outcomeId: childOutput.outcomeId,
              kind: childOutput.outcomeKind,
            },
    });
  }

  // Frame lifecycles are interleaved by when the frame was entered, so one clock keeps one order.
  const ordered = [...rows, ...frameRows(state)].sort(
    (left, right) => left.startedAt - right.startedAt || rowRank(left) - rowRank(right),
  );

  return {
    rows: ordered,
    visible: visibleRows(ordered, state, collapsed),
    startedAt: runStart,
    endedAt: runEnd,
    pauses: state.pauseIntervals.map((interval) => ({
      start: parseInstant(interval.openedAt) ?? runStart,
      end: parseInstant(interval.closedAt),
    })),
    ended,
  };
}

/**
 * Rows reachable with the current expansion.
 *
 * A row is hidden when any enclosing subgraph visit is collapsed — expansion is by *visit*, not by
 * node, so collapsing one invocation of a reused graph never folds away another one's history.
 */
function visibleRows(
  rows: readonly TraceRow[],
  state: WorkflowRunState,
  collapsed: ReadonlySet<number>,
): readonly TraceRow[] {
  if (collapsed.size === 0) return rows;
  return rows.filter((row) => {
    const execution =
      row.kind === 'execution'
        ? state.executions.get(row.executionId)
        : openerOf(state, row.frameId);
    if (!execution) return true;
    const ancestry = executionAncestry(state, execution);
    // A frame's lifecycle folds away with the visit that opened it, which is itself collapsible.
    const enclosing =
      row.kind === 'frame'
        ? [...ancestry.ancestorExecutionIds, execution.executionId]
        : ancestry.ancestorExecutionIds;
    return !enclosing.some((id) => collapsed.has(id));
  });
}

/** The subgraph visit that opened a frame, or undefined for the root. */
function openerOf(state: WorkflowRunState, frameId: number): WorkflowExecutionDto | undefined {
  const parent = state.frames.get(frameId)?.parentExecutionId ?? null;
  return parent === null ? undefined : state.executions.get(parent);
}

/** A frame's lifecycle sorts before the executions inside it when both start on the same instant. */
function rowRank(row: TraceRow): number {
  return row.kind === 'frame' ? 0 : 1;
}

/**
 * Which frames get a lifecycle row.
 *
 * The root always, because nothing else represents the run's own graph: its setup, its result, and
 * the two ways it can be stuck with no visit to show for it. A child frame only when one of its own
 * segments actually recorded something — a child's output already has a marker on the subgraph row
 * that invoked it, and a second row saying the same thing would be noise, while a child whose setup
 * threw has no representation at all without one.
 */
function frameRows(state: WorkflowRunState): readonly TraceFrameRow[] {
  const rows: TraceFrameRow[] = [];
  for (const frame of state.frames.values()) {
    const isRoot = frame.parentExecutionId === null;
    const hasOwnSegment = frame.entry !== null || frame.outputEvaluation !== null;
    if (!isRoot && !hasOwnSegment) continue;

    const entered = parseInstant(frame.enteredAt) ?? 0;
    const completed = parseInstant(frame.completedAt);
    const entrySegment = frame.entry;
    const outputSegment = frame.outputEvaluation;
    const entryFailed = entrySegment?.latestAttempt.failure != null;
    const outputFailed = outputSegment?.latestAttempt.failure != null;
    const unknownEnd =
      completed === null &&
      (entrySegment?.endCertainty === 'unknown' || outputSegment?.endCertainty === 'unknown');

    const closeAt = completed ?? (unknownEnd ? entered : null);
    rows.push({
      kind: 'frame',
      frameId: frame.frameId,
      graphKey: frame.graphKey,
      displayName: frame.displayName,
      depth: frame.depth,
      // Selecting the row itself lands on the segment that opened the frame, which is the one fact
      // it always has — even when it was never attempted, which the dock distinguishes.
      selection: { kind: 'frame_segment', frameId: frame.frameId, segment: 'entry' },
      startedAt: entered,
      endedAt: completed,
      endUnknown: unknownEnd,
      status: entryFailed || outputFailed ? 'failed' : frame.status,
      bars: [{ kind: 'span', start: entered, end: closeAt, open: closeAt === null }],
      entry:
        entrySegment === null
          ? null
          : {
              selection: { kind: 'frame_segment', frameId: frame.frameId, segment: 'entry' },
              at: parseInstant(entrySegment.startedAt) ?? entered,
              failed: entryFailed,
            },
      output: frameOutputMarker(frame, entered),
    });
  }
  return rows;
}

function frameOutputMarker(frame: WorkflowFrameDto, entered: number): TraceFrameRow['output'] {
  if (frame.output !== null) {
    return {
      selection: { kind: 'frame_output', frameId: frame.frameId },
      at: parseInstant(frame.completedAt) ?? entered,
      label: frame.output.outcomeId,
      kind: frame.output.outcomeKind,
    };
  }
  const evaluation = frame.outputEvaluation;
  if (evaluation === null) return null;
  // An evaluation that ran and produced no outcome is its own state: the frame tried to finish and
  // could not, which is neither a success nor a failure outcome the author declared.
  return {
    selection: { kind: 'frame_segment', frameId: frame.frameId, segment: 'output' },
    at: parseInstant(evaluation.endedAt ?? evaluation.startedAt) ?? entered,
    label: evaluation.latestAttempt.failure === null ? 'output' : 'output threw',
    kind: evaluation.latestAttempt.failure === null ? 'unresolved' : 'failure',
  };
}

function orderedExecutions(state: WorkflowRunState): readonly WorkflowExecutionDto[] {
  const rows: WorkflowExecutionDto[] = [];
  for (const id of state.executionOrder) {
    const execution = state.executions.get(id);
    if (execution) rows.push(execution);
  }
  return rows;
}
