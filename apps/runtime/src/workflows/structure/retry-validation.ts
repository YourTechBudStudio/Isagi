import type {
  GraphDescriptor,
  NodeDescriptor,
  StructureDiagnostic,
  WorkflowStructureDescriptor,
} from '@yourtechbudstudio/isagi-workflow-verifier/structure';

import type { WorkflowRunPosition } from '@isagi/contracts';

import type { WorkflowExecutionRecord, WorkflowFrameRecord } from '../persistence/records.js';

/**
 * Whether a candidate definition still fits where a run is parked.
 *
 * Pure, and deliberately so: it decides whether a Retry may adopt a new pin *before* anything is
 * written, and a non-empty result leaves the run's state, pin, position, attempts and adoption
 * history byte-identical. No author callback runs — in particular `init` is never called to migrate
 * an existing frame's state, because a state boundary that already committed is a fact rather than
 * something to recompute.
 *
 * Only the *active* path is checked. Historical nodes that ran under an older version are not
 * required to survive, which is what makes ordinary refactoring compatible with resuming a run: an
 * author may delete a node a run has already finished with, but not the one it is sitting on.
 */
export interface SavedPositionInput {
  readonly descriptor: WorkflowStructureDescriptor;
  /** Root to leaf: every frame that is not completed, plus a completed child awaiting mapping. */
  readonly frames: readonly WorkflowFrameRecord[];
  readonly position: WorkflowRunPosition;
  /** The execution the position names, when it names one. */
  readonly execution?: WorkflowExecutionRecord | null;
  /** The parent execution of each frame, keyed by execution id. */
  readonly parentExecutions?: ReadonlyMap<number, WorkflowExecutionRecord>;
  /** A destination already chosen but not yet committed, which must still be declared. */
  readonly pendingDestination?: string | null;
}

export function validateSavedPositions(input: SavedPositionInput): readonly StructureDiagnostic[] {
  const diagnostics: StructureDiagnostic[] = [];
  const graphs = new Map(input.descriptor.graphs.map((graph) => [graph.key, graph]));

  const ordered = [...input.frames].sort((left, right) => left.depth - right.depth);
  const leaf = ordered.at(-1);

  for (const frame of ordered) {
    const graph = graphs.get(frame.graphKey);
    if (!graph) {
      diagnostics.push({
        code: 'graph_missing',
        message: `Graph "${frame.graphKey}" is no longer declared, so this run has nowhere to resume.`,
        at: { graphKey: frame.graphKey },
      });
      continue;
    }

    if (frame.parentExecutionId !== null) {
      const parent = input.parentExecutions?.get(frame.parentExecutionId);
      const parentGraph = parent
        ? graphs.get(ordered.find((candidate) => candidate.id === parent.frameId)?.graphKey ?? '')
        : undefined;
      const registration = parent && parentGraph ? findNode(parentGraph, parent.nodeId) : undefined;
      if (
        !registration ||
        registration.kind !== 'subgraph' ||
        registration.graphKey !== frame.graphKey
      ) {
        diagnostics.push({
          code: 'subgraph_registration_changed',
          message: `The subgraph node that invoked "${frame.graphKey}" no longer registers it, so the child frame has no parent to return to.`,
          at: parent
            ? { graphKey: frame.graphKey, nodeId: parent.nodeId }
            : { graphKey: frame.graphKey },
        });
      }
    }

    if (frame.id !== leaf?.id) continue;
    diagnostics.push(...validateLeafPosition(graph, input));
  }

  return diagnostics;
}

