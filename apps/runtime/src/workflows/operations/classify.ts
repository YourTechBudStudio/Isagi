/**
 * Evidence → settlement. Pure, and deliberately narrow about what counts as evidence.
 *
 * Every decision here reads the operation's **own** columns and its own receipt. Nothing consults a
 * `pty_processes` row status or a backend reference, because neither proves a spawn or a stop:
 * `createProcessMetadata` writes a placeholder ref at allocation, `prepareLaunch` writes the real
 * one *before* the spawn, `markLaunchFailed` writes a terminal status for a pre-spawn failure, and
 * the startup sweep rewrites every live `node_pty` row to `runtime_ephemeral_lost`. A classifier
 * built on any of those would answer the one question that matters — did an agent start running in
 * the user's worktree — backwards.
 */

import type { WorkflowOperationRecord } from '../persistence/records.js';
import { isSettled } from './correlation.js';
import type { HeadlessReceipt } from './receipts.js';

/**
 * What the durable record says should happen to a headless operation nobody is holding.
 *
 * `abandon` and `confirmed_failure` are the two halves of a reported launch failure and are not
 * interchangeable: a preparation failure never reached a backend, while a post-spawn failure may
 * have left an agent running, because `NodePtyBackend.launch` wraps the spawn *and* its listener
 * registration in one `Effect.try`.
 */
export type HeadlessEvidence =
  | { readonly kind: 'settled' }
  /** No allocation was ever linked, so nothing this intent asked for reached a process. */
  | { readonly kind: 'never_dispatched' }
  | { readonly kind: 'abandon'; readonly cause: string | null }
  | {
      readonly kind: 'confirmed_failure';
      readonly cause: string | null;
      readonly ptyProcessId: number;
    }
  | { readonly kind: 'uncertain'; readonly detail: string }
  | { readonly kind: 'interrupted'; readonly ptyProcessId: number; readonly lostOwner: string }
  | { readonly kind: 'owned'; readonly ptyProcessId: number };

export function classifyHeadlessEvidence(input: {
  readonly record: WorkflowOperationRecord;
  readonly receipt: HeadlessReceipt | null;
  readonly incarnationId: string;
}): HeadlessEvidence {
  const { record } = input;
  // A committed result wins over every other fact, including capture-owner loss. Consuming it never
  // deletes its receipt, and re-deriving a worse answer from surviving process state would be a
  // regression from something already known.
  if (isSettled(record.state)) return { kind: 'settled' };
  if (record.ptyProcessId === null) return { kind: 'never_dispatched' };

  switch (record.stage) {
    // The marker written before `start` was never reached, so `start` was never called.
    case 'allocated':
      return { kind: 'abandon', cause: null };
    case 'launch_failed': {
      const cause = input.receipt?.launchFailureCause ?? null;
      if (input.receipt?.launchOutcome === 'spawn_failed') {
        return { kind: 'confirmed_failure', cause, ptyProcessId: record.ptyProcessId };
      }
      // `preparation_failed`, and also an unreadable receipt: preparation failure is the only
      // outcome that can be recorded here without a spawn, and treating an unreadable one as a
      // confirmed failure would fabricate an agent invocation that may never have happened.
      return { kind: 'abandon', cause };
    }
    // Exactly one write wide, and genuinely indeterminate: `start` may have been interrupted, may
    // have spawned, or may have failed, and the crash landed before its outcome was recorded.
    // Backend liveness cannot narrow it — "missing" cannot separate never-spawned from
    // spawned-and-exited, which is precisely the question.
    case 'starting':
      return {
        kind: 'uncertain',
        detail: 'headless_launch_outcome_unrecorded',
      };
    case 'started':
      return record.captureOwner === input.incarnationId
        ? { kind: 'owned', ptyProcessId: record.ptyProcessId }
        : {
            kind: 'interrupted',
            ptyProcessId: record.ptyProcessId,
            lostOwner: record.captureOwner ?? 'unknown',
          };
    default:
      // A process id with no launch stage at all. Nothing said this crossed a boundary, and nothing
      // said it did not; inventing either answer is worse than blocking one operation.
      return { kind: 'uncertain', detail: 'headless_launch_stage_missing' };
  }
}

/**
 * What the durable record says about a prompt that may or may not have reached a PTY.
 *
 * `submitted`/`seed_submitted` mean the write returned — not that the harness acknowledged it, and
 * not that a turn started. The turn is separate evidence, resolved from the harness ledger against
 * the persisted watermark.
 */
export type SubmissionEvidence =
  | { readonly kind: 'settled' }
  | { readonly kind: 'never_submitted' }
  /** In the one-write-wide window: reconcile from the ledger, and never resend. */
  | { readonly kind: 'reconcile_from_ledger' }
  | { readonly kind: 'submitted' };

export function classifySubmissionEvidence(record: WorkflowOperationRecord): SubmissionEvidence {
  if (isSettled(record.state)) return { kind: 'settled' };
  switch (record.stage) {
    case 'submitting':
    case 'seed_submitting':
      return { kind: 'reconcile_from_ledger' };
    case 'submitted':
    case 'seed_submitted':
      return { kind: 'submitted' };
    // `session_created` means the resources exist and no PTY write has happened yet, so resuming is
    // safe; no stage at all means the same for a call that never got that far.
    default:
      return { kind: 'never_submitted' };
  }
}
