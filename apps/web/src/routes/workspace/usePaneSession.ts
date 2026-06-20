import { useQueryClient } from '@tanstack/react-query';
import { Effect, Schema } from 'effect';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ptyWebSocketOutputMessageSchema, type PtyWebSocketOutputMessage } from '@isagi/contracts';

import { ptySocketErrorCopy } from '../../copy/index.js';
import { runRuntimeEffect } from '../../lib/runtime/run.js';
import {
  NO_EXIT,
  paneNotice,
  paneStatusLabel,
  paneViewAttention,
  type ExitInfo,
} from '../../lib/workspace/pane-session/presentation.js';
import {
  claimInputForSession,
  derivePaneView,
  isPtyWebSocketErrorCode,
  startFreshInputForSession,
  type PaneConnectionSnapshot,
  type PaneView,
  type PtyPaneSession,
} from '../../lib/workspace/pane-session/view.js';
import {
  ptyStreamConnectionActive,
  type PtyStreamConnectionState,
  type PtyStreamTransport,
  type PtyStreamTransportController,
  usePtyStream,
} from '../../lib/workspace/pty-stream/index.js';
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
  readonly transport: PtyStreamTransport;
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
  const autoAttachSessionKeyRef = useRef<string | null>(null);

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
  const resetKey = `${sessionKind ?? 'none'}:${sessionId ?? 'none'}`;
  const connectKey = `${resetKey}:${shouldConnect ? 'on' : 'off'}:${attachEpoch}:${worktreeId}:${paneId}`;
  const initialInteractive = session?.status === 'running';

  const resolveUrl = useCallback(() => {
    if (session === null) {
      return Effect.fail(new Error('No pane session is bound.'));
    }
    return resolveSessionPtyWebSocketUrl(worktreeId, paneId, session);
  }, [paneId, session, worktreeId]);

  const handleDomainMessage = useCallback(
    (message: PtyWebSocketOutputMessage, transport: PtyStreamTransportController) => {
      if (message.type !== 'session') {
        return;
      }
      transport.setInteractive(message.status === 'running');
      setExit({ exitCode: message.exitCode ?? null, signal: message.signal ?? null });
    },
    [],
  );

  const handleExit = useCallback((nextExit: ExitInfo, transport: PtyStreamTransportController) => {
    transport.setInteractive(false);
    setExit(nextExit);
  }, []);

  const handleResolveError = useCallback((error: unknown) => {
    const detail = formatRuntimeError(error);
    return {
      message: detail,
      output: ptySocketErrorCopy.connectFailed(detail),
    };
  }, []);

  const handleSocketError = useCallback(
    () => ({ message: ptySocketErrorCopy.byReason('socket_unavailable') }),
    [],
  );

  const { transport, connection } = usePtyStream({
    enabled: shouldConnect,
    resetKey,
    connectKey,
    initialInteractive,
    resolveUrl,
    decodeMessage: decodeSessionPtyStreamMessage,
    onDomainMessage: handleDomainMessage,
    onExit: handleExit,
    onResolveError: handleResolveError,
    onSocketError: handleSocketError,
  });

  // Reset connection-local state whenever the bound session identity changes.
  // Backend status / recovery updates flow through `derivePaneView` and must not
  // tear down a live connection, so they are deliberately not dependencies.
  useEffect(() => {
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

function paneConnectionSnapshot(connection: PtyStreamConnectionState): PaneConnectionSnapshot {
  return {
    code:
      connection.notice?.code && isPtyWebSocketErrorCode(connection.notice.code)
        ? connection.notice.code
        : null,
    attachRequested: ptyStreamConnectionActive(connection),
  };
}

function decodeSessionPtyStreamMessage(data: unknown): PtyWebSocketOutputMessage | null {
  try {
    return Schema.decodeUnknownSync(ptyWebSocketOutputMessageSchema)(JSON.parse(String(data)));
  } catch {
    return null;
  }
}
