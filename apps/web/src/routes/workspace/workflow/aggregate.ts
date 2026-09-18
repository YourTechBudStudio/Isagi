import type { WorkflowCapability, WorkflowExecutionDto } from '@isagi/contracts';

import type { WorkflowRunState } from '../../../lib/workspace/workflow/model.js';
import { executionAddressKey, routingAddress } from './ancestry.js';
import { executionTiming, intervalDuration, isOpen } from './timing.js';
import { addressKey, type DeclaredTopology } from './topology.js';

/**
 * What the current pin's drawing knows about each declared element, aggregated from actual visits.
 *
 * Two rules do the real work here.
 *
 * **A visit belongs to an address, not to a graph.** The address comes from frame ancestry, so a
 * graph invoked twice keeps two separate sets of visits and a node is never drawn with another
 * registration's history.
 *
 * **An edge is taken because a routing decision said so.** Never because both of its endpoints
 * happen to have been visited: a node reached by two different edges would otherwise light up both,
 * and a graph would read as having gone somewhere it never went.
 */

export type ElementStatus =
  | 'unvisited'
  | 'running'
  | 'awaiting'
  | 'routing'
  | 'mapping'
  | 'completed'
  | 'failed';

export interface ElementAggregate {
  readonly key: string;
  /** Every visit to this address, in start order. */
  readonly visits: readonly WorkflowExecutionDto[];
  readonly status: ElementStatus;
  /** Total callback time across visits, and whether any is still running. */
  readonly callbackMs: number;
  readonly callbackOpen: boolean;
  /** Total wait time across visits, and whether any visit is still armed. */
  readonly waitMs: number;
  readonly waitOpen: boolean;
  /** True when at least one interval's end was never observed, so a total is a lower bound. */
  readonly hasUnknownEnd: boolean;
  /** Capabilities these visits actually called. Recorded facts, never read off the descriptor. */
  readonly capabilities: readonly WorkflowCapability[];
  /** Operations recorded across every visit, and how many are still unsettled. */
  readonly operationCount: number;
  readonly unresolvedOperations: number;
  /**
   * Captures across every visit of this element, each counted once.
   *
   * Safe to sum here, and only here: visits of one element are disjoint executions whose subtrees do
   * not overlap. Summing the same field *across* elements is forbidden — an element nested inside a
   * subgraph would be counted again for the subgraph node that contains it.
   */
  readonly evidenceCaptured: number;
  /** For a subgraph registration: how many executions happened inside its child frames. */
  readonly nestedExecutionCount: number;
  /** Destinations a routing decision actually chose, for an edge element. */
  readonly chosenDestinations: readonly string[];
}

/** Which address each execution belongs to, cached so a clock tick need not re-derive it. */
interface Membership {
  readonly members: ReadonlyMap<string, readonly WorkflowExecutionDto[]>;
  readonly routings: ReadonlyMap<string, readonly WorkflowExecutionDto[]>;
  readonly nested: ReadonlyMap<string, number>;
}

export interface VisitAggregation {
  /** The execution map this aggregation was computed from, for reference diffing. */
  readonly executions: ReadonlyMap<number, WorkflowExecutionDto>;
  /**
   * The pin's topology this aggregation was computed against.
   *
   * `takenLinks` is derived from it — link identities come from the descriptor, not from history —
   * so an aggregation is only reusable while the topology is the same object. It is part of the
   * cache key for exactly the reason the execution map is.
   */
  readonly topology: DeclaredTopology | null;
  /**
   * Addressing, kept across passes.
   *
   * Frame ancestry is derived per execution, and re-deriving it for a whole run's history once a
   * second buys nothing: a clock tick changes no execution's address. It is rebuilt only when the
   * projection itself changes.
   */
  readonly membership: Membership;
  readonly byElement: ReadonlyMap<string, ElementAggregate>;
  /** Link ids a committed routing decision reached. */
  readonly takenLinks: ReadonlySet<string>;
  /** Which element keys this pass actually recomputed. Asserted by tests, not merely intended. */
  readonly recomputed: readonly string[];
  /** The clock the open totals were computed against. */
  readonly now: number;
}

