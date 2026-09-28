import type { AttentionState, WorkflowRunSummary } from '@isagi/contracts';

import { workflowCopy } from '../../../copy/index.js';

export type WorkflowPresentationStatus =
  | 'preparing'
  | 'driving'
  | 'waiting_user'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'done';

export function workflowPresentationStatus(
  summary: WorkflowRunSummary,
): WorkflowPresentationStatus {
  switch (summary.status) {
    case 'preparing':
      return 'preparing';
    case 'completed':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    case 'paused':
      return 'paused';
    case 'failed':
      return 'failed';
    case 'waiting':
      return userWait(summary) === null ? 'driving' : 'waiting_user';
    case 'running':
      return 'driving';
  }
}

/** The user wait the run is parked on, if the bar should ask the person something. */
export function userWait(summary: WorkflowRunSummary) {
  const wait = summary.current?.wait ?? null;
  if (wait === null || (wait.kind !== 'user_continue' && wait.kind !== 'user_input')) return null;
  return wait;
}

/**
 * Whether the bar offers the question form.
 *
 * A paused run still accepts an answer: it is stored and applied when the run resumes.
 */
export function canAnswer(summary: WorkflowRunSummary): boolean {
  return (
    userWait(summary) !== null && (summary.status === 'waiting' || summary.status === 'paused')
  );
}

export function workflowRunAttention(summary?: WorkflowRunSummary | null): AttentionState | null {
  if (!summary) return null;
  switch (workflowPresentationStatus(summary)) {
    case 'preparing':
    case 'driving':
      return 'working';
    case 'waiting_user':
      return 'waiting';
    case 'failed':
      return 'error';
    case 'paused':
      return 'idle';
    case 'cancelled':
    case 'done':
      return null;
  }
}

/** The one sentence under the heading that says where the run is, when the heading cannot. */
export function workflowReasonLine(summary: WorkflowRunSummary): string | null {
  return summary.status === 'preparing' ? workflowCopy.preparing : null;
}
