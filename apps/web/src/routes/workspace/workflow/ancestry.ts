import type { WorkflowExecutionDto } from '@isagi/contracts';

import type { WorkflowRunState } from '../../../lib/workspace/workflow/model.js';
import { addressKey, type DeclaredAddress } from './topology.js';

/**
 * Where a recorded visit sits in the structure, derived from frames rather than from graph keys.
 *
 * An execution names its frame; a frame names the subgraph execution that opened it; that execution
 * names a node. Walking that chain gives the registration path — the same identity `topology.ts`
 * builds from the descriptor — so a reused graph's two invocations land on two different addresses
 * instead of merging.
 *
 * The walk is over recorded facts only. Nothing here consults the current pin, which is what lets a
 * visit of a node the current definition no longer declares keep an honest address in Trace.
 */

export interface ExecutionAncestry {
  /** Subgraph node ids from the root inwards. */
  readonly path: readonly string[];
  /** Execution ids of the enclosing subgraph visits, outermost first. */
  readonly ancestorExecutionIds: readonly number[];
  /** False when a frame in the chain is not in the projection, so the path is a best effort. */
  readonly complete: boolean;
}

export function executionAncestry(
  state: WorkflowRunState,
  execution: WorkflowExecutionDto,
): ExecutionAncestry {
  const path: string[] = [];
  const ancestors: number[] = [];
  let frameId: number | null = execution.frameId;
  let complete = true;
  // Bounded by containment depth, which the verifier caps; the guard is against a malformed
  // projection, not against a legitimately deep graph.
  for (let hops = 0; frameId !== null && hops < 64; hops += 1) {
    const frame = state.frames.get(frameId);
    if (!frame) {
      complete = false;
      break;
    }
    if (frame.parentExecutionId === null) break;
    const parent = state.executions.get(frame.parentExecutionId);
    if (!parent) {
      complete = false;
      break;
    }
    path.unshift(parent.nodeId);
    ancestors.unshift(parent.executionId);
    frameId = parent.frameId;
  }
  return { path, ancestorExecutionIds: ancestors, complete };
}

/** The declared address a visit was a visit *to*. */
export function executionAddress(
  state: WorkflowRunState,
  execution: WorkflowExecutionDto,
): DeclaredAddress {
  return { path: executionAncestry(state, execution).path, kind: 'node', id: execution.nodeId };
}

export function executionAddressKey(
  state: WorkflowRunState,
  execution: WorkflowExecutionDto,
): string {
  return addressKey(executionAddress(state, execution));
}

/**
 * The edge element a visit's routing segment ran.
 *
 * Routing belongs to the source node's execution, so the edge's address is that execution's own
 * registration path with the recorded edge id. A visit whose routing never started has no edge
 * address at all — an edge the run has not reached is not an edge it ran.
 */
export function routingAddress(
  state: WorkflowRunState,
  execution: WorkflowExecutionDto,
): DeclaredAddress | null {
  const edgeId = execution.routing?.edgeId ?? null;
  if (edgeId === null) return null;
  return { path: executionAncestry(state, execution).path, kind: 'edge', id: edgeId };
}