const emptyAggregate = (key: string): ElementAggregate => ({
  key,
  visits: [],
  status: 'unvisited',
  callbackMs: 0,
  callbackOpen: false,
  waitMs: 0,
  waitOpen: false,
  hasUnknownEnd: false,
  capabilities: [],
  operationCount: 0,
  unresolvedOperations: 0,
  evidenceCaptured: 0,
  nestedExecutionCount: 0,
  chosenDestinations: [],
});

/** An aggregation of nothing, for a run whose projection has not arrived. */
export function emptyAggregation(now: number): VisitAggregation {
  return {
    executions: new Map(),
    topology: null,
    membership: { members: new Map(), routings: new Map(), nested: new Map() },
    byElement: new Map(),
    takenLinks: new Set(),
    recomputed: [],
    now,
  };
}

export function elementAggregate(
  aggregation: VisitAggregation | null,
  key: string,
): ElementAggregate {
  return aggregation?.byElement.get(key) ?? emptyAggregate(key);
}

/**
 * Recomputes only the addresses a change actually touched.
 *
 * A live run commits a transition every few hundred milliseconds and each one replaces exactly the
 * rows it changed, leaving every other row's object identity intact. So the changed set is a
 * reference diff, and the work is proportional to what moved rather than to how long the run has
 * been going. `recomputed` reports it so the claim is testable instead of asserted in a comment.
 *
 * `now` is a separate input on purpose: a clock tick re-derives open totals without touching the
 * membership work at all, and is not a reason to recompute anything else.
 */
