import type {
  StructureDiagnostic,
  WorkflowStructureDescriptor,
} from '@yourtechbudstudio/isagi-workflow-verifier/structure';

import type { WorkflowNodeKind } from '@isagi/contracts';

/**
 * Whether a newer build still fits where a run is parked.
 *
 * Resume and Retry move a run to the latest verified build. Only the active path has to survive:
 * - every open graph invocation's graph is still declared;
 * - every subgraph link on that path still names the same child graph;
 * - the parked node still exists with the same kind.
 *
 * Nodes the run has already finished with may be renamed or removed freely. A non-empty result
 * refuses the control and leaves the run unchanged.
 */
export interface ReloadPosition {
  /** Root first. Each entry is an open graph invocation on the path to the parked node. */
  readonly invocations: readonly {
    readonly graphKey: string;
    /** The subgraph node in the parent invocation that entered this one. Null for the root. */
    readonly enteredBy: { readonly graphKey: string; readonly nodeId: string } | null;
  }[];
  /** The execution the run is parked on, or the one a Retry is about to repeat. */
  readonly parked: {
    readonly graphKey: string;
    readonly nodeId: string;
    readonly nodeKind: WorkflowNodeKind;
  } | null;
}

export function checkReload(
  descriptor: WorkflowStructureDescriptor,
  position: ReloadPosition,
): readonly StructureDiagnostic[] {
  const diagnostics: StructureDiagnostic[] = [];
  const graphs = new Map(descriptor.graphs.map((graph) => [graph.key, graph]));

  for (const invocation of position.invocations) {
    if (!graphs.has(invocation.graphKey)) {
      diagnostics.push({
        code: 'graph_missing',
        message: `Graph "${invocation.graphKey}" is no longer declared, so the run has nowhere to continue.`,
        at: { graphKey: invocation.graphKey },
      });
      continue;
    }
    const link = invocation.enteredBy;
    if (link === null) continue;
    const node = graphs.get(link.graphKey)?.nodes.find((candidate) => candidate.id === link.nodeId);
    if (!node || node.kind !== 'subgraph' || node.graphKey !== invocation.graphKey) {
      diagnostics.push({
        code: 'subgraph_registration_changed',
        message: `Subgraph node "${link.nodeId}" in graph "${link.graphKey}" no longer enters graph "${invocation.graphKey}".`,
        at: { graphKey: link.graphKey, nodeId: link.nodeId },
      });
    }
  }

  const parked = position.parked;
  if (parked && graphs.has(parked.graphKey)) {
    const node = graphs
      .get(parked.graphKey)
      ?.nodes.find((candidate) => candidate.id === parked.nodeId);
    if (!node) {
      diagnostics.push({
        code: 'node_missing',
        message: `Node "${parked.nodeId}" in graph "${parked.graphKey}" is no longer declared, and the run is parked on it.`,
        at: { graphKey: parked.graphKey, nodeId: parked.nodeId },
      });
    } else if (node.kind !== parked.nodeKind) {
      diagnostics.push({
        code: 'node_kind_changed',
        message: `Node "${parked.nodeId}" in graph "${parked.graphKey}" changed from ${parked.nodeKind} to ${node.kind}.`,
        at: { graphKey: parked.graphKey, nodeId: parked.nodeId },
      });
    }
  }
  return diagnostics;
}
