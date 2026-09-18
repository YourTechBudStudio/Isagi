/**
 * Author-selected evidence: the things a workflow deliberately keeps.
 *
 * "Evidence" here is always the bare word and always means *this* — something an author chose to
 * preserve. Engine facts about an operation are `lateEvidence`, never this, and the two must not
 * borrow each other's name.
 *
 * The one authoring rule that matters: `title`, `role`, `labels` and `source` form the recorded
 * identity of the capture call, so they must be derived from graph state and from handles the
 * callback already holds — never from the captured content itself. A title computed from a reread
 * agent response changes when the response changes, and the repaired callback would be refused as a
 * changed request instead of reusing what was already captured. Capturing a genuinely new judgment
 * belongs in a later visit to the node, not in a second call at the same position.
 */

import type { AgentTurnTarget, HeadlessOperationHandle } from './operations.js';

export interface EvidenceCaptureInput {
  /** Human-facing name for the capture. Non-empty after trimming, at most 512 characters. */
  readonly title: string;
  /**
   * Free-form author vocabulary, e.g. `review-feedback`, `plan`, `verification`, `commit`.
   *
   * Indexed for filtering, so it follows the workflow-identifier grammar
   * (`/^[a-z0-9][a-z0-9._-]{0,63}$/`) and needs no escaping as a query value.
   */
  readonly role: string;
  readonly labels?: EvidenceLabels | undefined;
  readonly content: EvidenceContent;
  readonly source?: EvidenceSource | undefined;
}

/**
 * Flat scalars, because this is what a query filter can index and a call fingerprint can
 * canonicalise. At most 32 entries; keys are non-empty, at most 64 characters, and carry no `:`
 * (the list filter splits on it) and no control characters; string values are at most 1024
 * characters and numbers must be finite. Limits are enforced, never silently truncated.
 */
export type EvidenceLabels = Readonly<Record<string, string | number | boolean>>;

export type EvidenceContent =
  /** `mediaType` defaults to `text/plain`. */
  | { readonly kind: 'text'; readonly text: string; readonly mediaType?: string | undefined }
  /** Canonicalised, stored as `application/json`. */
  | { readonly kind: 'json'; readonly value: unknown }
  /** Worktree-relative path. `mediaType` defaults to a guess from the extension. */
  | { readonly kind: 'file'; readonly path: string; readonly mediaType?: string | undefined }
  /** In-memory bytes — a rendered image, an archive. `mediaType` is required. */
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly mediaType: string };

/**
 * What produced the captured content, expressed with a handle the callback already holds.
 *
 * Hand back the target you waited on or the headless handle you launched; the runtime resolves it
 * to the operation it made and records the attribution as exact. It cannot do that for a bare
 * string, because a conversation read has already lost which turn produced it — so an omitted or
 * unresolvable source is recorded honestly rather than guessed at, and never fails the capture.
 */
export type EvidenceSource =
  /** Exact: the spawn or send that produced the turn. */
  | { readonly kind: 'agent_turn'; readonly target: AgentTurnTarget }
  /** Exact: the headless operation that produced the output. */
  | { readonly kind: 'headless_operation'; readonly operation: HeadlessOperationHandle }
  /** Session only; the operation is inferred as the latest one in this run for that session. */
  | { readonly kind: 'agent_session'; readonly agentSessionId: number };

export interface EvidenceHandle {
  /** Opaque public id, `wev_<uuid>`. Retain in graph state only when later work needs it. */
  readonly evidenceId: string;
}
