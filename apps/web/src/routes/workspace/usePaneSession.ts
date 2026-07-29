import { useQueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ControlPlaneSnapshot, HarnessLaunchProjection } from '@isagi/contracts';

import { ptyCopy } from '../../copy/index.js';
import { harnessLaunch } from '../../lib/control-plane/launchability.js';
import { controlPlaneQueryKey, useControlPlaneQuery } from '../../lib/control-plane/queries.js';
import { runRuntimeEffect } from '../../lib/runtime/run.js';
import {
  paneNotice,
  paneStatusLabel,
  paneViewAttention,
  type ExitInfo,
} from '../../lib/workspace/pane-session/presentation.js';
import {
  claimInputForSession,
  derivePaneAttachmentIntent,
  derivePaneView,
  isLaunchBlockCode,
  isPtyWebSocketErrorCode,
  recoveryRequiresProcessCreation,
  startFreshInputForSession,
  type PaneConnectionSnapshot,
  type PaneView,
  type PtyPaneSession,
} from '../../lib/workspace/pane-session/view.js';
import {
  ptyStreamConnectionActive,
  type PtyStreamConnectionState,
} from '../../lib/workspace/pty-stream/index.js';
import { surfaceDetailQueryKey, workspaceQueryKey } from '../../lib/workspace/query-keys.js';
import {
  claimPaneSession,
  createPaneSession,
  formatRuntimeError,
  refreshInventory,
  resolveAgentSessionPtyWebSocketUrl,
  resolveTerminalSessionPtyWebSocketUrl,
} from '../../lib/workspace/runtime-data.js';
import { useTerminalAttachmentResource } from '../../lib/workspace/terminal-presentation/context.js';
import type { TerminalPresentationController } from '../../lib/workspace/terminal-presentation/controller.js';
import type { TerminalPresentationFailure } from '../../lib/workspace/terminal-presentation/start-presentation.js';
import type { AttentionState } from '../../lib/workspace/types.js';
import { sendAgentComposerNewline } from './agentComposerKeys.js';

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
  readonly presentation: TerminalPresentationController | null;
  readonly sealed: boolean;
  /**
   * The terminal itself failed to build for a session that is otherwise fine.
   * The pane shows web-owned copy plus this diagnostic detail and offers
   * `attach` as the retry; it must never render as an empty pane.
   */
  readonly presentationFailure: TerminalPresentationFailure | null;
  /**
   * The terminal was built, but its cold reconstruction never completed — the
   * stream ended mid-replay, or the held-live buffer overflowed. It stays
   * concealed: the pane shows web-owned copy plus this diagnostic detail rather
   * than the fraction of a session that happened to parse.
   */
  readonly restoreFailure: TerminalPresentationFailure | null;
  /** Resume / retry / reclaim — claim the current session and reopen the socket. */
  readonly attach: () => void;
  /** Replace the bound session with a fresh one (the only valid move when claim+attach would fail). */
  readonly startFresh: () => void;
  readonly startFreshPending: boolean;
  /** The last "start fresh" failure, shown on the recovery prompt. Cleared on retry. */
  readonly startFreshError: string | null;
  /** Refresh host facts and re-evaluate an unavailable pane; attaches if now launchable. */
  readonly checkAgain: () => void;
  readonly checking: boolean;
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
  const controlPlane = useControlPlaneQuery();
  const autoAttachSessionKeyRef = useRef<string | null>(null);

  const [userAttach, setUserAttach] = useState(false);
  const [attachEpoch, setAttachEpoch] = useState(0);
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [startFreshError, setStartFreshError] = useState<string | null>(null);

  // The runtime's launch projection for this pane's harness, authoritative over any
  // stale socket/claim failure. Terminals are always launchable.
  const launch: HarnessLaunchProjection = useMemo(
    () =>
      session?.kind === 'agent_session' && controlPlane.data
        ? harnessLaunch(controlPlane.data, session.harness)
        : { status: 'launchable' },
    [session, controlPlane.data],
  );

  const sessionId = session?.id ?? null;
  const sessionKind = session?.kind ?? null;
  const running =
    session !== null && (session.status === 'starting' || session.status === 'running');
  const intent = derivePaneAttachmentIntent(session, running || userAttach);
  const initialInteractive = session?.status === 'running';

  const resolveUrl = useCallback(() => {
    if (session === null) {
      return Effect.fail(new Error('No pane session is bound.'));
    }
    return resolveSessionPtyWebSocketUrl(worktreeId, paneId, session);
  }, [paneId, session, worktreeId]);

  const handleCustomKey = useCallback(
    (event: KeyboardEvent, sendInput: (data: string) => void) =>
      session?.kind === 'agent_session' && sendAgentComposerNewline(event, sendInput),
    [session?.kind],
  );
  const attachment = useTerminalAttachmentResource({
    identity: session ? { kind: session.kind, sessionId: session.id } : null,
    placement: { worktreeId, surfaceId, paneId },
    connect: intent.connect,
    mounted: intent.mounted,
    attachmentRequest: attachEpoch,
    initiallyInteractive: initialInteractive,
    resolveUrl,
    onCustomKey: handleCustomKey,
  });
  const connection: PtyStreamConnectionState = {
    phase:
      attachment.snapshot.phase === 'sealed'
        ? attachment.snapshot.sealReason === 'errored'
          ? 'errored'
          : 'disconnected'
        : attachment.snapshot.phase,
    notice: attachment.snapshot.notice,
  };
  const exit: ExitInfo = attachment.snapshot.exit;
  const rendererWarning = attachment.snapshot.rendererWarning;
  const sealed = attachment.snapshot.phase === 'sealed';

  // Reset connection-local state whenever the bound session identity changes.
  // Backend status / recovery updates flow through `derivePaneView` and must not
  // tear down a live connection, so they are deliberately not dependencies.
  useEffect(() => {
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
      // A launch-block code over the socket means the same thing as at claim time:
      // reproject the pane from a fresh control-plane snapshot.
      if (isLaunchBlockCode(connection.notice?.code)) {
        void queryClient.invalidateQueries({ queryKey: controlPlaneQueryKey });
      }
    }
  }, [connection.phase, connection.notice?.code, queryClient, surfaceId]);

  const attach = useCallback(() => {
    setUserAttach(true);
    setAttachEpoch((epoch) => epoch + 1);
  }, []);

  useEffect(() => {
    if (!autoAttach || !isAutoAttachableSession(session, launch)) {
      return;
    }

    const sessionKey = `${session.kind}:${session.id}`;
    if (autoAttachSessionKeyRef.current === sessionKey) {
      return;
    }

    autoAttachSessionKeyRef.current = sessionKey;
    attach();
  }, [autoAttach, session, launch, attach]);

  // "Check again" for an unavailable pane: refresh authoritative host facts first,
  // reproject from the fresh snapshot, and only then retry attachment if the
  // harness is now launchable. Repeating the claim against stale facts would just
  // fail the same way.
  const checkAgain = useCallback(async () => {
    setChecking(true);
    try {
      await runRuntimeEffect(refreshInventory());
      await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKey });
      const fresh = queryClient.getQueryData<ControlPlaneSnapshot>(controlPlaneQueryKey);
      if (
        fresh &&
        session?.kind === 'agent_session' &&
        harnessLaunch(fresh, session.harness).status === 'launchable'
      ) {
        attach();
      }
    } finally {
      setChecking(false);
    }
  }, [queryClient, session, attach]);

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
    () => derivePaneView(session, paneConnectionSnapshot(connection), launch),
    [session, connection, launch],
  );

  // A terminal that failed to build, and a terminal whose cold restore never
  // completed, are both presentation-level facts the runtime's projection cannot
  // see — so, like `unsupported` and `moved`, the pane overlays them on top of
  // the derived view rather than pretending to attach. They stay separate
  // because they say different true things: one never got a terminal, the other
  // has one holding part of a session it refuses to show.
  const presentationFailure = attachment.failure;
  const restoreFailure =
    attachment.snapshot.readiness.phase === 'failed'
      ? { detail: attachment.snapshot.readiness.detail }
      : null;
  const buildOrRestoreFailed = presentationFailure !== null || restoreFailure !== null;
  const attention = buildOrRestoreFailed
    ? 'error'
    : paneViewAttention(view, paneAttention, session);
  const dimmed =
    !sealed &&
    (view.kind === 'attachable' ||
      view.kind === 'needs_fresh' ||
      view.kind === 'moved' ||
      view.kind === 'unsupported' ||
      view.kind === 'blocked' ||
      view.kind === 'unavailable');
  const errored =
    buildOrRestoreFailed ||
    view.kind === 'unsupported' ||
    view.kind === 'blocked' ||
    (view.kind === 'attachable' && view.resumeFailed);
  const statusLabel = presentationFailure
    ? ptyCopy.presentationFailed.status
    : restoreFailure
      ? ptyCopy.restoreIncomplete.status
      : sealed
        ? attachment.snapshot.sealReason === 'exited'
          ? 'Exited'
          : 'Disconnected'
        : paneStatusLabel(view, session, connection.phase, exit);
  const notice =
    sealed && !restoreFailure
      ? ptyCopy.sealed[attachment.snapshot.sealReason ?? 'disconnected']
      : paneNotice(view, session, connection, rendererWarning);

  return {
    view,
    attention,
    statusLabel,
    notice,
    errored,
    dimmed,
    presentation: attachment.resource,
    sealed,
    presentationFailure,
    restoreFailure,
    attach,
    startFresh,
    startFreshPending: creating,
    startFreshError,
    checkAgain,
    checking,
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

function isAutoAttachableSession(
  session: PtyPaneSession | null,
  launch: HarnessLaunchProjection,
): session is PtyPaneSession {
  if (session === null || session.status === 'starting' || session.status === 'running') {
    return false;
  }
  if (session.kind === 'terminal_session') {
    return true;
  }
  if (session.recoveryAction === 'create_replacement') {
    return false;
  }
  // Do not auto-attach into a launch the runtime would block: the recovery would
  // create a process and fail. `connect_existing` is pure attach and stays allowed.
  return !(recoveryRequiresProcessCreation(session.recoveryAction) && launch.status === 'blocked');
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
