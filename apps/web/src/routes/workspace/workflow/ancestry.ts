import type { WorkflowExecutionSummaryDto } from '@isagi/contracts';

import type { WorkflowRunView } from '../../../lib/workspace/workflow/run-view.js';
import { addressKey, type DeclaredAddress, type DeclaredTopology } from './topology.js';

/**
 * Where a recorded execution sits in the structure, derived from graph invocations rather than
 * from graph keys.
 *
 * An execution names its invocation; an invocation names the subgraph execution that entered it;
 * that execution names a node. Walking that chain gives the registration path — the same identity
 * `topology.ts` builds from the descriptor — so a reused graph's two invocations land on two
 * different addresses instead of merging.
 */
export interface ExecutionAncestry {
  /** Subgraph node ids from the root inwards. */
  readonly path: readonly string[];
  /** Execution ids of the enclosing subgraph executions, outermost first. */
  readonly ancestorExecutionIds: readonly number[];
}

export function executionAncestry(
  view: WorkflowRunView,
  execution: WorkflowExecutionSummaryDto,
): ExecutionAncestry {
  const path: string[] = [];
  const ancestors: number[] = [];
  let invocationId: number | null = execution.invocationId;
  // Bounded by containment depth, which the verifier caps; the guard is against a malformed tree.
  for (let hops = 0; invocationId !== null && hops < 64; hops += 1) {
    const invocation = view.invocations.get(invocationId);
    if (!invocation || invocation.parentExecutionId === null) break;
    const parent = view.executions.get(invocation.parentExecutionId);
    if (!parent) break;
    path.unshift(parent.nodeId);
    ancestors.unshift(parent.executionId);
    invocationId = parent.invocationId;
  }
  return { path, ancestorExecutionIds: ancestors };
}

/** The declared address an execution was a visit *to*. */
export function executionAddress(
  view: WorkflowRunView,
  execution: WorkflowExecutionSummaryDto,
): DeclaredAddress {
  return { path: executionAncestry(view, execution).path, kind: 'node', id: execution.nodeId };
}

export function executionAddressKey(
  view: WorkflowRunView,
  execution: WorkflowExecutionSummaryDto,
): string {
  return addressKey(executionAddress(view, execution));
}

/**
 * The edge element an execution's routing ran: the one edge declared out of its node, at the same
 * registration path. Null when the execution has not routed yet or the current build does not
 * declare that edge.
 */
export function routingEdgeKey(
  view: WorkflowRunView,
  topology: DeclaredTopology | null,
  execution: WorkflowExecutionSummaryDto,
): string | null {
  if (execution.routedTo === null || topology === null) return null;
  return topology.routerOf.get(executionAddressKey(view, execution)) ?? null;
}
