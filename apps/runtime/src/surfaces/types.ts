import type {
  AgentHarness,
  AgentSessionRecoveryAction,
  AgentSessionStatusReason,
  PtyProcessBackend,
  PtyProcessLogMode,
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
  readonly paneKinds: readonly ('agent_session' | 'terminal_session')[];
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
  readonly sessionKind: 'agent_session' | 'terminal_session' | null;
  readonly sessionId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PaneSessionBinding {
  readonly paneId: number;
  readonly sessionKind: 'agent_session' | 'terminal_session';
  readonly sessionId: number;
  readonly activePtyProcessId: number | null;
}

export interface PtyProcessRow {
  readonly id: number;
  readonly backend: PtyProcessBackend;
  readonly backendRefJson: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly argsJson: string;
  readonly cwd: string;
  readonly status: SessionStatus;
  readonly statusReason:
    | 'user_requested'
    | 'runtime_shutdown'
    | 'backend_unavailable'
    | 'backend_process_missing'
    | 'backend_attach_failed'
    | 'backend_launch_failed'
    | 'runtime_ephemeral_lost'
    | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly logMode: PtyProcessLogMode;
  readonly logPath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly exitedAt: string | null;
  readonly lastSeenAt: string | null;
}

// The PTY process row as the process service consumes it: args/argsJson are
// optional (some call sites build the record before structured args land) and
// it may carry the placement context (pane/surface/worktree) resolved at read
// time. A bare `PtyProcessRow` is the strict persisted shape.
export type PtyProcessRecord = Omit<PtyProcessRow, 'args' | 'argsJson'> & {
  readonly args?: readonly string[] | undefined;
  readonly argsJson?: string | undefined;
  readonly paneId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly worktreeId?: number | undefined;
};

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
