import type { AttentionState, WorkflowRunSummary } from '@isagi/contracts';

import { workflowCopy } from '../../../copy/index.js';

export type WorkflowPresentationStatus =
  | 'driving'
  | 'waiting_user'
  | 'blocked'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'done';

export function workflowPresentationStatus(
  summary: WorkflowRunSummary,
): WorkflowPresentationStatus {
  // A run that has stopped for good outranks a pause gate, deliberately and defensively. "Paused"
  // on a cancelled run is the one reading a person would act on wrongly — they would wait for it to
  // carry on. The runtime now lowers the gate on cancel, so this is belt and braces, but the flag
  // and the status must never be able to disagree on screen.
  //
  // Only `done` and `cancelled` qualify. A failed run has not stopped for good — it is exactly the
  // state a Retry acts on — so a paused failed run still reads as paused.
  if (summary.status === 'done') return 'done';
  if (summary.status === 'cancelled') return 'cancelled';
  if (summary.paused) return 'paused';
  if (
    summary.blockingWait &&
    (summary.blockingWait.kind === 'user_continue' || summary.blockingWait.kind === 'user_input')
  ) {
    return 'waiting_user';
  }
  if (summary.status === 'blocked') return 'blocked';
  return summary.status === 'failed' ? 'failed' : 'driving';
}

export function workflowRunAttention(summary?: WorkflowRunSummary | null): AttentionState | null {
  if (!summary) return null;
  switch (workflowPresentationStatus(summary)) {
    case 'driving':
      return 'working';
    case 'waiting_user':
      return 'waiting';
    // A blocked run is not waiting on a person to answer a question — it is stuck on something
    // Isagi cannot resolve, and it needs someone to look. That is the error signal, not the
    // waiting one.
    case 'blocked':
    case 'failed':
      return 'error';
    case 'paused':
      return 'idle';
    case 'cancelled':
    case 'done':
      return null;
  }
}

/**
 * What the bar says about a stop that could not be completed.
 *
 * Cancel is best-effort, and the counts are the only honest account of it. Pending outranks a
 * refusal, which outranks work Isagi has no way to stop at all; `null` means the stop was clean, or
 * no stop was ever requested.
 */
export function workflowStopNotice(summary: WorkflowRunSummary): string | null {
  const stop = summary.stopSummary;
  if (!stop || stop.requested === 0) return null;
  if (stop.pending > 0) return workflowCopy.stopPending;
  if (stop.failed > 0) return workflowCopy.stopFailed;
  if (stop.unsupported > 0) return workflowCopy.stopUnsupported;
  return null;
}

/**
 * The one sentence under the heading that explains where the run actually is.
 *
 * Derived from recorded facts in the order that decides what a person should do next: an
 * unavailable environment blocks everything, an unconfirmed external step is why a run is holding,
 * and a failure is what a Retry would act on.
 */
export function workflowReasonLine(summary: WorkflowRunSummary): string | null {
  if (!summary.destination.available && summary.endedAt === null) {
    return workflowCopy.environmentUnavailable;
  }
  if (summary.blockedOperation) return workflowCopy.blockedOperation;
  return workflowStopNotice(summary);
}
