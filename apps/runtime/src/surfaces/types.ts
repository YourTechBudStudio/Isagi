import type {
  AgentHarness,
  AttentionState,
  PtySessionBackend,
  PtySessionLogMode,
  PtySessionPurpose,
  PtySessionStatus,
  PtySessionStatusReason,
  RuntimeSurfaceKind,
} from '@isagi/contracts';

export interface EnvironmentFocusRow {
  readonly worktreeId: number;
  readonly activeSurfaceId: number | null;
  readonly activePaneId: number | null;
}

export interface SurfaceMetadataRow {
  readonly id: number;
  readonly worktreeId: number;
  readonly kind: RuntimeSurfaceKind;
  readonly title: string;
  readonly attention: AttentionState;
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
  readonly attention: AttentionState;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PtySessionRow {
  readonly id: number;
  readonly paneId: number;
  readonly surfaceId: number;
  readonly worktreeId: number;
  readonly backend: PtySessionBackend;
  readonly backendRefJson: string;
  readonly purpose: PtySessionPurpose;
  readonly harness: AgentHarness | null;
  readonly command: string;
  readonly cwd: string;
  readonly status: PtySessionStatus;
  readonly statusReason: PtySessionStatusReason | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly logMode: PtySessionLogMode;
  readonly logPath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly exitedAt: string | null;
  readonly lastSeenAt: string | null;
}

export interface CreateSinglePaneSurfaceInput {
  readonly worktreeId: number;
  readonly kind: RuntimeSurfaceKind;
  readonly titleBase: string;
}

export interface CreateSinglePaneSurfaceOutput {
  readonly surfaceId: number;
  readonly paneId: number;
  readonly title: string;
}

export interface CreateSinglePanePtySessionSurfaceInput {
  readonly worktreeId: number;
  readonly kind: RuntimeSurfaceKind;
  readonly titleBase: string;
  readonly purpose: PtySessionPurpose;
  readonly harness: AgentHarness | null;
  readonly command: string;
}

export interface CreateSinglePanePtySessionSurfaceOutput {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId: number;
  readonly ptySessionId: number;
  readonly command: string;
  readonly cwd: string;
  readonly logPath: string | null;
}

export interface CreatePtySessionMetadataInput {
  readonly paneId: number;
  readonly backend: PtySessionBackend;
  readonly backendRefJson: string;
  readonly purpose: PtySessionPurpose;
  readonly harness: AgentHarness | null;
  readonly command: string;
  readonly cwd: string;
  readonly status: PtySessionStatus;
  readonly statusReason?: PtySessionStatusReason | null | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly logMode: PtySessionLogMode;
  readonly logPath?: string | null | undefined;
  readonly exitedAt?: string | null | undefined;
  readonly lastSeenAt?: string | null | undefined;
}
