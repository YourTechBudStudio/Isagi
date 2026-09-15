import type {
  WorkflowOperationState,
  WorkflowRunStatus,
  WorkflowWaitStatus,
} from '@isagi/contracts';

import type { WorkflowTransitionRecord } from './records.js';

/**
 * Why a guarded write did not apply.
 *
 * These are *expected* outcomes, not errors. A duplicate wait delivery, a stale prepared control and
 * a claim that lost a race are all things the system is built to produce, and a caller decides what
 * each one means — usually "do nothing", which is exactly why they are returned rather than thrown.
 *
 * Four guard classes, matched to what each write actually owns, because one fence cannot serve all
 * of them: an operation settles long after its callback attempt closed, and startup recovery writes
 * with ownership already cleared, so an attempt-ownership fence would reject precisely the evidence
 * that has to be kept.
 */
export type WorkflowWriteRejection =
  | { readonly kind: 'run_not_found' }
  /** Control-revision fence: the decision was prepared from state that has since changed. */
  | { readonly kind: 'control_revision_changed'; readonly controlRevision: number }
  | {
      readonly kind: 'not_claimable';
      readonly reason:
        | 'status'
        | 'paused'
        | 'cancel_requested'
        | 'environment_unavailable'
        | 'placement_missing'
        | 'position_not_executable';
    }
  /** Attempt-ownership fence: this worker is not the one currently holding the segment. */
  | { readonly kind: 'attempt_not_owned' }
  /** Operation-state fence: a monotonic guard, so a late or duplicate write is a no-op. */
  | { readonly kind: 'operation_state_conflict'; readonly state: WorkflowOperationState }
  /** Wait-identity fence: this wait has already moved past `armed`. */
  | { readonly kind: 'wait_already_resolved'; readonly status: WorkflowWaitStatus }
  | { readonly kind: 'surface_busy'; readonly runId: number }
  /**
   * The run's destination no longer exists. Structured, not an HTTP reason: phase 04's control layer
   * maps it to `workflow_environment_unavailable`, and this repository stays unaware of the wire.
   */
  | {
      readonly kind: 'environment_unavailable';
      readonly worktreeId: number | null;
      readonly surfaceId: number | null;
    }
  | { readonly kind: 'run_terminal'; readonly status: WorkflowRunStatus }
  | { readonly kind: 'position_mismatch' }
  /**
   * A recorded call position was re-entered with a materially different request.
   *
   * The call position identifies *one* intended effect. Adopting a recorded operation whose request
   * differs would hand the caller a receipt for something it did not ask for — and, for a keyed
   * creation, an already-created resource built to the earlier request.
   */
  | {
      readonly kind: 'operation_request_changed';
      readonly recordedFingerprint: string;
      readonly requestedFingerprint: string;
    }
  /**
   * An operand the caller composed its input from has moved since it read it. Named by source, so a
   * caller can tell a repin apart from a state boundary that advanced under it.
   */
  | { readonly kind: 'stale_preparation'; readonly source: 'artifact_hash' | 'frame_state' }
  /**
   * The frame this transaction was aimed at is the wrong kind for it.
   *
   * A child's output is published by one transaction and a root's by another, and neither may stand
   * in for the other: publishing a root through the child path would complete its frame without
   * completing the run, leaving a finished frame under a run still asking for its output.
   */
  | { readonly kind: 'frame_role_mismatch'; readonly expected: 'root' | 'child' };

export type WorkflowWriteResult<A> =
  | {
      readonly ok: true;
      readonly value: A;
      /**
       * What this transaction committed, in revision order.
       *
       * Returned so the caller can publish **after** the commit. Phase 05 owns the publisher; the
       * records are produced here because only the transaction knows what it wrote.
       */
      readonly transitions: readonly WorkflowTransitionRecord[];
    }
  | { readonly ok: false; readonly rejection: WorkflowWriteRejection };

export function committed<A>(
  value: A,
  transitions: readonly WorkflowTransitionRecord[],
): WorkflowWriteResult<A> {
  return { ok: true, value, transitions };
}

export function rejected<A>(rejection: WorkflowWriteRejection): WorkflowWriteResult<A> {
  return { ok: false, rejection };
}

/**
 * Whether an attempt-ownership commit advanced the graph or only recorded what happened.
 *
 * Cancel revokes permission to *advance*, never permission to *record*: a callback that was already
 * running reaches its durable boundary and its result is kept as cancelled-attempt evidence, with no
 * state reduction, no next position and no revival of the run.
 */
export type SegmentCommitOutcome = 'advanced' | 'cancelled_evidence';
