import { Data } from 'effect';

import type { EditorAttemptFailureReason } from '@isagi/contracts';

// The editor domain's entire expected-failure channel, in three classes that
// differ by *when* they happen rather than by what went wrong.
//
// Class C refused the request and attempted nothing. Class B attempted a launch
// that failed before any process row existed to carry the fact. Class A — a
// backend spawn failure, an immediate exit, a workbench that never answers — is
// deliberately absent: those are folded into the PTY row or the readiness
// observation by machinery that already exists, and the pane reads them from the
// projection rather than from an error.
//
// `EditorUnavailable` (capability and provisioning) belongs to
// `editor-provisioning` and is re-exported from this domain's barrel, so API
// mapping has one import rather than two.

/**
 * Class C — the operation was refused at the request boundary and nothing was
 * attempted. Presented wherever the request came from: the palette for
 * `Open editor`, the pane for an ensure, and the pane's disclosure for a
 * superseded diagnostics read.
 */
export class EditorError extends Data.TaggedError('EditorError')<{
  readonly code:
    | 'worktree_not_found'
    | 'editor_context_not_found'
    // The incarnation a diagnostics read named is no longer the context's
    // current one. Refusing is the honest answer; answering from the current
    // pointer would misattribute output to the wrong incarnation.
    | 'editor_incarnation_superseded';
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly editorContextId?: number | undefined;
  readonly ptyProcessId?: number | undefined;
}> {}

/**
 * Class B — the attempt ran and failed before any PTY row could carry it.
 *
 * It is always persisted on the context first and then raised, so the pane's
 * retained diagnostic and the caller's error are the same fact reported twice,
 * to two different audiences. Nothing constructs this without having committed
 * the matching `attempt: failed` row.
 */
export class EditorLaunchFailed extends Data.TaggedError('EditorLaunchFailed')<{
  readonly editorContextId: number;
  readonly reason: EditorAttemptFailureReason;
  readonly detail: string | null;
}> {}

/**
 * The log is there and could not be read.
 *
 * Distinct from the successful empty answer, which means nothing is retained:
 * only this one is worth a retry. Its `detail` is `describeOperationalCause`
 * output over the PTY layer's own `PtyServiceError('log_read_failed')`, so the
 * cause survives to a support channel without leaking the error type across the
 * API boundary.
 */
export class EditorDiagnosticsUnavailable extends Data.TaggedError('EditorDiagnosticsUnavailable')<{
  readonly editorContextId: number;
  readonly detail: string;
}> {}
