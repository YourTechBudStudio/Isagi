import type {
  AgentHarness,
  AgentSessionRecoveryAction,
  AgentSessionStatusReason,
  PaneSessionKind,
  SessionDiagnosticCode,
  SessionStatus,
  SplitPaneDirection,
  SurfaceLayoutNode,
  TerminalSessionStatusReason,
} from '@isagi/contracts';

// Read-side composition only: a session row carries the process the runtime
// joined onto it. The PTY domain owns the row itself (ADR 0005/0008).
import type { PtyProcessRow } from '../pty-processes/types.js';

export interface EnvironmentFocusRow {
  readonly worktreeId: number;
  readonly activeSurfaceId: number | null;
  readonly activePaneId: number | null;
}

export interface SurfaceMetadataRow {
  readonly id: number;
  readonly worktreeId: number;
  readonly title: string;
  readonly paneKinds: readonly PaneSessionKind[];
  readonly sortOrder: number;
}

export interface SurfaceRow extends SurfaceMetadataRow {
  readonly layoutJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SurfacePaneRow {
  readonly id: number;
  readonly surfaceId: number;
  readonly title: string;
  readonly sortOrder: number;
  readonly sessionKind: PaneSessionKind | null;
  readonly sessionId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Deliberately NOT `PaneSessionKind`. This is the inventory of pane-bound
 * sessions that own a PTY incarnation the runtime relaunches and collects, and
 * an editor context is not one of them: its incarnation is recreated on demand,
 * not eagerly at boot. Widening this literal would silently enroll editors in
 * session restore and session GC. That exclusion is story #8's to revisit.
 */
export interface PaneSessionBinding {
  readonly paneId: number;
  readonly sessionKind: 'agent_session' | 'terminal_session';
  readonly sessionId: number;
  readonly activePtyProcessId: number | null;
}

export interface AgentSessionRow {
  readonly id: number;
  readonly worktreeId: number;
  readonly harness: AgentHarness;
  readonly cwd: string;
  readonly harnessSessionId: string | null;
  readonly harnessMetadataStatus: 'valid' | 'missing' | 'invalid';
  readonly harnessMetadataDiagnostic: string | null;
  readonly activePtyProcessId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeenAt: string | null;
  readonly activePtyProcess: PtyProcessRow | null;
}

export interface TerminalSessionRow {
  readonly id: number;
  readonly worktreeId: number;
  readonly cwd: string;
  readonly shellCommand: string;
  readonly shellArgs: readonly string[];
  readonly shellArgsJson: string;
  readonly activePtyProcessId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activePtyProcess: PtyProcessRow | null;
}

export interface DerivedAgentSessionState {
  readonly status: SessionStatus;
  readonly statusReason: AgentSessionStatusReason | null;
  readonly diagnosticCode: SessionDiagnosticCode | null;
  readonly diagnosticDetail: string | null;
  readonly recoveryAction: AgentSessionRecoveryAction;
}

export interface DerivedTerminalSessionState {
  readonly status: SessionStatus;
  readonly statusReason: TerminalSessionStatusReason | null;
  readonly diagnosticCode: SessionDiagnosticCode | null;
  readonly diagnosticDetail: string | null;
}

export interface CreateSinglePaneSurfaceInput {
  readonly worktreeId: number;
  readonly titleBase: string;
  /**
   * A durable entity created before the surface and bound to the new pane
   * inside the same transaction, so surface, pane, binding, and focus commit
   * together and no sessionless pane is ever observable.
   *
   * Only the editor path supplies it. Agent and terminal creation keeps its
   * existing two-step ordering; repairing that is not this seam's job. The
   * single-member union is deliberate: it names the one kind that may be bound
   * this way, so no generic caller can reach transactional placement.
   */
  readonly initialSession?:
    | { readonly kind: 'editor_context'; readonly sessionId: number }
    | undefined;
  /**
   * Names the surface this call intends to create, so a re-entry adopts it instead of creating a
   * second. Written to `worktree_surfaces.creation_key`, which is its own keyspace: the pane this
   * call creates stays unkeyed, and surface re-entry resolves through `findSurfaceByCreationKey`
   * rather than `findKeyedCreation`.
   */
  readonly creationKey?: string | undefined;
}

export interface CreateSinglePaneSurfaceOutput {
  readonly surfaceId: number;
  readonly paneId: number;
  readonly title: string;
  readonly cwd: string;
}

export interface SplitSurfacePaneInput {
  readonly surfaceId: number;
  readonly sourcePaneId: number;
  readonly titleBase: string;
  readonly direction: SplitPaneDirection;
  /** Names the pane this call intends to create, so a re-entry after a crash can adopt it. */
  readonly creationKey?: string | undefined;
}

/**
 * How far a keyed compound creation actually got.
 *
 * Creating a pane, creating its session and associating the two are three separate writes, so a
 * crash can land between any of them. "Return the existing row" satisfies neither the caller nor
 * this service's own postcondition in the middle states, which is why each one is named: recovery
 * resumes from where it stopped rather than starting over or declaring success early.
 *
 * A component the key names but that no longer exists — a pane the person closed between the crash
 * and the recovery — resolves to `absent` and is recreated. The key describes intent, not a live
 * handle.
 */
export type KeyedCreationState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'pane_only'; readonly surfaceId: number; readonly paneId: number }
  | {
      readonly kind: 'session_unassigned';
      readonly surfaceId: number;
      readonly paneId: number;
      readonly session: KeyedSessionIdentity;
    }
  | {
      readonly kind: 'complete';
      readonly surfaceId: number;
      readonly paneId: number;
      readonly session: KeyedSessionIdentity;
    };

/**
 * A recovered session, carrying enough of what it *is* to be checked against what a re-entering
 * caller is asking for.
 *
 * The harness is part of the identity rather than a detail: adopting a session created for one
 * harness into a request for another would hand the caller a live agent of the wrong kind while
 * reporting a successful recovery.
 */
export interface KeyedSessionIdentity {
  readonly kind: 'agent_session';
  readonly sessionId: number;
  readonly harness: AgentHarness;
}

export interface SplitSurfacePaneOutput {
  readonly surfaceId: number;
  readonly paneId: number;
  readonly title: string;
}

export interface SetSurfaceLayoutOutput {
  readonly surfaceId: number;
  readonly layout: SurfaceLayoutNode;
}

export interface SurfaceDeletePaneTarget {
  readonly pane: SurfacePaneRow;
}

export interface SurfaceDeleteTarget {
  readonly surface: SurfaceRow;
  readonly panes: readonly SurfaceDeletePaneTarget[];
}

export interface RenameSurfaceOutput {
  readonly surfaceId: number;
  readonly title: string;
}

export interface DeleteSurfaceRowsOutput {
  readonly deletedSurfaceId: number | null;
  readonly deletedPaneIds: readonly number[];
}
