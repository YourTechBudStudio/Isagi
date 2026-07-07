import type { AttentionState, WorkflowRunSummary } from '@isagi/contracts';

export type WorkflowPresentationStatus = 'driving' | 'waiting_user' | 'paused' | 'failed' | 'done';

export function workflowPresentationStatus(
  summary: WorkflowRunSummary,
): WorkflowPresentationStatus {
  if (summary.paused) return 'paused';
  if (
    summary.blockingWait &&
    (summary.blockingWait.kind === 'user_continue' || summary.blockingWait.kind === 'user_input')
  ) {
    return 'waiting_user';
  }
  if (summary.status === 'failed') return 'failed';
  if (summary.status === 'done') return 'done';
  return 'driving';
}

export function workflowRunAttention(summary?: WorkflowRunSummary | null): AttentionState | null {
  if (!summary) return null;
  switch (workflowPresentationStatus(summary)) {
    case 'driving':
      return 'working';
    case 'waiting_user':
      return 'waiting';
    case 'failed':
      return 'error';
    case 'paused':
      return 'idle';
    case 'done':
      return null;
  }
}
