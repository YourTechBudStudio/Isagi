import type { AttentionState, WorkflowSurfaceSummary } from '@isagi/contracts';

export function surfaceLockState(summary?: WorkflowSurfaceSummary | null): boolean {
  return summary?.status === 'driving';
}

export function workflowSurfaceAttention(
  summary?: WorkflowSurfaceSummary | null,
): AttentionState | null {
  switch (summary?.status) {
    case 'driving':
      return 'working';
    case 'waiting_user':
      return 'waiting';
    case 'failed':
      return 'error';
    case 'paused':
      return 'idle';
    case 'done':
    case undefined:
      return null;
  }
}
