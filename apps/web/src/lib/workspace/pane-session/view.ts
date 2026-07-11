import { Schema } from 'effect';

import {
  ptyWebSocketErrorCodeSchema,
  type AgentSessionMetadata,
  type AgentSessionRecoveryAction,
  type HarnessLaunchBlockReason,
  type HarnessLaunchProjection,
  type PaneSessionClaimInput,
  type PaneSessionCreateInput,
  type PtyWebSocketErrorCode,
  type SurfacePane,
  type TerminalSessionMetadata,
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

// Contract-backed: the code already arrived on a schema-validated message, so the
// authoritative union is the single source of truth. A hand-maintained list here
// silently dropped launch-block codes (`harness_disabled` and friends) before they
// could reach a pane, which is exactly the drift we no longer want.
export const isPtyWebSocketErrorCode: (code: unknown) => code is PtyWebSocketErrorCode = Schema.is(
  ptyWebSocketErrorCodeSchema,
);

const isHarnessLaunchBlockCode = Schema.is(
  Schema.Literal(
    'onboarding_incomplete',
    'config_invalid',
    'inventory_pending',
    'harness_disabled',
    'harness_missing',
    'harness_incompatible',
    'harness_probe_failed',
  ),
);

/**
 * Whether a launch-block code should move a pane out of its stale blocker on the
 * next control-plane snapshot. The runtime projection is authoritative for the
 * view; this only decides whether a socket/claim failure warrants a refetch.
 */
export function isLaunchBlockCode(code: string | null | undefined): boolean {
  return code != null && isHarnessLaunchBlockCode(code);
}

/**
 * What a pane should render. A pure projection of the backend session state and
 * the connection snapshot — the single place pane presentation precedence lives.
 */
export type PaneView =
  | { readonly kind: 'empty' }
  /** Mount the terminal: the session is running, or we are attaching/resuming. */
  | { readonly kind: 'live' }
  /** Stopped agent session that claim+attach can recover. */
  | { readonly kind: 'attachable'; readonly resumeFailed: boolean }
  /** Stopped agent session that can only be replaced — claim+attach would fail. */
  | { readonly kind: 'needs_fresh' }
  /** The attachment was taken over by another pane. */
  | { readonly kind: 'moved' }
  /** The harness has no runtime adapter wired yet. */
  | { readonly kind: 'unsupported' }
  /**
   * Recovering this pane would create a process, but harness policy forbids it
   * (disabled, or the config/onboarding is not in a launchable state). Terminal
   * and close-only — retry-in-place would just fail for the same reason. It clears
   * itself when policy makes the harness launchable again.
   */
  | { readonly kind: 'blocked'; readonly reason: HarnessLaunchBlockReason }
  /**
   * Recovering this pane would create a process, but the harness is unavailable or
   * inventory is still settling. Retained, with an honest recheck that refreshes
   * inventory before re-evaluating.
   */
  | { readonly kind: 'unavailable'; readonly reason: HarnessLaunchBlockReason };

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
 *  - `connect_existing` → claim+attach connects to an existing process
 *  - `resume_existing` → claim+attach relaunches with harness resume metadata
 *  - `relaunch_fresh` → claim+attach relaunches fresh in the same durable session
 *  - `create_replacement` → claim+attach is guaranteed to fail → needs_fresh
 *
 * Terminals have no durable harness session; reattaching relaunches a fresh
 * shell in place, so a stopped terminal stays a live pane (it reattaches on
 * mount) rather than ever showing a recovery prompt.
 */
export function derivePaneView(
  session: PtyPaneSession | null,
  connection: PaneConnectionSnapshot,
  launch: HarnessLaunchProjection,
): PaneView {
  if (!session) {
    return { kind: 'empty' };
  }
  if (connection.code === 'unsupported_harness') {
    return { kind: 'unsupported' };
  }
  if (connection.code === 'session_attachment_moved') {
    // Reclaiming a moved attachment connects to a live process — it never creates
    // one — so it stays available even under a blocked launch projection.
    return { kind: 'moved' };
  }

  const running = session.status === 'starting' || session.status === 'running';
  if (running) {
    return { kind: 'live' };
  }

  if (session.kind === 'terminal_session') {
    return { kind: 'live' };
  }

  // Non-running agent session. If recovering it would create a process and the
  // runtime says this harness is not launchable, surface the blocker instead of a
  // Resume / Start-fresh action that would fail for the same reason. Pure attach
  // (`connect_existing`) is never gated here.
  if (recoveryRequiresProcessCreation(session.recoveryAction) && launch.status === 'blocked') {
    return blockedView(launch.reason);
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

// `connect_existing` attaches to an already-running process; the other recovery
// actions relaunch/replace and therefore need a fresh process the launch policy
// governs.
export function recoveryRequiresProcessCreation(action: AgentSessionRecoveryAction): boolean {
  return (
    action === 'resume_existing' || action === 'relaunch_fresh' || action === 'create_replacement'
  );
}

// Policy blocks (disabled / onboarding / config) are terminal from the pane —
// only a config change fixes them, so the state is close-only. Availability blocks
// are recheckable in place.
function blockedView(reason: HarnessLaunchBlockReason): PaneView {
  if (
    reason === 'harness_disabled' ||
    reason === 'onboarding_incomplete' ||
    reason === 'config_invalid'
  ) {
    return { kind: 'blocked', reason };
  }
  return { kind: 'unavailable', reason };
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
