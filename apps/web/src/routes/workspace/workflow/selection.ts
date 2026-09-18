import type { WorkflowExecutionDto } from '@isagi/contracts';

import type { WorkflowRunState } from '../../../lib/workspace/workflow/model.js';
import { executionAddressKey } from './ancestry.js';

/**
 * What the dock is currently describing.
 *
 * Every variant names a durable identity the runtime issued, or a declared address under the current
 * pin — never a synthesized composite. A routing segment is addressed by the execution that ran it
 * and a frame-owned segment by its frame, because that is where those facts actually live; inventing
 * a node-execution id for them would put a fabricated identity on screen beside real ones.
 */
export type InspectorSelection =
  | { readonly kind: 'element'; readonly key: string }
  | { readonly kind: 'execution'; readonly executionId: number }
  | { readonly kind: 'routing'; readonly executionId: number }
  | {
      readonly kind: 'frame_segment';
      readonly frameId: number;
      readonly segment: 'entry' | 'output';
    }
  | { readonly kind: 'frame_output'; readonly frameId: number };

export function selectionEquals(
  left: InspectorSelection | null,
  right: InspectorSelection | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'element':
      return left.key === (right as { key: string }).key;
    case 'execution':
    case 'routing':
      return left.executionId === (right as { executionId: number }).executionId;
    case 'frame_output':
      return left.frameId === (right as { frameId: number }).frameId;
    case 'frame_segment':
      return (
        left.frameId === (right as { frameId: number }).frameId &&
        left.segment === (right as { segment: string }).segment
      );
  }
}

/** The execution a selection is about, when it has one. Drives the operations hydration. */
export function selectedExecutionId(
  selection: InspectorSelection | null,
  state: WorkflowRunState | null,
): number | null {
  if (selection === null || state === null) return null;
  switch (selection.kind) {
    case 'execution':
    case 'routing':
      return selection.executionId;
    case 'element': {
      // A declared element with visits selects its latest one, which is what a person means by
      // clicking a node that has run more than once without choosing a pip.
      const visits = visitsOf(state, selection.key);
      return visits.at(-1)?.executionId ?? null;
    }
    default:
      return null;
  }
}

export function visitsOf(
  state: WorkflowRunState,
  elementKey: string,
): readonly WorkflowExecutionDto[] {
  const visits: WorkflowExecutionDto[] = [];
  for (const execution of state.executions.values()) {
    if (executionAddressKey(state, execution) === elementKey) visits.push(execution);
  }
  return visits.sort((left, right) =>
    left.startedAt === right.startedAt
      ? left.executionId - right.executionId
      : left.startedAt < right.startedAt
        ? -1
        : 1,
  );
}

/**
 * Whether a selection still names something this projection has.
 *
 * Checked when the attached run changes or a baseline is replaced: a selection that survived into a
 * different run would describe one run's visit under another run's heading.
 */
export function selectionResolves(
  selection: InspectorSelection | null,
  state: WorkflowRunState | null,
): boolean {
  if (selection === null) return true;
  if (state === null) return false;
  switch (selection.kind) {
    case 'element':
      return true;
    case 'execution':
    case 'routing':
      return state.executions.has(selection.executionId);
    case 'frame_output':
    case 'frame_segment':
      return state.frames.has(selection.frameId);
  }
}