export function aggregateVisits(input: {
  readonly state: WorkflowRunState;
  readonly topology: DeclaredTopology | null;
  readonly now: number;
  readonly previous?: VisitAggregation | null | undefined;
}): VisitAggregation {
  const { state, topology, now } = input;
  const previous = input.previous ?? null;

  // A tick changes no execution's address, so membership is reused whole when neither the projection
  // nor the pin has moved. Without this, every second costs a full walk of the run's retained
  // history.
  //
  // The topology belongs in this condition, not just the executions. A `retry_pin_adopted` delta can
  // carry no execution rows at all, and an empty upsert deliberately preserves the map's identity —
  // so a pin change reaches here looking exactly like a clock tick, and reusing the previous pass
  // would draw the new pin's graph with the previous pin's taken edges.
  const unchanged =
    previous !== null && previous.executions === state.executions && previous.topology === topology;
  if (unchanged) return reclock(previous, now);

  const changedKeys = new Set<string>();
  const membersOf = new Map<string, WorkflowExecutionDto[]>();
  const routingByEdge = new Map<string, WorkflowExecutionDto[]>();
  const nestedCounts = new Map<string, number>();

  // One pass over the projection builds membership; it is cheap reference work, and it is what lets
  // the expensive per-element derivation below run only for the addresses that moved.
  for (const execution of state.executions.values()) {
    const key = executionAddressKey(state, execution);
    let bucket = membersOf.get(key);
    if (!bucket) membersOf.set(key, (bucket = []));
    bucket.push(execution);

    const routing = routingAddress(state, execution);
    if (routing !== null) {
      const edgeKey = addressKey(routing);
      let edges = routingByEdge.get(edgeKey);
      if (!edges) routingByEdge.set(edgeKey, (edges = []));
      edges.push(execution);
    }

    // Every enclosing registration counts this visit, which is what a subgraph box reports without
    // walking its children at draw time.
    let container: WorkflowExecutionDto | undefined = execution;
    const seen = new Set<number>();
    while (container) {
      const frame = state.frames.get(container.frameId);
      const parentId = frame?.parentExecutionId ?? null;
      if (parentId === null || seen.has(parentId)) break;
      seen.add(parentId);
      const parent = state.executions.get(parentId);
      if (!parent) break;
      const parentKey = executionAddressKey(state, parent);
      nestedCounts.set(parentKey, (nestedCounts.get(parentKey) ?? 0) + 1);
      container = parent;
    }

    if (previous === null || previous.executions.get(execution.executionId) !== execution) {
      changedKeys.add(key);
      if (routing !== null) changedKeys.add(addressKey(routing));
      for (const ancestorKey of enclosingKeys(state, execution)) changedKeys.add(ancestorKey);
    }
  }

  // A row that disappeared — a fresh baseline that no longer reports it — also changes its address.
  if (previous !== null) {
    for (const [id, execution] of previous.executions) {
      if (state.executions.has(id)) continue;
      changedKeys.add(executionAddressKey(state, execution));
    }
  }

  const membership: Membership = {
    members: new Map([...membersOf].map(([key, rows]) => [key, rows.slice().sort(compareByStart)])),
    routings: routingByEdge,
    nested: nestedCounts,
  };

  const keys = new Set<string>([...membersOf.keys(), ...routingByEdge.keys()]);
  if (topology) for (const key of topology.elements.keys()) keys.add(key);

  const byElement = new Map<string, ElementAggregate>();
  const recomputed: string[] = [];
  const clockChanged = previous === null || previous.now !== now;

  for (const key of keys) {
    const cached = previous?.byElement.get(key);
    const stale =
      cached === undefined ||
      changedKeys.has(key) ||
      // Only an aggregate with something still running depends on the clock, so a tick does not
      // re-derive a finished node.
      (clockChanged && (cached.callbackOpen || cached.waitOpen));
    if (!stale) {
      byElement.set(key, cached);
      continue;
    }
    recomputed.push(key);
    byElement.set(key, deriveFor(key, membership, now));
  }

  const takenLinks = new Set<string>();
  if (topology) {
    for (const link of topology.links) {
      if (link.destinationId === null) {
        // Source → edge: taken once a routing segment for that edge actually started. Arriving at
        // the edge is a recorded fact of its own, separate from which destination it then chose.
        const started = routingByEdge
          .get(link.edgeKey)
          ?.some((execution) => execution.routing?.startedAt != null);
        if (started === true) takenLinks.add(link.id);
        continue;
      }
      const edge = byElement.get(link.edgeKey);
      if (edge?.chosenDestinations.includes(link.destinationId)) takenLinks.add(link.id);
    }
  }

  return {
    executions: state.executions,
    topology,
    membership,
    byElement,
    takenLinks,
    recomputed,
    now,
  };
}

/**
 * A pass where only the clock moved.
 *
 * Membership, taken links and every finished aggregate are carried over untouched; the only work is
 * re-deriving the aggregates that actually have something open, which is bounded by how much of the
 * run is running rather than by how much of it has run.
 */
function reclock(previous: VisitAggregation, now: number): VisitAggregation {
  if (previous.now === now) return previous;
  const byElement = new Map(previous.byElement);
  const recomputed: string[] = [];
  for (const [key, aggregate] of previous.byElement) {
    if (!aggregate.callbackOpen && !aggregate.waitOpen) continue;
    recomputed.push(key);
    byElement.set(key, deriveFor(key, previous.membership, now));
  }
  // `takenLinks` is carried over intact, which is only sound because the caller has already
  // established that the topology it was derived from is the same one.
  return { ...previous, byElement, recomputed, now };
}

function deriveFor(key: string, membership: Membership, now: number): ElementAggregate {
  return deriveAggregate({
    key,
    visits: membership.members.get(key) ?? [],
    routings: membership.routings.get(key) ?? [],
    nested: membership.nested.get(key) ?? 0,
    now,
  });
}

function enclosingKeys(state: WorkflowRunState, execution: WorkflowExecutionDto): string[] {
  const keys: string[] = [];
  let current: WorkflowExecutionDto | undefined = execution;
  const seen = new Set<number>();
  while (current) {
    const frame = state.frames.get(current.frameId);
    const parentId = frame?.parentExecutionId ?? null;
    if (parentId === null || seen.has(parentId)) break;
    seen.add(parentId);
    const parent = state.executions.get(parentId);
    if (!parent) break;
    keys.push(executionAddressKey(state, parent));
    current = parent;
  }
  return keys;
}

