import type { WorkflowExecutionSummaryDto } from '@isagi/contracts';

import type { WorkflowRunView } from '../../../lib/workspace/workflow/run-view.js';
import { executionAddressKey } from './ancestry.js';

/** The inspector's three tabs, over one shared dock. */
export type InspectorTab = 'declared' | 'trace' | 'checkpoints';

/**
 * What the dock is currently describing: a declared element of the current build, one execution,
 * or one graph invocation. Each names a real identity the runtime issued, or a declared address.
 */
export type InspectorSelection =
  | { readonly kind: 'element'; readonly key: string }
  | { readonly kind: 'execution'; readonly executionId: number }
  | { readonly kind: 'invocation'; readonly invocationId: number };

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
      return left.executionId === (right as { executionId: number }).executionId;
    case 'invocation':
      return left.invocationId === (right as { invocationId: number }).invocationId;
  }
}

/** The execution a selection is about, when it has one. Drives the execution detail read. */
export function selectedExecutionId(
  selection: InspectorSelection | null,
  view: WorkflowRunView | null,
): number | null {
  if (selection === null || view === null) return null;
  switch (selection.kind) {
    case 'execution':
      return selection.executionId;
    case 'element':
      // A declared element with visits selects its latest one, which is what a person means by
      // clicking a node that has run more than once.
      return visitsOf(view, selection.key).at(-1)?.executionId ?? null;
    case 'invocation':
      return null;
  }
}

/** Every execution at one declared address, in start order. Retries are visits too. */
export function visitsOf(
  view: WorkflowRunView,
  elementKey: string,
): readonly WorkflowExecutionSummaryDto[] {
  const visits: WorkflowExecutionSummaryDto[] = [];
  for (const id of view.executionOrder) {
    const execution = view.executions.get(id);
    if (execution && executionAddressKey(view, execution) === elementKey) visits.push(execution);
  }
  return visits;
}

/**
 * Whether a selection still names something this run has, so a selection that survived into a
 * different run cannot describe one run's execution under another's heading.
 */
export function selectionResolves(
  selection: InspectorSelection | null,
  view: WorkflowRunView | null,
): boolean {
  if (selection === null) return true;
  if (view === null) return false;
  switch (selection.kind) {
    case 'element':
      return true;
    case 'execution':
      return view.executions.has(selection.executionId);
    case 'invocation':
      return view.invocations.has(selection.invocationId);
  }
}
