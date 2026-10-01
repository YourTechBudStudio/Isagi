import type { WorkflowExecutionSummaryDto } from '@isagi/contracts';

import { waitTimings } from '../../../lib/workspace/workflow/history.js';
import type { WorkflowRunView } from '../../../lib/workspace/workflow/run-view.js';
import { executionAddressKey, routingEdgeKey } from './ancestry.js';
import { executionTiming, intervalDuration, isOpen } from './timing.js';
import type { DeclaredTopology } from './topology.js';

/**
 * What the current build's drawing knows about each declared element, from the executions that
 * actually ran.
 *
 * **An execution belongs to an address, not to a graph.** The address comes from invocation
 * ancestry, so a graph invoked twice keeps two separate sets of executions.
 *
 * **An edge is taken because an execution routed through it.** Its `routedTo` is the recorded
 * decision's destination, never an inference from both endpoints having run.
 */

export type ElementStatus = 'unvisited' | WorkflowExecutionSummaryDto['status'];

export interface ElementAggregate {
  readonly key: string;
  /** Every execution at this address, in start order. A Retry is simply another one. */
  readonly visits: readonly WorkflowExecutionSummaryDto[];
  readonly status: ElementStatus;
  /** Total time across executions, and whether any is still going. */
  readonly durationMs: number;
  readonly open: boolean;
  /** Destinations a routing decision actually chose, for an edge element. */
  readonly chosenDestinations: readonly string[];
  /** For an edge element: the executions whose routing went through it, in start order. */
  readonly routedBy: readonly WorkflowExecutionSummaryDto[];
}

export interface VisitAggregation {
  readonly byElement: ReadonlyMap<string, ElementAggregate>;
  /** Link ids a recorded routing decision reached. */
  readonly takenLinks: ReadonlySet<string>;
  /** The clock the open totals were computed against. */
  readonly now: number;
}

const emptyAggregate = (key: string): ElementAggregate => ({
  key,
  visits: [],
  status: 'unvisited',
  durationMs: 0,
  open: false,
  chosenDestinations: [],
  routedBy: [],
});

export function emptyAggregation(now: number): VisitAggregation {
  return { byElement: new Map(), takenLinks: new Set(), now };
}

export function elementAggregate(
  aggregation: VisitAggregation | null,
  key: string,
): ElementAggregate {
  return aggregation?.byElement.get(key) ?? emptyAggregate(key);
}

/**
 * Recomputed whole on every change. A run's history is small enough that a full pass per event (or
 * per clock tick while something is open) costs nothing worth caching around.
 */
export function aggregateVisits(input: {
  readonly view: WorkflowRunView;
  readonly topology: DeclaredTopology | null;
  readonly now: number;
}): VisitAggregation {
  const { view, topology, now } = input;
  const waits = waitTimings(view.events);

  const members = new Map<string, WorkflowExecutionSummaryDto[]>();
  const routings = new Map<string, WorkflowExecutionSummaryDto[]>();
  const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  for (const id of view.executionOrder) {
    const execution = view.executions.get(id);
    if (!execution) continue;
    push(members, executionAddressKey(view, execution), execution);
    const edgeKey = routingEdgeKey(view, topology, execution);
    if (edgeKey !== null) push(routings, edgeKey, execution);
  }

  const keys = new Set<string>([...members.keys(), ...routings.keys()]);
  if (topology) for (const key of topology.elements.keys()) keys.add(key);

  const byElement = new Map<string, ElementAggregate>();
  for (const key of keys) {
    const visits = members.get(key) ?? [];
    const routed = routings.get(key) ?? [];
    const chosen: string[] = [];
    for (const execution of routed) {
      if (execution.routedTo !== null && !chosen.includes(execution.routedTo)) {
        chosen.push(execution.routedTo);
      }
    }
    if (visits.length === 0) {
      byElement.set(key, {
        ...emptyAggregate(key),
        status: routed.length > 0 ? 'completed' : 'unvisited',
        chosenDestinations: chosen,
        routedBy: routed,
      });
      continue;
    }
    let durationMs = 0;
    let open = false;
    for (const visit of visits) {
      const timing = executionTiming(visit, waits.get(visit.executionId));
      durationMs += intervalDuration(timing.total, now) ?? 0;
      if (isOpen(timing.total)) open = true;
    }
    byElement.set(key, {
      key,
      visits,
      status: rollUpStatus(visits),
      durationMs,
      open,
      chosenDestinations: chosen,
      routedBy: routed,
    });
  }

  const takenLinks = new Set<string>();
  if (topology) {
    for (const link of topology.links) {
      if (byElement.get(link.edgeKey)?.chosenDestinations.includes(link.destinationId)) {
        takenLinks.add(link.id);
      }
    }
  }

  return { byElement, takenLinks, now };
}

/**
 * One status for a node with several executions.
 *
 * Anything still live outranks how the last finished one ended, because a node with an execution
 * in flight is a node the run is inside. Below that, the latest execution speaks: a node that
 * failed and was retried successfully reads as completed, which is what actually happened.
 */
function rollUpStatus(visits: readonly WorkflowExecutionSummaryDto[]): ElementStatus {
  for (const live of ['waiting', 'running'] as const) {
    if (visits.some((visit) => visit.status === live)) return live;
  }
  return visits.at(-1)?.status ?? 'unvisited';
}
