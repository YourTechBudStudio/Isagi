import { RuntimeApiError } from '@isagi/runtime-client';

import type { TerminalAttachmentSnapshot } from './controller.js';

type BoundPresentation = Pick<
  TerminalAttachmentSnapshot,
  'phase' | 'sealReason' | 'processIncarnation'
>;

/** One pane's attach intent, keyed so that any change asks the decision again. */
export interface TerminalAttachmentRequest {
  /** Identity, projected incarnation and attachment epoch. */
  readonly requestKey: string;
  readonly identityKey: string;
  readonly attachmentRequest: number;
  /** The live process incarnation the runtime projects for the session, or `null` for none. */
  readonly processIncarnation: string | null;
}

/** What the pane decided for its last request. */
export interface DecidedTerminalAttachment {
  readonly requestKey: string;
  readonly identityKey: string;
  readonly attachmentRequest: number;
  /** This request already attached afresh because a presentation outlived its incarnation. */
  readonly replacedOutlived: boolean;
}

export type TerminalAttachmentDecision<Resource> =
  /** Nothing to do: the request was already decided and nothing it depends on has changed. */
  | { readonly type: 'keep' }
  /** Show the presentation the cache already holds. */
  | { readonly type: 'reuse'; readonly resource: Resource }
  /** Begin a new attachment epoch: a fresh claim, socket and terminal. */
  | {
      readonly type: 'attach';
      readonly replacesOutlived: boolean;
      /**
       * Set when nobody asked for this attach: the presentation outlived its process and the pane
       * follows the projected one. The claim must name it so the runtime joins that live process
       * or refuses, and never launches one on a projection that is already stale.
       */
      readonly expectedIncarnation: string | null;
    };

/**
 * Whether a pane that wants a connection reuses the presentation the cache holds for its session
 * or attaches afresh.
 *
 * The first decision for a request reuses a cached presentation unless the epoch was bumped (an
 * explicit Reconnect, Resume or auto-attach) or the presentation outlived its process. A request
 * already decided is reconsidered once, when the mounted presentation outlives its process after
 * the fact: its stream ended only after the projection had named the new incarnation. That second
 * look happens at most once per request, so a projection that stays stale cannot drive one claim
 * after another, each of which might launch a process.
 *
 * `readCached` reads the cache (a visibility acquisition), so it is called only when the answer
 * depends on it; `mountedOutlived` is the cheap render-time hint that says it might.
 */
export function decideTerminalAttachment<
  Resource extends { getSnapshot(): BoundPresentation },
>(input: {
  readonly previous: DecidedTerminalAttachment | null;
  readonly request: TerminalAttachmentRequest;
  readonly mountedOutlived: boolean;
  readonly readCached: () => Resource | null;
}): TerminalAttachmentDecision<Resource> {
  const { previous, request } = input;
  if (previous?.requestKey === request.requestKey) {
    if (previous.replacedOutlived || !input.mountedOutlived) return { type: 'keep' };
    const cached = input.readCached();
    return cached !== null &&
      presentationOutlivedIncarnation(cached.getSnapshot(), request.processIncarnation)
      ? {
          type: 'attach',
          replacesOutlived: true,
          expectedIncarnation: request.processIncarnation,
        }
      : { type: 'keep' };
  }
  // A bumped epoch is someone asking for a fresh claim. A changed incarnation alone is not: it
  // only asks whether the cached presentation still fits.
  const explicit =
    request.attachmentRequest !== 0 &&
    !(
      previous?.identityKey === request.identityKey &&
      previous.attachmentRequest === request.attachmentRequest
    );
  const cached = input.readCached();
  const outlived =
    cached !== null &&
    presentationOutlivedIncarnation(cached.getSnapshot(), request.processIncarnation);
  if (cached !== null && !explicit && !outlived) return { type: 'reuse', resource: cached };
  return {
    type: 'attach',
    replacesOutlived: outlived,
    expectedIncarnation: outlived && !explicit ? request.processIncarnation : null,
  };
}

/**
 * Whether a cached presentation has outlived the process it streamed (ADR 0006: a presentation is
 * valid for exactly one process incarnation, the one its socket named). All of these must hold:
 *
 *  - Its stream has ended. While the socket is open it is the authority on which process it
 *    shows: an attach that launched a process is bound to it before the projection catches up,
 *    and a projection naming another incarnation is either stale or about to be confirmed by this
 *    stream's own exit or close.
 *  - A takeover did not end it. `moved` and `superseded` mean another attachment holds the
 *    session; re-attaching on our own would take it back, and the two would trade it forever.
 *  - It is bound, and the runtime projects a different live incarnation. An unbound presentation
 *    never streamed a process; with no live incarnation there is nothing to attach to; and the
 *    same incarnation (a stale `running` projection of a process that exited) would have the
 *    claim relaunch it without anyone asking.
 */
export function presentationOutlivedIncarnation(
  presentation: BoundPresentation,
  projectedIncarnation: string | null,
): boolean {
  if (presentation.phase !== 'sealed') return false;
  if (presentation.sealReason === 'moved' || presentation.sealReason === 'superseded') return false;
  return (
    presentation.processIncarnation !== null &&
    projectedIncarnation !== null &&
    presentation.processIncarnation !== projectedIncarnation
  );
}

/** The runtime's deliberate refusals of an automatic rejoin claim (ADR 0006). */
export type RejoinRefusal = 'process_incarnation_stale' | 'session_already_attached';

/**
 * Which deliberate refusal a failed rejoin claim is, or `null` for a real failure. A refusal is the
 * runtime declining, correctly, to rejoin: the projection was stale, or another attachment holds
 * the process. Anything else (transport, database, an unexpected rejection) is a failure the pane
 * has to report.
 */
export function rejoinRefusal(error: unknown): RejoinRefusal | null {
  if (!(error instanceof RuntimeApiError) || error.apiError.code !== 'surface_rejected')
    return null;
  const reason = error.apiError.data.reason;
  return reason === 'process_incarnation_stale' || reason === 'session_already_attached'
    ? reason
    : null;
}
