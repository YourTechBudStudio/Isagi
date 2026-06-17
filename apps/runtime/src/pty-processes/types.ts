import { Data, type Effect } from 'effect';

import type {
  PtyProcessBackend,
  PtyProcessLogMode,
  PtyWebSocketOutputMessage,
  SessionStatus,
} from '@isagi/contracts';

export type PtyBackendName = PtyProcessBackend;
export type PtyProcessStatus = SessionStatus;
export type PtyProcessStatusReason =
  | 'user_requested'
  | 'runtime_shutdown'
  | 'backend_unavailable'
  | 'backend_process_missing'
  | 'backend_attach_failed'
  | 'backend_launch_failed'
  | 'runtime_ephemeral_lost';

// Compatibility aliases used while the old PTY internals are being renamed.
// These names are internal only; public contracts no longer expose PTY sessions.
export type PtySessionStatus = PtyProcessStatus;
export type PtySessionStatusReason = PtyProcessStatusReason;
export type PtySessionBackend = PtyProcessBackend;
export type PtySessionLogMode = PtyProcessLogMode;

export interface NodePtyBackendRef {
  readonly schemaVersion: 1;
  readonly backend: 'node_pty';
  readonly ptySessionId: number;
  readonly pid: number | null;
}

export interface TmuxBackendRef {
  readonly schemaVersion: 1;
  readonly backend: 'tmux';
  readonly sessionName: string;
}

export type BackendSessionRef = NodePtyBackendRef | TmuxBackendRef;

export interface PtyBackendGcSession {
  readonly ptySessionId: number;
  readonly ref: BackendSessionRef;
  readonly status: PtyProcessStatus;
}

export interface PtyBackendGcInput {
  readonly runtimeNamespace: string;
  readonly sessions: readonly PtyBackendGcSession[];
}

export type PtyBackendGcFinding =
  | {
      readonly type: 'orphan_backend_session';
      readonly ref: BackendSessionRef;
      readonly ptySessionId: number;
    }
  | {
      readonly type: 'terminal_backend_session';
      readonly ref: BackendSessionRef;
      readonly ptySessionId: number;
      readonly status: 'exited' | 'failed' | 'killed';
    };

export interface LaunchBackendSessionInput {
  readonly ptySessionId: number;
  readonly backendSessionName: string | null;
  readonly command: string;
  readonly args: readonly string[];
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
    | 'active_process_missing'
    | 'active_process_not_running'
    | 'session_already_attached'
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

export type BackendInspection =
  | { readonly status: 'alive' }
  | { readonly status: 'missing' }
  | { readonly status: 'unavailable'; readonly cause?: unknown };

export interface BackendAttachment {
  readonly write: (data: string) => Effect.Effect<void, PtyWriteError>;
  readonly resize: (size: {
    readonly cols: number;
    readonly rows: number;
  }) => Effect.Effect<void, PtyResizeError>;
  readonly detach: Effect.Effect<void, never>;
}

export interface PtyBackend {
  readonly name: PtyBackendName;
  readonly available: Effect.Effect<boolean, never>;
  readonly launch: (
    input: LaunchBackendSessionInput,
  ) => Effect.Effect<BackendSessionRef, PtyStartError>;
  readonly attach: (input: {
    readonly ref: BackendSessionRef;
    readonly cols: number;
    readonly rows: number;
    readonly onOutput: (data: string) => void;
    readonly onSessionExit: (exit: PtyExit) => void;
  }) => Effect.Effect<BackendAttachment, PtyStartError>;
  readonly replay: (input: {
    readonly ref: BackendSessionRef;
    readonly logPath: string | null;
    readonly bytes: number | null;
    readonly send: (message: PtyWebSocketOutputMessage) => void;
  }) => Effect.Effect<void, PtyServiceError>;
  readonly inspect: (ref: BackendSessionRef) => Effect.Effect<BackendInspection, PtyInspectError>;
  readonly listSessions: Effect.Effect<readonly BackendSessionRef[], PtyInspectError>;
  readonly kill: (ref: BackendSessionRef) => Effect.Effect<void, PtyKillError>;
  readonly collectGarbage?: (
    input: PtyBackendGcInput,
  ) => Effect.Effect<readonly PtyBackendGcFinding[], PtyInspectError>;
}

export interface LaunchPtyProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly envForProcess?:
    | ((input: { readonly ptyProcessId: number }) => Effect.Effect<NodeJS.ProcessEnv, never>)
    | undefined;
}

export interface PtyProcessLaunchMetadata {
  readonly ptyProcessId: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly logPath: string | null;
}

// Internal compatibility shape for old backend helpers.
export interface PtySessionLaunchMetadata {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId: number;
  readonly ptySessionId: number;
  readonly command: string;
  readonly cwd: string;
  readonly logPath: string | null;
}