function validateLeafPosition(
  graph: GraphDescriptor,
  input: SavedPositionInput,
): readonly StructureDiagnostic[] {
  const diagnostics: StructureDiagnostic[] = [];
  const position = input.position;

  switch (position.kind) {
    // Both of this segment's callbacks are re-evaluated from scratch under the new pin, so there is
    // nothing yet committed for a structural change to invalidate.
    case 'graph_entry':
    case 'terminal':
      return diagnostics;

    /**
     * A run still preparing its environment has entered no frame and visited no node, so none of
     * the node, wait, routing or outcome checks below have anything to judge. Exactly one structural
     * fact can invalidate it: the graph it was created to run must still be the *root*.
     *
     * The graph-exists check in the caller is not sufficient on its own. An author who renames the
     * root graph but keeps the old key declared as a subgraph passes that lookup, and the run would
     * then resume against a graph the new code no longer enters at. `graph.key` is the leaf frame's
     * key, which at this position is the run's own root graph key, because the root frame is the
     * only frame `createRun` wrote.
     */
    case 'environment_preparation': {
      if (input.descriptor.rootGraphKey !== graph.key) {
        diagnostics.push({
          code: 'graph_missing',
          message: `Graph "${graph.key}" is no longer this workflow's root graph, so this run has nowhere to start.`,
          at: { graphKey: graph.key },
        });
      }
      return diagnostics;
    }

    case 'node_callback':
    case 'awaiting_wait': {
      const execution = input.execution;
      if (!execution) return diagnostics;
      const node = findNode(graph, execution.nodeId);
      if (!node) {
        diagnostics.push({
          code: 'node_missing',
          message: `Node "${execution.nodeId}" is no longer declared in graph "${graph.key}".`,
          at: { graphKey: graph.key, nodeId: execution.nodeId },
        });
      } else if (node.kind !== execution.nodeKind) {
        diagnostics.push({
          code: 'node_kind_changed',
          message: `Node "${execution.nodeId}" is now a ${node.kind} node; this run is parked on it as a ${execution.nodeKind} node.`,
          at: { graphKey: graph.key, nodeId: execution.nodeId },
        });
      }
      return diagnostics;
    }

    case 'routing': {
      const execution = input.execution;
      if (!execution) return diagnostics;
      const node = findNode(graph, execution.nodeId);
      if (!node) {
        diagnostics.push({
          code: 'node_missing',
          message: `Node "${execution.nodeId}" is no longer declared in graph "${graph.key}".`,
          at: { graphKey: graph.key, nodeId: execution.nodeId },
        });
        return diagnostics;
      }
      // Exactly one router per executable node is a structural rule, so "the edge leaving this
      // node" is an identity rather than a choice. If that identity changed, the saved routing
      // position names an edge that no longer exists.
      const outgoing = graph.edges.filter((edge) => edge.from === execution.nodeId);
      const edge = outgoing.length === 1 ? outgoing[0] : undefined;
      if (!edge || edge.id !== position.edgeId) {
        diagnostics.push({
          code: 'edge_identity_changed',
          message: `The edge leaving "${execution.nodeId}" is no longer "${position.edgeId}".`,
          at: { graphKey: graph.key, nodeId: execution.nodeId, edgeId: position.edgeId },
        });
        return diagnostics;
      }
      if (input.pendingDestination && !edge.to.includes(input.pendingDestination)) {
        diagnostics.push({
          code: 'destination_no_longer_declared',
          message: `This run already chose "${input.pendingDestination}", which edge "${edge.id}" no longer declares.`,
          at: { graphKey: graph.key, edgeId: edge.id },
        });
      }
      return diagnostics;
    }

    case 'graph_output': {
      const outcome = graph.outcomes.find((candidate) => candidate.id === position.outcomeId);
      if (!outcome) {
        diagnostics.push({
          code: 'outcome_missing',
          message: `Outcome "${position.outcomeId}" is no longer declared in graph "${graph.key}".`,
          at: { graphKey: graph.key, outcomeId: position.outcomeId },
        });
      }
      return diagnostics;
    }

    case 'child_output_mapping': {
      const execution = input.execution;
      if (!execution) return diagnostics;
      const node = findNode(graph, execution.nodeId);
      if (!node) {
        diagnostics.push({
          code: 'node_missing',
          message: `Node "${execution.nodeId}" is no longer declared in graph "${graph.key}".`,
          at: { graphKey: graph.key, nodeId: execution.nodeId },
        });
      } else if (node.kind !== 'subgraph') {
        diagnostics.push({
          code: 'node_kind_changed',
          message: `Node "${execution.nodeId}" is no longer a subgraph node, but a completed child's output is waiting to be mapped through it.`,
          at: { graphKey: graph.key, nodeId: execution.nodeId },
        });
      }
      return diagnostics;
    }
  }
}

function findNode(graph: GraphDescriptor, nodeId: string): NodeDescriptor | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}
