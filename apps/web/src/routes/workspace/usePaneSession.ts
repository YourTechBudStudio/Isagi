import { useQueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { PtyWebSocketOutputMessage } from '@isagi/contracts';

import { ptySocketErrorCopy } from '../../copy/index.js';
import { runRuntimeEffect } from '../../lib/runtime/run.js';
import {
  initialPaneConnectionState,
  paneConnectionEventForMessage,
  paneConnectionReducer,
  paneConnectionSnapshot,
} from '../../lib/workspace/pane-session/connection.js';
import {
  NO_EXIT,
  paneNotice,
  paneStatusLabel,
  paneViewAttention,
  type ExitInfo,
} from '../../lib/workspace/pane-session/presentation.js';
import {
  createPaneTransport,
  type PaneTransport,
  type PaneTransportController,
} from '../../lib/workspace/pane-session/transport.js';
import {
  claimInputForSession,
  derivePaneView,
  startFreshInputForSession,
  type PaneView,
  type PtyPaneSession,
} from '../../lib/workspace/pane-session/view.js';
import { surfaceDetailQueryKey, workspaceQueryKey } from '../../lib/workspace/query-keys.js';
import {
  claimPaneSession,
  createPaneSession,
  formatRuntimeError,
  resolveAgentSessionPtyWebSocketUrl,
  resolveTerminalSessionPtyWebSocketUrl,
} from '../../lib/workspace/runtime-data.js';
import type { AttentionState } from '../../lib/workspace/types.js';

export interface UsePaneSessionInput {
  readonly session: PtyPaneSession | null;
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId: number;
  readonly paneAttention: AttentionState;
  readonly autoAttach?: boolean;
}

export interface UsePaneSessionResult {
  readonly view: PaneView;
  readonly attention: AttentionState;
  readonly statusLabel: string;
  readonly notice: string | null;
  readonly errored: boolean;
  readonly dimmed: boolean;
  readonly transport: PaneTransport;
  /** Remounts the terminal per attach so each attach starts from a clean buffer. */
  readonly terminalKey: string;
  readonly onRendererWarning: (message: string | null) => void;
  /** Resume / retry / reclaim — claim the current session and reopen the socket. */
  readonly attach: () => void;
  /** Replace the bound session with a fresh one (the only valid move when claim+attach would fail). */
  readonly startFresh: () => void;
  readonly startFreshPending: boolean;
  /** The last "start fresh" failure, shown on the recovery prompt. Cleared on retry. */
  readonly startFreshError: string | null;
}

/**
 * Owns a pane's PTY attachment: the claim, the websocket, and the connection
 * state machine — decoupled from rendering. The backend session projection
 * (`recoveryAction`, `status`, `diagnosticCode`) remains the single source of
 * truth for recovery; this hook only drives whether and how we are connected.
 */
export function usePaneSession({
  session,
  worktreeId,
  surfaceId,
  paneId,
  paneAttention,
  autoAttach = false,
}: UsePaneSessionInput): UsePaneSessionResult {
  const queryClient = useQueryClient();
  const transportRef = useRef<PaneTransportController | null>(null);
  const autoAttachSessionKeyRef = useRef<string | null>(null);
  if (transportRef.current === null) {
    transportRef.current = createPaneTransport();
  }
  const transport = transportRef.current;

  const [connection, dispatch] = useReducer(paneConnectionReducer, initialPaneConnectionState);
  const [exit, setExit] = useState<ExitInfo>(NO_EXIT);
  const [rendererWarning, setRendererWarning] = useState<string | null>(null);
  const [userAttach, setUserAttach] = useState(false);
  const [attachEpoch, setAttachEpoch] = useState(0);
  const [creating, setCreating] = useState(false);
  const [startFreshError, setStartFreshError] = useState<string | null>(null);

  const sessionId = session?.id ?? null;
  const sessionKind = session?.kind ?? null;
  const running =
    session !== null && (session.status === 'starting' || session.status === 'running');
  const shouldConnect = session !== null && (running || userAttach);

  // Reset connection-local state whenever the bound session identity changes.
  // Backend status / recovery updates flow through `derivePaneView` and must not
  // tear down a live connection, so they are deliberately not dependencies.
  useEffect(() => {
    dispatch({ type: 'reset' });
    setExit(NO_EXIT);
    setRendererWarning(null);
    setUserAttach(false);
    setAttachEpoch(0);
    autoAttachSessionKeyRef.current = null;
    setStartFreshError(null);
    // A successful "start fresh" intentionally leaves `creating` set until the new
    // session swaps in (so the button stays disabled across the refetch); clearing
    // it here — once that new session is bound — is what re-enables the button.
    setCreating(false);
  }, [sessionId, sessionKind]);

  // A failed or dropped attach releases the resume/reclaim request, so a stopped
  // session falls back to its backend-derived recovery prompt instead of holding
  // a dead terminal open. Running sessions stay connectable via `running`.
  //
  // Recovery normally arrives when the runtime-events push invalidates
  // surfaceDetail and flips the backend status; we also refetch here so the pane
  // does not depend on that push alone if its socket is mid-reconnect.
  useEffect(() => {
    if (connection.phase === 'errored' || connection.phase === 'disconnected') {
      setUserAttach(false);
      void queryClient.invalidateQueries({ queryKey: surfaceDetailQueryKey(surfaceId) });
    }
  }, [connection.phase, queryClient, surfaceId]);

  // The one place the websocket is owned. Re-runs on session identity change, on
  // an explicit (re)attach, or when the session starts/stops being connectable.
  useEffect(() => {
    if (session === null || !shouldConnect) {
      return;
    }
    let disposed = false;

    dispatch({ type: 'attach_started' });
    transport.beginAttach(session.status);

    void runRuntimeEffect(resolveSessionPtyWebSocketUrl(worktreeId, paneId, session)).then(
      (url) => {
        if (disposed) {
          return;
        }
        dispatch({ type: 'socket_connecting' });
        const socket = new WebSocket(url);
        transport.bindSocket(socket);

        socket.addEventListener('open', () => {
          dispatch({ type: 'socket_open' });
          transport.handleOpen();
        });
        socket.addEventListener('message', (event) => {
          const message = decodeSocketMessage(event.data);
          if (!message) {
            dispatch({ type: 'errored', notice: { kind: 'protocol', code: 'invalid_message' } });
            return;
          }
          switch (message.type) {
            case 'output':
              transport.pushOutput(message.data);
              return;
            case 'session':
              transport.setStatus(message.status);
              setExit({ exitCode: message.exitCode ?? null, signal: message.signal ?? null });
              return;
            case 'exit':
              transport.setStatus(
                message.exitCode === 0 && message.signal === null ? 'exited' : 'failed',
              );
              setExit({ exitCode: message.exitCode, signal: message.signal });
              return;
            default: {
              const phaseEvent = paneConnectionEventForMessage(message);
              if (phaseEvent) {
                dispatch(phaseEvent);
                if (phaseEvent.type === 'errored') {
                  transport.closeSocket();
                }
              }
            }
          }
        });
        socket.addEventListener('close', () => {
          if (!disposed) {
            dispatch({ type: 'socket_closed' });
          }
        });
        socket.addEventListener('error', () => {
          // `socket_unavailable` is a local pseudo-code with no protocol code, so
          // resolve its copy here; the message persists across the trailing close.
          dispatch({
            type: 'errored',
            notice: {
              kind: 'transport',
              message: ptySocketErrorCopy.byReason('socket_unavailable'),
            },
          });
        });
      },
      (error: unknown) => {
        if (disposed) {
          return;
        }
        const detail = formatRuntimeError(error);
        dispatch({ type: 'errored', notice: { kind: 'transport', message: detail } });
        transport.pushOutput(ptySocketErrorCopy.connectFailed(detail));
      },
    );

    return () => {
      disposed = true;
      transport.closeSocket();
    };
    // `shouldConnect` / `attachEpoch` capture connectability and explicit
    // re-attach triggers; the live session object is read fresh inside.
  }, [sessionId, sessionKind, shouldConnect, attachEpoch, worktreeId, paneId, transport]);

  const attach = useCallback(() => {
    setUserAttach(true);
    setAttachEpoch((epoch) => epoch + 1);
  }, []);

  useEffect(() => {
    if (!autoAttach || !isAutoAttachableSession(session)) {
      return;
    }

    const sessionKey = `${session.kind}:${session.id}`;
    if (autoAttachSessionKeyRef.current === sessionKey) {
      return;
    }

    autoAttachSessionKeyRef.current = sessionKey;
    attach();
  }, [autoAttach, session, attach]);

  const startFresh = useCallback(() => {
    if (session === null || creating) {
      return;
    }
    setCreating(true);
    setStartFreshError(null);
    void runRuntimeEffect(
      createPaneSession(worktreeId, startFreshInputForSession(paneId, session)),
    ).then(
      async () => {
        // The new session arrives via the surfaceDetail refetch, which swaps the
        // bound session id and resets this hook through the identity effect. We
        // never claim the old (replaced) session.
        await queryClient.invalidateQueries({ queryKey: surfaceDetailQueryKey(surfaceId) });
        await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
      },
      (error: unknown) => {
        // Surface the failure on the recovery prompt itself: "start fresh" is the
        // only valid action on a needs_fresh pane, so a silent re-enable would
        // hide a real failure.
        setStartFreshError(formatRuntimeError(error));
        setCreating(false);
      },
    );
  }, [session, creating, worktreeId, paneId, surfaceId, queryClient]);

  const view = useMemo(
    () => derivePaneView(session, paneConnectionSnapshot(connection)),
    [session, connection],
  );

  const attention = paneViewAttention(view, paneAttention, session);
  const dimmed =
    view.kind === 'attachable' ||
    view.kind === 'needs_fresh' ||
    view.kind === 'moved' ||
    view.kind === 'unsupported';
  const errored = view.kind === 'unsupported' || (view.kind === 'attachable' && view.resumeFailed);
  const statusLabel = paneStatusLabel(view, session, connection.phase, exit);
  const notice = paneNotice(view, session, connection, rendererWarning);

  return {
    view,
    attention,
    statusLabel,
    notice,
    errored,
    dimmed,
    transport,
    terminalKey: `${sessionId ?? 'none'}:${attachEpoch}`,
    onRendererWarning: setRendererWarning,
    attach,
    startFresh,
    startFreshPending: creating,
    startFreshError,
  };
}

function resolveSessionPtyWebSocketUrl(
  worktreeId: number,
  paneId: number,
  session: PtyPaneSession,
): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    const claim = yield* claimPaneSession(worktreeId, claimInputForSession(paneId, session));
    const urlEffect =
      session.kind === 'agent_session'
        ? resolveAgentSessionPtyWebSocketUrl(session.id, claim.attachToken)
        : resolveTerminalSessionPtyWebSocketUrl(session.id, claim.attachToken);

    return yield* urlEffect;
  });
}

function isAutoAttachableSession(session: PtyPaneSession | null): session is PtyPaneSession {
  if (session === null || session.status === 'starting' || session.status === 'running') {
    return false;
  }

  return session.kind === 'terminal_session' || session.recoveryAction !== 'create_replacement';
}

function decodeSocketMessage(data: unknown): PtyWebSocketOutputMessage | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    return JSON.parse(data) as PtyWebSocketOutputMessage;
  } catch {
    return null;
  }
}
