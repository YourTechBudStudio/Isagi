import type {
  AgentHarness,
  AttentionState,
  PtySessionAdapter,
  PtySessionPurpose,
  PtySessionStatus,
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
  readonly worktreeId: number;
  readonly adapter: PtySessionAdapter;
  readonly purpose: PtySessionPurpose;
  readonly harness: AgentHarness | null;
  readonly command: string;
  readonly cwd: string;
  readonly status: PtySessionStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly logPath: string;
  readonly logBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly exitedAt: string | null;
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

export interface CreatePtySessionMetadataInput {
  readonly paneId: number;
  readonly adapter: PtySessionAdapter;
  readonly purpose: PtySessionPurpose;
  readonly harness: AgentHarness | null;
  readonly command: string;
  readonly cwd: string;
  readonly status: PtySessionStatus;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly logPath: string;
  readonly logBytes?: number | undefined;
  readonly exitedAt?: string | null | undefined;
}