function compareByStart(left: WorkflowExecutionDto, right: WorkflowExecutionDto): number {
  if (left.startedAt !== right.startedAt) return left.startedAt < right.startedAt ? -1 : 1;
  return left.executionId - right.executionId;
}

function deriveAggregate(input: {
  readonly key: string;
  readonly visits: readonly WorkflowExecutionDto[];
  readonly routings: readonly WorkflowExecutionDto[];
  readonly nested: number;
  readonly now: number;
}): ElementAggregate {
  const { visits, routings, now } = input;

  const chosen: string[] = [];
  for (const execution of routings) {
    const destination = execution.routing?.chosen ?? null;
    if (destination !== null && !chosen.includes(destination)) chosen.push(destination);
  }

  if (visits.length === 0) {
    // An edge element has no executions of its own; its facts come from the routing segments of the
    // nodes that ran it.
    if (routings.length === 0) return { ...emptyAggregate(input.key), chosenDestinations: chosen };
    const failed = routings.some((execution) => execution.routing?.failure != null);
    const open = routings.some(
      (execution) => execution.routing?.startedAt != null && execution.routing.endedAt === null,
    );
    let callbackMs = 0;
    for (const execution of routings) {
      const routing = execution.routing;
      if (!routing?.startedAt) continue;
      const started = Date.parse(routing.startedAt);
      const ended = routing.endedAt === null ? now : Date.parse(routing.endedAt);
      if (!Number.isNaN(started) && !Number.isNaN(ended))
        callbackMs += Math.max(0, ended - started);
    }
    return {
      ...emptyAggregate(input.key),
      status: failed ? 'failed' : open ? 'running' : 'completed',
      callbackMs,
      callbackOpen: open,
      chosenDestinations: chosen,
    };
  }

  let callbackMs = 0;
  let waitMs = 0;
  let callbackOpen = false;
  let waitOpen = false;
  let hasUnknownEnd = false;
  let operationCount = 0;
  let unresolvedOperations = 0;
  let evidenceCaptured = 0;
  const capabilities: WorkflowCapability[] = [];

  for (const visit of visits) {
    const timing = executionTiming(visit);
    const callback = intervalDuration(timing.callback, now);
    if (callback !== null) callbackMs += callback;
    if (isOpen(timing.callback)) callbackOpen = true;
    const wait = intervalDuration(timing.wait, now);
    if (wait !== null) waitMs += wait;
    if (isOpen(timing.wait)) waitOpen = true;
    if (visit.endCertainty === 'unknown' && visit.endedAt === null) hasUnknownEnd = true;
    operationCount += visit.operationSummary.count;
    unresolvedOperations += visit.operationSummary.unresolved;
    evidenceCaptured += visit.operationSummary.evidenceCaptured;
    for (const capability of visit.operationSummary.capabilities) {
      if (!capabilities.includes(capability)) capabilities.push(capability);
    }
  }

  return {
    key: input.key,
    visits,
    status: rollUpStatus(visits),
    callbackMs,
    callbackOpen,
    waitMs,
    waitOpen,
    hasUnknownEnd,
    capabilities,
    operationCount,
    unresolvedOperations,
    evidenceCaptured,
    nestedExecutionCount: input.nested,
    chosenDestinations: chosen,
  };
}

/**
 * One status for a node with several visits.
 *
 * Anything still live outranks how the last finished visit ended, because a node with a visit in
 * flight is a node the run is inside. Below that, the latest visit speaks: a node that failed and
 * was repaired reads as repaired, which is what actually happened.
 */
function rollUpStatus(visits: readonly WorkflowExecutionDto[]): ElementStatus {
  for (const live of ['awaiting', 'running', 'routing', 'mapping'] as const) {
    if (visits.some((visit) => visit.status === live)) return live;
  }
  return visits.at(-1)?.status === 'failed' ? 'failed' : 'completed';
}
