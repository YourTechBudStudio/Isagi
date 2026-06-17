import type {
  AgentSessionMetadata,
  PaneSessionClaimInput,
  PaneSessionCreateInput,
  PtyWebSocketErrorCode,
  SurfacePane,
  TerminalSessionMetadata,
} from '@isagi/contracts';

/**
 * The session bound to a pane, flattened so the discriminant and the metadata
 * sit at the same level. This is the only session shape the pane UI reasons
 * about.
 */
export type PtyPaneSession =
  | ({ readonly kind: 'agent_session' } & AgentSessionMetadata)
  | ({ readonly kind: 'terminal_session' } & TerminalSessionMetadata);

/**
 * The two facts about the live PTY connection that the *view* depends on.
 * Everything else a pane shows (status, recovery, diagnostics) is read straight
 * from the backend session projection, never reconstructed here.
 */
export type PaneConnectionSnapshot = {
  /**
   * The socket-level error code, when an attach surfaced one. Only the two
   * connection-owned conditions — `unsupported_harness` and
   * `session_attachment_moved` — change the view; every other code is a
   * transient notice on a still-live pane.
   */
  readonly code: PtyWebSocketErrorCode | null;
  /**
   * Whether the user has asked to (re)attach a stopped-but-recoverable agent
   * session. Running sessions attach automatically and never need this; it is
   * the "Resume" / "Reclaim" affordance made explicit.
   */
  readonly attachRequested: boolean;
};

/**
 * What a pane should render. A pure projection of the backend session state and
 * the connection snapshot — the single place pane presentation precedence lives.
 */
export type PaneView =
  | { readonly kind: 'empty' }
  /** Mount the terminal: the session is running, or we are attaching/resuming. */
  | { readonly kind: 'live' }
  /** Stopped agent session that claim+attach can recover (connect or resume). */
  | { readonly kind: 'attachable'; readonly resumeFailed: boolean }
  /** Stopped agent session that can only be replaced — claim+attach would fail. */
  | { readonly kind: 'needs_fresh' }
  /** The attachment was taken over by another pane. */
  | { readonly kind: 'moved' }
  /** The harness has no runtime adapter wired yet. */
  | { readonly kind: 'unsupported' };

export function ptyPaneSession(session: SurfacePane['session']): PtyPaneSession | null {
  if (!session) {
    return null;
  }
  if (session.kind === 'agent_session') {
    return { kind: 'agent_session', ...session.agentSession };
  }
  return { kind: 'terminal_session', ...session.terminalSession };
}

/**
 * Decide what a pane renders. The backend's `recoveryAction` is the single
 * source of truth for whether a stopped agent session can be recovered:
 *
 *  - `connect_existing` / `resume_existing` → claim+attach succeeds → attachable
 *  - `create_replacement` → claim+attach is guaranteed to fail → needs_fresh
 *
 * Terminals have no durable harness session; reattaching relaunches a fresh
 * shell in place, so a stopped terminal stays a live pane (it reattaches on
 * mount) rather than ever showing a recovery prompt.
 */
export function derivePaneView(
  session: PtyPaneSession | null,
  connection: PaneConnectionSnapshot,
): PaneView {
  if (!session) {
    return { kind: 'empty' };
  }
  if (connection.code === 'unsupported_harness') {
    return { kind: 'unsupported' };
  }
  if (connection.code === 'session_attachment_moved') {
    return { kind: 'moved' };
  }

  const running = session.status === 'starting' || session.status === 'running';
  if (running) {
    return { kind: 'live' };
  }

  if (session.kind === 'terminal_session') {
    return { kind: 'live' };
  }

  if (session.recoveryAction === 'create_replacement') {
    return { kind: 'needs_fresh' };
  }
  if (connection.attachRequested) {
    return { kind: 'live' };
  }
  return {
    kind: 'attachable',
    resumeFailed: session.diagnosticCode === 'harness_resume_failed',
  };
}

export function claimInputForSession(
  paneId: number,
  session: PtyPaneSession,
): PaneSessionClaimInput {
  return session.kind === 'agent_session'
    ? { action: 'claim_agent_session', paneId, agentSessionId: session.id }
    : { action: 'claim_terminal_session', paneId, terminalSessionId: session.id };
}

export function startFreshInputForSession(
  paneId: number,
  session: PtyPaneSession,
): PaneSessionCreateInput {
  return session.kind === 'agent_session'
    ? { kind: 'agent_session', paneId, harness: session.harness }
    : { kind: 'terminal_session', paneId };
}
