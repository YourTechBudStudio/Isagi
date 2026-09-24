/**
 * Why a checkpoint capture was refused.
 *
 * A refusal leaves no checkpoint row: the segment records the reason in the attempt's failure detail
 * and the run parks on the node for Retry. Warnings are a different register — they describe a
 * limitation of a checkpoint that *was* saved — and so are never expressed here.
 */

import { Data } from 'effect';

export type CheckpointCaptureFailureReason =
  /** Raised by the segment: the pinned artifact no longer declares the frame's graph or the node's edge. */
  | 'graph_not_declared'
  | 'edge_not_declared'
  /** The worktree or project row is gone, or the worktree directory itself no longer exists. */
  | 'destination_unavailable'
  /** Git could not be started at all. */
  | 'git_unavailable'
  /** A load-bearing Git read (HEAD, object format, base tree) failed for any other reason. */
  | 'git_inspection_failed'
  | 'scope_path_not_found'
  | 'scope_root_is_symlink'
  | 'scope_kind_mismatch'
  /** A root or exclusion names an existing entry by a case or normalization alias. */
  | 'scope_path_spelling_mismatch'
  /** Two stored paths would name one filesystem entry, or hard-link candidates make that undecidable. */
  | 'path_identity_collision'
  /** The final state would need one path as both a regular file and a directory. */
  | 'path_kind_conflict'
  /** A read failed for a reason other than not-found; never treated as absence. */
  | 'path_inspection_failed'
  | 'unstable_capture'
  | 'head_changed'
  | 'content_publish_failed'
  /** A repeated scope id changed its root or kind. */
  | 'scope_identity_changed';

export class CheckpointCaptureFailure extends Data.TaggedError('CheckpointCaptureFailure')<{
  readonly reason: CheckpointCaptureFailureReason;
  readonly message: string;
  /** Root-relative, in the spelling the failure concerns. */
  readonly path?: string | undefined;
  readonly scopeId?: string | undefined;
  readonly cause?: unknown;
}> {}
