import type { PtyWebSocketErrorCode, PtyWebSocketOutputMessage } from '@isagi/contracts';

import type { PaneConnectionSnapshot } from './view.js';

/**
 * A user-facing notice about the live PTY connection. `code` is preferred — it
 * keys into `ptySocketErrorCopy` at render time so copy never leaks into the
 * reducer — and `message` carries a pre-formatted fallback for transport
 * failures that have no protocol code (e.g. a claim/url resolution error).
 */
export type SocketNotice = {
  readonly kind: 'protocol' | 'transport';
  readonly code?: PtyWebSocketErrorCode | undefined;
  readonly message?: string | undefined;
};

/**
 * The lifecycle of a single PTY attachment, owned by `usePaneSession`. This is
 * deliberately separate from the backend session status: the session can be
 * "running" while this machine is still `claiming`, and it can be `attached`
 * while the backend reports the process has since exited.
 */
export type PaneConnectionPhase =
  | 'idle'
  | 'claiming'
  | 'attaching'
  | 'replaying'
  | 'attached'
  | 'disconnected'
  | 'errored';

export type PaneConnectionState = {
  readonly phase: PaneConnectionPhase;
  readonly notice: SocketNotice | null;
};

export const initialPaneConnectionState: PaneConnectionState = {
  phase: 'idle',
  notice: null,
};

export type PaneConnectionEvent =
  /** The bound session changed identity, or we tore the attachment down. */
  | { readonly type: 'reset' }
  /** An attach was initiated: the claim request is in flight. */
  | { readonly type: 'attach_started' }
  /** The claim resolved; the websocket is opening. */
  | { readonly type: 'socket_connecting' }
  /** The websocket opened. */
  | { readonly type: 'socket_open' }
  /** The runtime is replaying buffered output. */
  | { readonly type: 'replay_start' }
  /** Replay finished; the stream is now live. */
  | { readonly type: 'replay_end' }
  /** The attached process exited while this socket was live. */
  | { readonly type: 'session_stopped' }
  /** The websocket closed without an error we surfaced. */
  | { readonly type: 'socket_closed' }
  /** A claim, transport, or protocol failure. */
  | { readonly type: 'errored'; readonly notice: SocketNotice };

// Phase transitions assume the runtime's documented message order: the socket
// opens before any `replay_start`, and `replay_start` is paired with a later
// `replay_end`.
export function paneConnectionReducer(
  state: PaneConnectionState,
  event: PaneConnectionEvent,
): PaneConnectionState {
  switch (event.type) {
    case 'reset':
      return initialPaneConnectionState;
    case 'attach_started':
      return { phase: 'claiming', notice: null };
    case 'socket_connecting':
      return { phase: 'attaching', notice: null };
    case 'socket_open':
      return { phase: 'attached', notice: null };
    case 'replay_start':
      return { phase: 'replaying', notice: state.notice };
    case 'replay_end':
      return { phase: 'attached', notice: state.notice };
    case 'session_stopped':
      return { phase: 'disconnected', notice: state.notice };
    case 'socket_closed':
      // Preserve any error notice that arrived just before the close so the pane
      // keeps explaining why the connection dropped (e.g. a moved attachment).
      return { phase: 'disconnected', notice: state.notice };
    case 'errored':
      return { phase: 'errored', notice: event.notice };
  }
}

/**
 * Project the connection lifecycle down to the two facts `derivePaneView` needs:
 * the connection-owned error code (which can override the view) and whether an
 * attach is currently in flight or live (which keeps a stopped-but-recoverable
 * session showing the terminal instead of its recovery prompt).
 */
export function paneConnectionSnapshot(state: PaneConnectionState): PaneConnectionSnapshot {
  const active =
    state.phase === 'claiming' ||
    state.phase === 'attaching' ||
    state.phase === 'replaying' ||
    state.phase === 'attached';
  return { code: state.notice?.code ?? null, attachRequested: active };
}

/**
 * Map an incoming PTY socket message to a connection event, when one applies.
 * `output` and `session` carry terminal data / status rather than connection
 * phase transitions, so they return `null` and are handled by the attachment
 * owner directly. `exit` is both data and lifecycle: the local attachment is no
 * longer active, even before the surface detail refetch returns the stopped
 * backend projection.
 */
export function paneConnectionEventForMessage(
  message: PtyWebSocketOutputMessage,
): PaneConnectionEvent | null {
  switch (message.type) {
    case 'replay_start':
      return { type: 'replay_start' };
    case 'replay_end':
      return { type: 'replay_end' };
    case 'error':
      return { type: 'errored', notice: { kind: 'protocol', code: message.code } };
    case 'exit':
      return { type: 'session_stopped' };
    case 'output':
    case 'session':
      return null;
  }
}
