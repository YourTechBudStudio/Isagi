import type { Effect, FiberMap } from 'effect';

import type { AgentSessionService, SurfaceService } from '../../environment/index.js';
import type {
  HarnessAdapterRegistry,
  HarnessControlPlane,
  HarnessConversationTurn,
  HarnessLedgerObserver,
} from '../../harnesses/index.js';
import type { InternalEvents } from '../../platform/events/index.js';
import type { GitCommandError } from '../../platform/git/index.js';
import type { DatabaseError } from '../../platform/persistence/index.js';
import type { ProjectRepository } from '../../projects/index.js';
import type { PtyService } from '../../pty-processes/index.js';
import type { WorkspaceService } from '../../workspace/index.js';
import type { WorkflowEngineError, WorkflowOperationFailed } from '../errors.js';
import type { WorkflowContentStore } from '../store/content-store.js';
import type { EventDraft } from '../store/events.js';
import type { Db } from '../store/rows.js';
import type { LoadedWorkflowArtifact, WorkflowLoadError } from '../structure/loader.js';
import type { WorkflowRegistry } from '../structure/registry.js';
import type { WorkflowAgentHarness, WorkflowConversationMessage } from '../types.js';
import type { TurnEdge } from '../waits/latest-turn.js';
import type { AuthorBridge } from './author-bridge.js';

/**
 * Everything the engine's files share.
 *
 * The engine is one process and the only writer of the workflow tables. Every write goes through
 * `commit`: one synchronous transaction whose appended events are pushed live once it commits,
 * together with the new summary of each run they belong to. `kick` wakes a run's driver; each run
 * has at most one, so a run's steps are sequential while different runs proceed independently.
 */
export interface EngineRuntime {
  readonly deps: EngineDeps;
  /**
   * Runs `write` in one transaction, then publishes its events and their runs' summaries, plus the
   * summary of every run `changed` names. `abort` refuses the write: it rolls back and the commit
   * fails with that refusal, not a database fault.
   */
  readonly commit: <A>(
    operation: string,
    write: (db: Db, emit: Emit, abort: Abort, changed: Changed) => A,
  ) => Effect.Effect<A, DatabaseError | WorkflowEngineError>;
  /** A read outside any transaction. */
  readonly read: <A>(operation: string, read: (db: Db) => A) => Effect.Effect<A, DatabaseError>;
  /** Wakes the run's driver. Safe to call at any time and from anywhere. */
  readonly kick: (runId: number) => void;
  /**
   * Starts background work that outlives the caller, such as preparation after a launch. A failure
   * or defect is logged under `label`; it never reaches the caller.
   */
  readonly fork: <E>(work: Effect.Effect<void, E>, label: string) => void;
  /** Imports a verified build by hash, cached in memory. */
  readonly loadArtifact: (
    artifactHash: string,
    workflowKey: string,
  ) => Effect.Effect<LoadedWorkflowArtifact, WorkflowLoadError>;
  /** The only way the engine calls author code or hands author code a Promise-shaped context. */
  readonly bridge: AuthorBridge;
  /**
   * Pending headless timeouts, by PTY process id. Settling or stopping a job removes its entry,
   * which interrupts the timer; engine shutdown interrupts them all.
   */
  readonly headlessTimers: FiberMap.FiberMap<number>;
  /**
   * Runs whose next agent-turn check refreshes the session's observation first: set by Resume,
   * Retry and startup, where the observer may not have caught up with the harness's own records.
   */
  readonly freshChecks: Set<number>;
  /** Headless processes this process launched, by PTY process id. Lost on restart, by design. */
  readonly headlessProcesses: Map<number, HeadlessProcess>;
  /** Canonical destinations of checkpoint exports in progress, so two never share one folder. */
  readonly exportDestinations: Set<string>;
}

/** Appends an event inside the current transaction. */
export type Emit = (draft: EventDraft) => void;

/**
 * Marks a run whose summary the current transaction changed without appending one of its events, so
 * its new summary is still pushed once the transaction commits.
 */
export type Changed = (runId: number) => void;

/** Refuses the current transaction: it rolls back, and the commit fails with `error`. */
export type Abort = (error: WorkflowEngineError) => never;

export interface HeadlessProcess {
  readonly runId: number;
  readonly operationId: number;
  readonly harness: WorkflowAgentHarness;
  /** Set when the timeout fired: the process's eventual end is recorded as a timeout. */
  timedOut: boolean;
  /** Set while its end is being recorded, so only one settlement runs at a time. */
  settling: boolean;
}

/**
 * The outside world, narrowed to what the engine does with it. The live ports wrap the owning
 * services (ADR 0008); tests supply fakes.
 */
export interface EngineDeps {
  readonly registry: WorkflowRegistry['Service'];
  readonly places: PlacesPort;
  readonly agents: AgentPort;
  readonly headless: HeadlessPort;
  readonly checkpoints: CheckpointsPort;
  readonly internalEvents: InternalEvents['Service'];
}

/** Worktrees and surfaces: read for launch validation, created by preparation. */
export interface PlacesPort {
  readonly workspace: Pick<
    ProjectRepository['Service'],
    'findWorktree' | 'findProject' | 'listWorktrees'
  >;
  readonly workspaceService: Pick<
    WorkspaceService['Service'],
    'preflightWorktreeCreation' | 'openWorktree' | 'runWorktreeSetup'
  >;
  readonly surfaceReads: Pick<
    SurfaceService['Service'],
    'findSurface' | 'listWorkspaceSurfaceMetadata'
  >;
  readonly surfaces: Pick<SurfaceService['Service'], 'getSurfaceDetail' | 'createEmptySurface'>;
}

