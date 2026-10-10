import type {
  AgentSessionRecoveryAction,
  AgentSessionStatusReason,
  PaneSessionKind,
  SessionDiagnosticCode,
  SessionStatus,
  SplitPaneDirection,
  SurfaceLayoutNode,
  TerminalSessionStatusReason,
} from '@isagi/contracts';

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
}

export interface CreateSinglePaneSurfaceOutput {
  readonly surfaceId: number;
  readonly paneId: number;
  readonly title: string;
  readonly cwd: string;
}

export interface CreateEmptySurfaceInput {
  readonly worktreeId: number;
  readonly titleBase: string;
}

export interface CreateEmptySurfaceOutput {
  readonly surfaceId: number;
  readonly title: string;
}

export interface StartSurfacePaneInput {
  readonly surfaceId: number;
  readonly titleBase: string;
  /** As `CreateSinglePaneSurfaceInput.initialSession`: only the editor binds this way. */
  readonly initialSession?:
    | { readonly kind: 'editor_context'; readonly sessionId: number }
    | undefined;
}

/** Returned rather than thrown: a refusal is expected and must not read as a database fault. */
export type StartSurfacePaneResult =
  | {
      readonly status: 'started';
      readonly worktreeId: number;
      readonly surfaceId: number;
      readonly paneId: number;
      readonly title: string;
    }
  | { readonly status: 'surface_not_found' }
  | { readonly status: 'surface_not_empty'; readonly worktreeId: number };

export interface SplitSurfacePaneInput {
  readonly surfaceId: number;
  readonly sourcePaneId: number;
  readonly titleBase: string;
  readonly direction: SplitPaneDirection;
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

/**
 * What a delete actually removed, read inside its transaction. The session
 * bindings on these rows are the ones cleanup must act on: a session bound
 * after the caller last looked is here, where a pre-read capture would miss it.
 */
export interface DeleteSurfaceRowsOutput {
  readonly deletedSurfaceId: number | null;
  readonly deletedPanes: readonly SurfacePaneRow[];
}

export interface DeletePaneRowsOutput {
  readonly deletedPanes: readonly SurfacePaneRow[];
}
