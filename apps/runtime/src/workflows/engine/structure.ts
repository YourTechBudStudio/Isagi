import type { WorkflowNodeKind } from '@isagi/contracts';

import type { AnyGraphDefinition, LoadedWorkflowArtifact } from '../structure/loader.js';
import type { GraphEdge, GraphNode, GraphOutcome } from '../types.js';

/**
 * Reading a pinned artifact's structure the way the interpreter needs it.
 *
 * Every lookup here is against the *pin the run is executing under*, never against discovery and
 * never against a newer build. A saved position names a graph key, a node id, an edge id or an
 * outcome id; these functions turn those back into the executable objects that pin contains.
 *
 * A missing lookup is returned as `null` rather than thrown. Whether it is an expected failure or a
 * defect depends on the caller: a node missing at `node_callback` cannot happen under an immutable
 * pin and is a defect, while an outcome missing after a Retry adopted new code is an ordinary
 * segment failure the person can see and fix.
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
 * keeps the decision — defect or segment failure — with the caller.
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
 * through `Object.prototype` and hand the interpreter a function to execute as a node.
 */
function own<A>(record: Record<string, A>, key: string): A | null {
  return Object.prototype.hasOwnProperty.call(record, key) ? (record[key] ?? null) : null;
}
