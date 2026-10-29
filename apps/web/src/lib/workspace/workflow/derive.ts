import type { AttentionState, WorkflowRunSummary, WorkflowWaitDto } from '@isagi/contracts';

import { workflowCopy } from '../../../copy/index.js';

export type WorkflowPresentationStatus =
  | 'preparing'
  | 'driving'
  | 'waiting_user'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'done';

/** A wait that asks the person something. */
export type WorkflowUserWait = Extract<WorkflowWaitDto, { kind: 'user_continue' | 'user_input' }>;

/** The colour family a run is shown in; each surface maps it to its own classes. */
export type WorkflowTone = 'working' | 'waiting' | 'idle' | 'error' | 'success';

/**
 * The two different things "failed" can mean, kept apart.
 *
 * A workflow that declared a failure outcome finished on purpose and has nothing to repair; a
 * step that threw stopped mid-run and is what a Retry would act on. Both read as failed, and only
 * the explanation differs.
 */
export type WorkflowRunFailure =
  | { readonly kind: 'outcome'; readonly reason: string }
  | { readonly kind: 'error'; readonly error: NonNullable<WorkflowRunSummary['error']> };

/**
 * A run as the client presents it.
 *
 * This is the only place that interprets a run summary's status and outcome; every surface reads
 * this view instead, so the headline, the explanation and the attention signal cannot disagree.
 */
export interface WorkflowRunPresentation {
  readonly status: WorkflowPresentationStatus;
  readonly tone: WorkflowTone;
  readonly label: string;
  readonly attention: AttentionState | null;
  /** The one sentence under the heading that says where the run is, when the heading cannot. */
  readonly reason: string | null;
  readonly failure: WorkflowRunFailure | null;
  /** The user wait the run is parked on, if the bar should ask the person something. */
  readonly wait: WorkflowUserWait | null;
  /**
   * Whether the bar offers the question form.
   *
   * A paused run still accepts an answer: it is stored and applied when the run resumes.
   */
  readonly canAnswer: boolean;
  /**
   * Passed through as the runtime sent them, never re-derived from the status.
   *
   * The runtime rechecks them at mutation time, so offering exactly what they permit is what stops
   * the bar from showing a button the runtime is guaranteed to refuse.
   */
  readonly controls: WorkflowRunSummary['controls'];
}

const headline: Record<
  WorkflowPresentationStatus,
  {
    readonly tone: WorkflowTone;
    readonly label: string;
    readonly attention: AttentionState | null;
  }
> = {
  preparing: { tone: 'working', label: 'Preparing', attention: 'working' },
  driving: { tone: 'working', label: 'Driving', attention: 'working' },
  waiting_user: { tone: 'waiting', label: 'Waiting', attention: 'waiting' },
  paused: { tone: 'idle', label: 'Paused', attention: 'idle' },
  failed: { tone: 'error', label: 'Failed', attention: 'error' },
  // A cancelled run left work unfinished on purpose, so it settles rather than reading as success.
  cancelled: { tone: 'idle', label: 'Cancelled', attention: null },
  done: { tone: 'success', label: 'Done', attention: null },
};

export function workflowRunPresentation(summary: WorkflowRunSummary): WorkflowRunPresentation {
  const failure = runFailure(summary);
  const wait = userWait(summary);
  const status = presentationStatus(summary, failure, wait);
  return {
    status,
    ...headline[status],
    reason: summary.status === 'preparing' ? workflowCopy.preparing : null,
    failure,
    wait,
    canAnswer: wait !== null && (summary.status === 'waiting' || summary.status === 'paused'),
    controls: summary.controls,
  };
}

export function workflowPresentationStatus(
  summary: WorkflowRunSummary,
): WorkflowPresentationStatus {
  return workflowRunPresentation(summary).status;
}

export function workflowRunAttention(summary?: WorkflowRunSummary | null): AttentionState | null {
  return summary ? workflowRunPresentation(summary).attention : null;
}

function presentationStatus(
  summary: WorkflowRunSummary,
  failure: WorkflowRunFailure | null,
  wait: WorkflowUserWait | null,
): WorkflowPresentationStatus {
  switch (summary.status) {
    case 'preparing':
      return 'preparing';
    case 'completed':
      // The runtime records an authored failure outcome as completed; it still failed.
      return failure === null ? 'done' : 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'paused':
      return 'paused';
    case 'failed':
      return 'failed';
    case 'waiting':
      return wait === null ? 'driving' : 'waiting_user';
    case 'running':
      return 'driving';
  }
}

function runFailure(summary: WorkflowRunSummary): WorkflowRunFailure | null {
  if (summary.outcome?.kind === 'failure') {
    return { kind: 'outcome', reason: summary.outcome.reason ?? workflowCopy.outcomeFailure };
  }
  return summary.error ? { kind: 'error', error: summary.error } : null;
}

function userWait(summary: WorkflowRunSummary): WorkflowUserWait | null {
  const wait = summary.current?.wait ?? null;
  if (wait === null || (wait.kind !== 'user_continue' && wait.kind !== 'user_input')) return null;
  return wait;
}
