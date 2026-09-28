import type {
  WorkflowEventDto,
  WorkflowExecutionSummaryDto,
  WorkflowGraphInvocationDto,
} from '@isagi/contracts';

import {
  codeReloads,
  pauseBands,
  runEvents,
  waitTimings,
} from '../../../lib/workspace/workflow/history.js';
import {
  invocationOpener,
  orderedExecutions,
  type WorkflowRunView,
} from '../../../lib/workspace/workflow/run-view.js';
import { executionAncestry } from './ancestry.js';
import type { InspectorSelection } from './selection.js';
import { executionTiming, parseInstant } from './timing.js';

/**
 * Every execution of the run, on one clock.
 *
 * Trace is the historical half of the inspector and is deliberately independent of the current
 * build: rows come from recorded executions only, so a node the newest build dropped still renders
 * under the build that actually ran it. Pauses, code reloads and when each node waited come from
 * the run's event log, because no row records them.
 */

/**
 * One interval, in absolute milliseconds rather than as a fraction of the clock, so a live run's
 * moving clock does not invalidate every row. `end` is null while the interval is still open.
 */
export interface TraceBar {
  readonly start: number;
  readonly end: number | null;
  /** `run`: the node function; `wait`: parked on its wait; `span`: a subgraph or a graph. */
  readonly kind: 'run' | 'wait' | 'span';
  readonly open: boolean;
}

/** The root graph invocation's own row: the whole run's span and the outcome it finished with. */
export interface TraceInvocationRow {
  readonly kind: 'invocation';
  readonly invocationId: number;
  readonly graphKey: string;
  readonly label: string | null;
  readonly depth: number;
  readonly selection: InspectorSelection;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly status: WorkflowGraphInvocationDto['status'];
  readonly bars: readonly TraceBar[];
  readonly outcome: {
    readonly at: number;
    readonly label: string;
    readonly kind: 'success' | 'failure';
  } | null;
}

export interface TraceExecutionRow {
  readonly kind: 'execution';
  readonly executionId: number;
  readonly selection: InspectorSelection;
  readonly depth: number;
  readonly nodeId: string;
  readonly nodeKind: WorkflowExecutionSummaryDto['nodeKind'];
  readonly label: string | null;
  readonly visitIndex: number;
  /** True when this node ran more than once in its invocation, so the ordinal is worth showing. */
  readonly repeated: boolean;
  readonly status: WorkflowExecutionSummaryDto['status'];
  /** The failed or interrupted execution this one retries. */
  readonly retryOf: number | null;
  readonly isSubgraph: boolean;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly bars: readonly TraceBar[];
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Where the edge routed, drawn as its own marker when the execution ended. */
  readonly routing: { readonly at: number; readonly chosen: string } | null;
  /** The outcome the subgraph's child invocation finished with. */
  readonly outcome: {
    readonly selection: InspectorSelection;
    readonly at: number;
    readonly outcomeId: string;
    readonly kind: 'success' | 'failure';
  } | null;
}

export type TraceRow = TraceExecutionRow | TraceInvocationRow;

export interface TraceRunEvent {
  readonly eventId: number;
  readonly at: number;
  readonly kind: WorkflowEventDto['kind'];
  readonly category: WorkflowEventDto['category'];
  readonly message: string;
  readonly tone: 'ok' | 'bad' | 'default';
}

export interface TraceModel {
  readonly rows: readonly TraceRow[];
  /** Rows visible with the current expansion, in order. Navigation and virtualization use this. */
  readonly visible: readonly TraceRow[];
  readonly startedAt: number;
  /** When the run ended, or null while it is still going. The caller supplies the clock. */
  readonly endedAt: number | null;
  /** Pause bands in absolute milliseconds; a null end is a pause that is still open. */
  readonly pauses: readonly { readonly start: number; readonly end: number | null }[];
  /** Each Resume or Retry that moved the run onto a newer build. */
  readonly reloads: readonly { readonly at: number; readonly to: string | null }[];
  /**
   * The run's own and its environment's events — launched, worktree created, setup, surface
   * created, failed, retried, completed — drawn in their own lane. Pauses and reloads are not
   * repeated here; they already have their bands and markers.
   */
  readonly runEvents: readonly TraceRunEvent[];
  readonly ended: boolean;
}

/**
 * The run's history, independent of the clock, so it is rebuilt only when the run or the expansion
 * changes — never on a tick.
 */
