import { Data } from 'effect';

import type {
  AgentHarness,
  PtySessionBackend,
  PtySessionPurpose,
  PtySessionStatusReason,
  PtyWebSocketOutputMessage,
} from '@isagi/contracts';

export type PtyBackendName = PtySessionBackend;
export type { PtySessionStatusReason };

export interface NodePtyBackendRef {
  readonly schemaVersion: 1;
  readonly backend: 'node_pty';
  readonly ptySessionId: number;
  readonly pid: number | null;
}

export type BackendSessionRef = NodePtyBackendRef;

export interface LaunchBackendSessionInput {
  readonly ptySessionId: number;
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cols: number;
  readonly rows: number;
  readonly logPath: string | null;
  readonly onExit: (exit: PtyExit) => void;
}

export interface PtyExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export class PtyStartError extends Data.TaggedError('PtyStartError')<{
  readonly ptySessionId?: number | undefined;
  readonly command: string;
  readonly cwd: string;
  readonly cause: unknown;
}> {}

export class PtyWriteError extends Data.TaggedError('PtyWriteError')<{
  readonly ptySessionId?: number | undefined;
  readonly cause: unknown;
}> {}

export class PtyResizeError extends Data.TaggedError('PtyResizeError')<{
  readonly ptySessionId?: number | undefined;
  readonly cause: unknown;
}> {}

export class PtyKillError extends Data.TaggedError('PtyKillError')<{
  readonly ptySessionId?: number | undefined;
  readonly cause: unknown;
}> {}

export class PtyServiceError extends Data.TaggedError('PtyServiceError')<{
  readonly code:
    | 'worktree_not_found'
    | 'session_not_found'
    | 'session_not_running'
    | 'backend_unavailable'
    | 'backend_session_missing'
    | 'backend_attach_failed'
    | 'log_read_failed';
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly ptySessionId?: number | undefined;
  readonly cause?: unknown;
}> {}

export class PtyInspectError extends Data.TaggedError('PtyInspectError')<{
  readonly ptySessionId?: number | undefined;
  readonly cause: unknown;
}> {}

export interface BackendInspection {
  readonly alive: boolean;
}

export interface BackendAttachment {
  readonly write: (data: string) => import('effect').Effect.Effect<void, PtyWriteError>;
  readonly resize: (size: {
    readonly cols: number;
    readonly rows: number;
  }) => import('effect').Effect.Effect<void, PtyResizeError>;
  readonly detach: import('effect').Effect.Effect<void, never>;
}

export interface PtyBackend {
  readonly name: PtyBackendName;
  readonly available: import('effect').Effect.Effect<boolean, never>;
  readonly launch: (
    input: LaunchBackendSessionInput,
  ) => import('effect').Effect.Effect<BackendSessionRef, PtyStartError>;
  readonly attach: (input: {
    readonly ref: BackendSessionRef;
    readonly cols: number;
    readonly rows: number;
    readonly onOutput: (data: string) => void;
    readonly onExit: (exit: PtyExit) => void;
  }) => import('effect').Effect.Effect<BackendAttachment, PtyStartError>;
  readonly replay: (input: {
    readonly ref: BackendSessionRef;
    readonly logPath: string | null;
    readonly bytes: number | null;
    readonly send: (message: PtyWebSocketOutputMessage) => void;
  }) => import('effect').Effect.Effect<void, PtyServiceError>;
  readonly inspect: (
    ref: BackendSessionRef,
  ) => import('effect').Effect.Effect<BackendInspection, PtyInspectError>;
  readonly kill: (ref: BackendSessionRef) => import('effect').Effect.Effect<void, PtyKillError>;
}

export interface LaunchPtySessionInput {
  readonly worktreeId: number;
  readonly purpose: PtySessionPurpose;
  readonly harness: AgentHarness | null;
}

export interface PtySessionLaunchMetadata {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId: number;
  readonly ptySessionId: number;
  readonly command: string;
  readonly cwd: string;
  readonly logPath: string | null;
}
