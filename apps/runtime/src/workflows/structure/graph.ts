import type { WorkflowNodeKind } from '@isagi/contracts';

import type { AnyGraphDefinition, LoadedWorkflowArtifact } from '../structure/loader.js';
import type { GraphEdge, GraphNode, GraphOutcome } from '../types.js';

/**
 * Reading a loaded build's structure the way the engine needs it.
 *
 * Every lookup is against the build the run uses now. A saved row names a graph key, a node id or
 * an outcome id; these functions turn those back into the executable objects of that build.
 *
 * A missing lookup is returned as `null` rather than thrown: after Resume or Retry moved a run to
 * newer code, a node or outcome the run no longer reaches may legitimately be gone, and the caller
 * reports it as an execution failure the person can see and fix.
 */

export type AnyGraphNode = GraphNode<unknown, unknown>;
export type AnyGraphEdge = GraphEdge<unknown, unknown>;
export type AnyGraphOutcome = GraphOutcome<unknown, unknown>;

export function graphOf(
  artifact: LoadedWorkflowArtifact,
  graphKey: string,
): AnyGraphDefinition | null {
  return artifact.graphs.get(graphKey) ?? null;
}

export function nodeOf(graph: AnyGraphDefinition, nodeId: string): AnyGraphNode | null {
  return own(graph.nodes as Record<string, AnyGraphNode>, nodeId);
}

export function outcomeOf(graph: AnyGraphDefinition, outcomeId: string): AnyGraphOutcome | null {
  return own(graph.outcomes as Record<string, AnyGraphOutcome>, outcomeId);
}

export function edgeById(graph: AnyGraphDefinition, edgeId: string): AnyGraphEdge | null {
  return own(graph.edges as Record<string, AnyGraphEdge>, edgeId);
}

/**
 * The one router leaving a node.
 *
 * Exactly one is the structural contract the verifier enforces, so more than one here would mean
 * the loaded code disagrees with the descriptor that validated it. Returning `null` in that case
 * leaves the failure to the caller.
 */
export function edgeFromNode(
  graph: AnyGraphDefinition,
  nodeId: string,
): { readonly id: string; readonly edge: AnyGraphEdge } | null {
  const matches = Object.entries(graph.edges as Record<string, AnyGraphEdge>).filter(
    ([, edge]) => edge.from === nodeId,
  );
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ? { id: only[0], edge: only[1] } : null;
}

export function nodeKindOf(node: AnyGraphNode): WorkflowNodeKind {
  switch (node.isagiKind) {
    case 'operation-node':
      return 'operation';
    case 'subgraph-node':
      return 'subgraph';
    case 'checkpoint-node':
      return 'checkpoint';
  }
}

/** Whether a destination id names a node or an outcome of this graph, which is what routing checks. */
export function destinationKindOf(
  graph: AnyGraphDefinition,
  destination: string,
): 'node' | 'outcome' | null {
  if (own(graph.nodes as Record<string, unknown>, destination)) return 'node';
  if (own(graph.outcomes as Record<string, unknown>, destination)) return 'outcome';
  return null;
}

/**
 * Own-property lookup.
 *
 * A bundle's records are plain objects, so `graph.nodes['constructor']` would otherwise resolve
 * through `Object.prototype` and hand the engine a function to execute as a node.
 */
function own<A>(record: Record<string, A>, key: string): A | null {
  return Object.prototype.hasOwnProperty.call(record, key) ? (record[key] ?? null) : null;
}
