import { Data, type Effect, type Queue, type Scope, type Stream } from 'effect';

import type {
  PtyProcessBackend,
  PtyProcessLogMode,
  PtyStreamOutputMessageSet,
  SessionStatus,
} from '@isagi/contracts';

import { coordinates, describeSafely, type SafeDiagnostic } from '../platform/diagnostics/index.js';
import type { ShellLaunchMode } from '../platform/process/index.js';

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

// A process dies exactly once: once one of these is persisted, no later
// transition may replace it. Shared vocabulary rather than a private set in the
// repository, because the guarded write, the generic cleanup flow, and the
// startup/boot readers all have to agree on what "already terminal" means.
const terminalPtyProcessStatuses: ReadonlySet<PtyProcessStatus> = new Set([
  'exited',
  'failed',
  'killed',
]);

export function isTerminalPtyProcessStatus(status: PtyProcessStatus) {
  return terminalPtyProcessStatuses.has(status);
}

// Why an incarnation the backend can no longer find is gone. A node-pty process
// lives and dies with the runtime, so its absence is an ephemeral loss rather
// than a missing backend process. The two operational flows that classify an
// absent process — the status poller and generic cleanup — must not drift on
// this, so the split lives here rather than being spelled out at each site.
export function missingStatusReasonForBackend(backend: PtyBackendName): PtyProcessStatusReason {
  return backend === 'node_pty' ? 'runtime_ephemeral_lost' : 'backend_process_missing';
}