export function buildTraceModel(input: {
  readonly view: WorkflowRunView;
  readonly collapsed: ReadonlySet<number>;
}): TraceModel {
  const { view, collapsed } = input;
  const executions = orderedExecutions(view);
  const waits = waitTimings(view.events);

  const runStart =
    parseInstant(view.run.createdAt) ??
    (executions.length > 0 ? parseInstant(executions[0]!.startedAt) : null) ??
    0;
  const runEnd = parseInstant(view.run.endedAt);

  const repeats = new Map<string, number>();
  for (const execution of executions) {
    const key = `${execution.invocationId}:${execution.nodeId}`;
    repeats.set(key, (repeats.get(key) ?? 0) + 1);
  }

  const rows: TraceRow[] = [];
  for (const execution of executions) {
    const startedAt = parseInstant(execution.startedAt) ?? runStart;
    const endedAt = parseInstant(execution.endedAt);

    const bars: TraceBar[] = [];
    if (execution.nodeKind === 'subgraph') {
      bars.push({ kind: 'span', start: startedAt, end: endedAt, open: endedAt === null });
    } else {
      const timing = executionTiming(execution, waits.get(execution.executionId));
      for (const [kind, interval] of [
        ['run', timing.run],
        ['wait', timing.wait],
      ] as const) {
        if (interval === null) continue;
        bars.push({ kind, start: interval.start, end: interval.end, open: interval.end === null });
      }
    }

    const child =
      execution.childInvocationId === null
        ? undefined
        : view.invocations.get(execution.childInvocationId);
    const childEnded = parseInstant(child?.endedAt ?? null);

    rows.push({
      kind: 'execution',
      executionId: execution.executionId,
      selection: { kind: 'execution', executionId: execution.executionId },
      depth: executionAncestry(view, execution).path.length,
      nodeId: execution.nodeId,
      nodeKind: execution.nodeKind,
      label: execution.label,
      visitIndex: execution.visitIndex,
      repeated: (repeats.get(`${execution.invocationId}:${execution.nodeId}`) ?? 0) > 1,
      status: execution.status,
      retryOf: execution.retryOf,
      isSubgraph: execution.nodeKind === 'subgraph',
      expandable: execution.nodeKind === 'subgraph' && execution.childInvocationId !== null,
      expanded: !collapsed.has(execution.executionId),
      bars,
      startedAt,
      endedAt,
      routing:
        execution.routedTo === null
          ? null
          : { at: endedAt ?? startedAt, chosen: execution.routedTo },
      outcome:
        child?.outcome == null || childEnded === null
          ? null
          : {
              selection: { kind: 'invocation', invocationId: child.invocationId },
              at: childEnded,
              outcomeId: child.outcome.outcomeId,
              kind: child.outcome.kind,
            },
    });
  }

  const root =
    view.rootInvocationId === null ? undefined : view.invocations.get(view.rootInvocationId);
  if (root) rows.push(invocationRow(root));

  // The root's row sorts before the executions inside it when both start on the same instant.
  const ordered = rows.sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      (left.kind === 'invocation' ? 0 : 1) - (right.kind === 'invocation' ? 0 : 1),
  );

  return {
    rows: ordered,
    visible: visibleRows(ordered, view, collapsed),
    startedAt: runStart,
    endedAt: runEnd,
    pauses: pauseBands(view.events).map((band) => ({
      start: parseInstant(band.start) ?? runStart,
      end: parseInstant(band.end),
    })),
    reloads: codeReloads(view.events).map((reload) => ({
      at: parseInstant(reload.at) ?? runStart,
      to: reload.to,
    })),
    runEvents: runEvents(view.events)
      .filter((event) => !drawnElsewhere.has(event.kind))
      .map((event) => ({
        eventId: event.eventId,
        at: parseInstant(event.at) ?? runStart,
        kind: event.kind,
        category: event.category,
        message: event.message,
        tone: failedKinds.has(event.kind) ? 'bad' : doneKinds.has(event.kind) ? 'ok' : 'default',
      })),
    ended: runEnd !== null,
  };
}

/** Run events that already have their own mark: pause bands and reload markers. */
const drawnElsewhere = new Set<WorkflowEventDto['kind']>([
  'run_paused',
  'run_resumed',
  'code_reloaded',
]);
const failedKinds = new Set<WorkflowEventDto['kind']>([
  'run_failed',
  'setup_failed',
  'preparation_failed',
  'stop_failed',
]);
const doneKinds = new Set<WorkflowEventDto['kind']>(['run_completed']);

function invocationRow(invocation: WorkflowGraphInvocationDto): TraceInvocationRow {
  const startedAt = parseInstant(invocation.startedAt) ?? 0;
  const endedAt = parseInstant(invocation.endedAt);
  return {
    kind: 'invocation',
    invocationId: invocation.invocationId,
    graphKey: invocation.graphKey,
    label: invocation.label,
    depth: invocation.depth,
    selection: { kind: 'invocation', invocationId: invocation.invocationId },
    startedAt,
    endedAt,
    status: invocation.status,
    bars: [{ kind: 'span', start: startedAt, end: endedAt, open: endedAt === null }],
    outcome:
      invocation.outcome === null
        ? null
        : {
            at: endedAt ?? startedAt,
            label: invocation.outcome.outcomeId,
            kind: invocation.outcome.kind,
          },
  };
}

/**
 * Rows reachable with the current expansion.
 *
 * A row is hidden when any enclosing subgraph execution is collapsed — expansion is by execution,
 * not by node, so collapsing one invocation of a reused graph never folds away another's history.
 */
function visibleRows(
  rows: readonly TraceRow[],
  view: WorkflowRunView,
  collapsed: ReadonlySet<number>,
): readonly TraceRow[] {
  if (collapsed.size === 0) return rows;
  return rows.filter((row) => {
    if (row.kind === 'invocation') {
      const opener = invocationOpener(view, row.invocationId);
      if (!opener) return true;
      const ancestry = executionAncestry(view, opener);
      return ![...ancestry.ancestorExecutionIds, opener.executionId].some((id) =>
        collapsed.has(id),
      );
    }
    const execution = view.executions.get(row.executionId);
    if (!execution) return true;
    return !executionAncestry(view, execution).ancestorExecutionIds.some((id) => collapsed.has(id));
  });
}
