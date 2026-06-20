import { agentSessionCopy, ptyCopy, ptySocketErrorCopy } from '../../../copy/index.js';
import type {
  PtyStreamConnectionPhase,
  PtyStreamConnectionState,
  PtyStreamNotice,
} from '../pty-stream/index.js';
import type { AttentionState } from '../types.js';
import { isPtyWebSocketErrorCode, type PaneView, type PtyPaneSession } from './view.js';

export type ExitInfo = { readonly exitCode: number | null; readonly signal: string | null };
export const NO_EXIT: ExitInfo = { exitCode: null, signal: null };

/** Attention dot semantics for each non-live pane view; live panes keep the pane's own attention. */
export function paneViewAttention(
  view: PaneView,
  fallback: AttentionState,
  session: PtyPaneSession | null,
): AttentionState {
  switch (view.kind) {
    case 'attachable':
      return view.resumeFailed ? 'error' : 'waiting';
    case 'needs_fresh':
      return 'waiting';
    case 'moved':
      // A moved agent session is waiting to be re-homed (it has continuity worth
      // resuming). A moved terminal carries no resumable work, so it stays idle
      // rather than nagging for attention it doesn't need.
      return session?.kind === 'terminal_session' ? 'idle' : 'waiting';
    case 'unsupported':
      return 'error';
    default:
      return fallback;
  }
}

/** The compact, right-aligned header status for a pane. */
export function paneStatusLabel(
  view: PaneView,
  session: PtyPaneSession | null,
  phase: PtyStreamConnectionPhase,
  exit: ExitInfo,
): string {
  switch (view.kind) {
    case 'empty':
      return ptyCopy.noSession;
    case 'unsupported':
      return ptyCopy.unsupportedHarness.status;
    case 'moved':
      return ptyCopy.movedAttachment.status;
    case 'attachable':
      return view.resumeFailed
        ? agentSessionCopy.status.resume_failed
        : agentSessionCopy.status.resume_available;
    case 'needs_fresh':
      // Sourced from the same place as the start-fresh prompt so the header and
      // the prompt can never drift.
      return agentSessionCopy.status.start_fresh;
    case 'live':
      if (phase === 'connecting' || phase === 'replaying') {
        return ptyCopy.attaching;
      }
      return session
        ? ptyCopy.sessionStatus(session.status, session.statusReason, exit)
        : ptyCopy.noSession;
  }
}

/** The one-line notice bar under the header, when there is something honest to say. */
export function paneNotice(
  view: PaneView,
  session: PtyPaneSession | null,
  connection: PtyStreamConnectionState,
  rendererWarning: string | null,
): string | null {
  switch (view.kind) {
    case 'empty':
    case 'unsupported':
      return null;
    case 'moved':
      return ptySocketErrorCopy.byReason('session_attachment_moved');
    case 'attachable':
    case 'needs_fresh':
      return session ? ptyCopy.sessionNotice(session.status, session.statusReason) : null;
    case 'live': {
      const noticeMessage = resolveSocketNotice(connection.notice);
      const phaseNotice =
        connection.phase === 'disconnected'
          ? ptySocketErrorCopy.byReason('socket_disconnected')
          : connection.phase === 'errored'
            ? ptySocketErrorCopy.byReason('socket_unavailable')
            : null;
      return noticeMessage ?? phaseNotice ?? rendererWarning;
    }
  }
}

function resolveSocketNotice(notice: PtyStreamNotice | null): string | null {
  if (!notice) {
    return null;
  }
  if (notice.code) {
    return ptySocketErrorCopy.byReason(
      isPtyWebSocketErrorCode(notice.code) ? notice.code : 'unknown',
    );
  }
  return notice.message ?? null;
}