// The durable PTY process row, owned here because the process facts are this
// domain's (ADR 0005). Read-side composition in `surfaces` joins it onto a
// session row; it does not own it.
export interface PtyProcessRow {
  readonly id: number;
  readonly backend: PtyProcessBackend;
  readonly backendRefJson: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly argsJson: string;
  readonly cwd: string;
  readonly status: PtyProcessStatus;
  readonly statusReason: PtyProcessStatusReason | null;
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

export interface NodePtyBackendRef {
  readonly schemaVersion: 1;
  readonly backend: 'node_pty';
  readonly ptyProcessId: number;
  readonly pid: number | null;
  readonly shellIntegrationToken?: string | null | undefined;
}

export interface TmuxBackendRef {
  readonly schemaVersion: 1;
  readonly backend: 'tmux';
  readonly sessionName: string;
  readonly shellIntegrationToken?: string | null | undefined;
}

export type BackendSessionRef = NodePtyBackendRef | TmuxBackendRef;

export interface PtyBackendGcSession {
  readonly ptyProcessId: number;
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
      readonly ptyProcessId: number;
    }
  | {
      readonly type: 'terminal_backend_session';
      readonly ref: BackendSessionRef;
      readonly ptyProcessId: number;
      readonly status: 'exited' | 'failed' | 'killed';
    };

export interface LaunchBackendSessionInput {
  readonly ptyProcessId: number;
  readonly backendSessionName: string | null;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shellIntegration?: ShellIntegrationConfig | null | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly logPath: string | null;
}

export interface PtyExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/**
 * Every fact a backend learns about a launched process after the spawn. The adapter callbacks only enqueue these;
 * the PTY service's per-process supervisor fiber is the one place they become effects.
 */
export type PtyProcessEvent =
  | { readonly _tag: 'ForegroundChanged'; readonly state: PtyForegroundCommandState }
  | { readonly _tag: 'LogAppendFailed'; readonly cause: unknown }
  | ({ readonly _tag: 'Exited' } & PtyExit);

/** What a backend writes to a live attachment: output and, for a process that exits while attached, `exit`. */
export type PtyOutputMessage = PtyStreamOutputMessageSet;

export interface LaunchedBackendSession {
  readonly ref: BackendSessionRef;
  /**
   * Ends after `Exited`, or without one when the process was killed through `kill`/`terminate` (the killer owns
   * that terminal fact). A backend with no live exit signal (tmux) returns an empty stream.
   */
  readonly events: Stream.Stream<PtyProcessEvent>;
}

export class PtyStartError
  extends Data.TaggedError('PtyStartError')<{
    readonly ptyProcessId?: number | undefined;
    readonly command: string;
    readonly cwd: string;
    readonly reason?: 'backend_session_not_live' | undefined;
    readonly cause: unknown;
  }>
  implements SafeDiagnostic
{
  // `command` and `cwd` are deliberately omitted: a resolved command line and
  // a filesystem path are process data, not coordinates.
  [describeSafely]() {
    return {
      label: `PTY start error${this.reason ? ` ${this.reason}` : ''}${coordinates({
        ptyProcess: this.ptyProcessId,
      })}`,
      cause: this.cause,
    };
  }
}

export class PtyWriteError
  extends Data.TaggedError('PtyWriteError')<{
    readonly ptyProcessId?: number | undefined;
    readonly cause: unknown;
  }>
  implements SafeDiagnostic
{
  [describeSafely]() {
    return {
      label: `PTY write error${coordinates({ ptyProcess: this.ptyProcessId })}`,
      cause: this.cause,
    };
  }
}

export class PtyResizeError
  extends Data.TaggedError('PtyResizeError')<{
    readonly ptyProcessId?: number | undefined;
    readonly cause: unknown;
  }>
  implements SafeDiagnostic
{
  [describeSafely]() {
    return {
      label: `PTY resize error${coordinates({ ptyProcess: this.ptyProcessId })}`,
      cause: this.cause,
    };
  }
}

export class PtyKillError
  extends Data.TaggedError('PtyKillError')<{
    readonly ptyProcessId?: number | undefined;
    readonly cause: unknown;
  }>
  implements SafeDiagnostic
{
  [describeSafely]() {
    return {
      label: `PTY kill error${coordinates({ ptyProcess: this.ptyProcessId })}`,
      cause: this.cause,
    };
  }
}

/**
 * A process log file the runtime could not create or append to (a full disk, a refused permission, a removed sessions
 * directory). Its path is process data, so only the PTY id is rendered.
 */
export class PtyLogError
  extends Data.TaggedError('PtyLogError')<{
    readonly operation: 'create' | 'append';
    readonly ptyProcessId: number;
    readonly cause: unknown;
  }>
  implements SafeDiagnostic
{
  [describeSafely]() {
    return {
      label: `PTY log ${this.operation} failed${coordinates({ ptyProcess: this.ptyProcessId })}`,
      cause: this.cause,
    };
  }
}

// A termination attempt is already reserved for this row. The second caller is
// rejected rather than joined: reusing the first attempt's outcome would lend
// its affirmative kill to a cause that did not commit it. Internal to
// `pty-processes` — deliberately not re-exported from the feature barrel.
export class PtyTerminationInProgressError
  extends Data.TaggedError('PtyTerminationInProgressError')<{
    readonly ptyProcessId: number;
  }>
  implements SafeDiagnostic
{
  [describeSafely]() {
    return {
      label: `PTY termination already in progress${coordinates({
        ptyProcess: this.ptyProcessId,
      })}`,
      cause: null,
    };
  }
}

/**
 * A `required` multi-process teardown left processes running. Names every process it could not
 * stop; `cause` is the first failure (each one is logged when it happens).
 */
export class PtyTeardownError extends Data.TaggedError('PtyTeardownError')<{
  readonly operation: string;
  readonly ptyProcessIds: readonly number[];
  readonly cause: unknown;
}> {}

export class PtyServiceError
  extends Data.TaggedError('PtyServiceError')<{
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
    readonly ptyProcessId?: number | undefined;
    readonly cause?: unknown;
  }>
  implements SafeDiagnostic
{
  // `message` is never rendered: two authored messages embed ref-derived values.
  [describeSafely]() {
    return {
      label: `PTY service error ${this.code}${coordinates({
        ptyProcess: this.ptyProcessId,
        worktree: this.worktreeId,
      })}`,
      cause: this.cause,
    };
  }
}

export class PtyInspectError
  extends Data.TaggedError('PtyInspectError')<{
    readonly ptyProcessId?: number | undefined;
    readonly cause: unknown;
  }>
  implements SafeDiagnostic
{
  [describeSafely]() {
    return {
      label: `PTY inspect error${coordinates({ ptyProcess: this.ptyProcessId })}`,
      cause: this.cause,
    };
  }
}

// Attempt-honest kill result. `false` means this attempt found no live process
// for the ref: it terminated nothing and must persist no `killed` fact.
export interface BackendTerminateResult {
  readonly terminated: boolean;
}

export type BackendInspection =
  | { readonly status: 'alive' }
  | { readonly status: 'missing' }
  | { readonly status: 'unavailable'; readonly cause?: unknown };

/** A live attachment. It detaches when the scope it was acquired in closes. */
export interface BackendAttachment {
  readonly replayBytes: number | null;
  readonly write: (data: string) => Effect.Effect<void, PtyWriteError>;
  readonly resize: (size: {
    readonly cols: number;
    readonly rows: number;
  }) => Effect.Effect<void, PtyResizeError>;
}

export interface PtyBackend {
  readonly name: PtyBackendName;
  readonly available: Effect.Effect<boolean, never>;
  /** Spawns. Every later fact about the process arrives on the returned `events` stream. */
  readonly launch: (
    input: LaunchBackendSessionInput,
  ) => Effect.Effect<LaunchedBackendSession, PtyStartError>;
  readonly writeInput: (input: {
    readonly ref: BackendSessionRef;
    readonly data: string;
  }) => Effect.Effect<void, PtyWriteError>;
  /**
   * Live output goes to `output` from this instant, and `replayBytes` is the log size at the same instant, so no
   * byte is both replayed and delivered. Backends that only learn foreground state while attached (tmux) also write
   * `foreground`. Detaches when the scope closes (tmux: kills its attach client).
   */
  readonly attach: (input: {
    readonly ref: BackendSessionRef;
    readonly cols: number;
    readonly rows: number;
    readonly output: Queue.Enqueue<PtyOutputMessage>;
    readonly foreground: Queue.Enqueue<PtyForegroundCommandState>;
  }) => Effect.Effect<BackendAttachment, PtyStartError, Scope.Scope>;
  readonly replay: (input: {
    readonly ref: BackendSessionRef;
    readonly logPath: string | null;
    readonly bytes: number | null;
    readonly send: (message: PtyStreamOutputMessageSet) => void;
  }) => Effect.Effect<void, PtyServiceError>;
  readonly inspect: (ref: BackendSessionRef) => Effect.Effect<BackendInspection, PtyInspectError>;
  readonly listSessions: Effect.Effect<readonly BackendSessionRef[], PtyInspectError>;
  readonly terminate?: (input: {
    readonly ref: BackendSessionRef;
    readonly gracefulTimeoutMs: number;
  }) => Effect.Effect<BackendTerminateResult, PtyKillError>;
  readonly kill: (ref: BackendSessionRef) => Effect.Effect<BackendTerminateResult, PtyKillError>;
  readonly collectGarbage?: (
    input: PtyBackendGcInput,
  ) => Effect.Effect<readonly PtyBackendGcFinding[], PtyInspectError>;
}

export interface LaunchPtyProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  // Explicit variables layered on top of the resolved login-shell environment.
  // Callers pass only what they mean to add or override — never a premerged
  // copy of `process.env` — because the baseline is already sanitized of runtime
  // controls (`PORT`, `HOST`, `ISAGI_*`) while overrides are honoured verbatim.
  readonly envOverrides?: NodeJS.ProcessEnv | undefined;
  readonly launchMode?: PtyLaunchMode | undefined;
  readonly shellIntegration?: boolean | undefined;
  readonly envForProcess?:
    | ((input: { readonly ptyProcessId: number }) => Effect.Effect<NodeJS.ProcessEnv, never>)
    | undefined;
  /** Which adapter creates this incarnation. Omitted — the default — keeps the
   *  existing behaviour exactly: the process-wide configured backend. A caller
   *  supplies it only when the incarnation's transport is part of its own
   *  correctness rather than a user preference. Every operation on an *existing*
   *  row still dispatches through its persisted backend, so ADR 0005's
   *  disposable-process model is untouched. */
  readonly backend?: PtyBackendName | undefined;
}

export type PtyLaunchMode = ShellLaunchMode;

export interface PtyProcessLaunchMetadata {
  readonly ptyProcessId: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly logPath: string | null;
}

// One-shot pre-start launch allocation. The durable PTY row exists and is
// reserved the moment this resolves, so a caller can persist ownership before
// any backend process exists.
//
// The phase machine is `allocated -> starting -> settled` or
// `allocated -> abandoned`. `start` is total for every uninterrupted path: it
// has no expected-failure channel and folds pre-spawn and spawn failures into
// the row, returning metadata the caller can still inspect and kill through.
// An interrupted `start` deliberately returns nothing and hands convergence to
// its own cleanup and the caller's interruption handling.
export interface PtyProcessAllocation {
  // The durable row already exists with status `starting` and is reserved
  // against the generic liveness observers. No process exists yet.
  readonly ptyProcessId: number;
  readonly start: Effect.Effect<PtyProcessLaunchMetadata>;
  // Idempotent, and a no-op once `start` has begun, so it is safe to attach
  // unconditionally as a scoped releaser or interruption cleanup.
  readonly abandon: Effect.Effect<void, never>;
}

export type PtyForegroundCommandState = 'idle' | 'working';

export interface ShellIntegrationConfig {
  readonly token: string;
}