/** What checkpoint capture and export need: Git's HEAD, the content store, and new directories. */
export interface CheckpointsPort {
  /** The checkout's HEAD commit, or null when the repository has no commits yet. */
  readonly headCommit: (checkoutPath: string) => Effect.Effect<string | null, GitCommandError>;
  readonly content: WorkflowContentStore['Service'];
  readonly createDetachedWorktree: WorkspaceService['Service']['createDetachedWorktree'];
  readonly checkNewDirectory: WorkspaceService['Service']['checkNewDirectory'];
}

/**
 * What an owning service's methods can fail with, read off its shape so the ports follow the
 * services' own error unions instead of restating them.
 */
type Fails<Method> = Method extends (...args: never[]) => infer Result
  ? Effect.Error<Result>
  : Effect.Error<Method>;

type AgentSessions = AgentSessionService['Service'];
type Surfaces = SurfaceService['Service'];
type Pty = PtyService['Service'];

/** Everything a spawn can fail with: the surfaces, the session, its process, and the log write. */
export type AgentSpawnError =
  | WorkflowOperationFailed
  | DatabaseError
  | WorkflowEngineError
  | Fails<Surfaces['getSurfaceDetail' | 'startPane' | 'splitPane']>
  | Fails<AgentSessions['ensureActivePtyProcess' | 'stopUnlessPlaced']>
  | Fails<Pty['getAttachmentPlan' | 'writeInput']>;

export type AgentSendError =
  | WorkflowOperationFailed
  | Fails<AgentSessions['activePtyProcessId']>
  | Fails<Pty['writeInput']>;

export type AgentReadError = WorkflowOperationFailed | Fails<AgentSessions['get']>;

export type AgentTurnEdgesError = Fails<
  HarnessLedgerObserver['Service']['refreshTurnEdges' | 'getTurnEdges']
>;

export interface AgentPort {
  readonly spawn: (input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly harness: WorkflowAgentHarness;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
    readonly prompt: string;
    readonly onCreated: (created: {
      readonly paneId: number;
      readonly agentSessionId: number;
    }) => Effect.Effect<void, DatabaseError | WorkflowEngineError>;
  }) => Effect.Effect<
    {
      readonly agentSessionId: number;
      readonly paneId: number;
      readonly sentAt: string;
      readonly harnessSessionId: string;
    },
    AgentSpawnError
  >;
  readonly send: (input: {
    readonly agentSessionId: number;
    readonly prompt: string;
  }) => Effect.Effect<{ readonly sentAt: string }, AgentSendError>;
  readonly closePane: (input: {
    readonly surfaceId: number;
    readonly paneId: number;
  }) => Effect.Effect<void, Fails<Surfaces['deleteSurfacePane']>>;
  /** The harness a session was created with: what a prompt into it renders for. */
  readonly harnessOf: (
    agentSessionId: number,
  ) => Effect.Effect<WorkflowAgentHarness, Fails<AgentSessions['get']>>;
  readonly conversation: (
    agentSessionId: number,
    turn?: HarnessConversationTurn,
  ) => Effect.Effect<readonly WorkflowConversationMessage[], AgentReadError>;
  /** The observer's turn edges; `refresh` re-reads the harness records first and can fail. */
  readonly turnEdges: (
    agentSessionId: number,
    refresh: boolean,
  ) => Effect.Effect<readonly TurnEdge[], AgentTurnEdgesError>;
  /** Whether the session still has a live process. */
  readonly isAlive: (agentSessionId: number) => Effect.Effect<boolean>;
}

export type HeadlessStartError =
  | Fails<HarnessControlPlane['Service']['assertCanCreateProcess']>
  | Fails<HarnessAdapterRegistry['Service']['buildHeadlessLaunch']>
  | Fails<Pty['launch' | 'pin']>;

export interface HeadlessPort {
  /** Launches and pins the process. Its exit arrives as a PTY event on the internal bus. */
  readonly start: (input: {
    readonly harness: WorkflowAgentHarness;
    readonly cwd: string;
    readonly prompt: string;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
  }) => Effect.Effect<{ readonly ptyProcessId: number }, HeadlessStartError>;
  /** Null while the process runs; its exit once it has ended. */
  readonly exitOf: (
    ptyProcessId: number,
  ) => Effect.Effect<HeadlessExit | null, Fails<Pty['getAttachmentPlan']>>;
  readonly capture: (input: {
    readonly ptyProcessId: number;
    readonly harness: WorkflowAgentHarness;
  }) => Effect.Effect<HeadlessCapture, WorkflowOperationFailed | Fails<Pty['getAttachmentPlan']>>;
  readonly terminate: (ptyProcessId: number) => Effect.Effect<void, Fails<Pty['terminate']>>;
  readonly release: (ptyProcessId: number) => Effect.Effect<void>;
}

export interface HeadlessExit {
  readonly status: 'exited' | 'failed' | 'killed';
  readonly exitCode: number | null;
}

/** What a finished headless run printed, read through its harness's own extractors. */
export interface HeadlessCapture {
  readonly output: string;
  readonly semanticError: string | null;
  readonly harnessSessionId: string | null;
  readonly usage: unknown;
}
