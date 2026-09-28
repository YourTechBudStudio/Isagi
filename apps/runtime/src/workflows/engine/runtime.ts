import type { Effect } from 'effect';

import type { HarnessConversationTurn } from '../../agent-sessions/harness/definition-types.js';
import type { DatabaseError } from '../../persistence/index.js';
import type { InternalRuntimeEventBusService } from '../../runtime-events/index.js';
import type { SurfaceRepositoryService, SurfaceServiceShape } from '../../surfaces/index.js';
import type { WorkspaceServiceShape } from '../../workspace/index.js';
import type { WorkspaceRepositoryService } from '../../workspace/workspace.repository.js';
import type { WorkflowEngineError } from '../errors.js';
import type { WorkflowContentStoreService } from '../store/content-store.js';
import type { EventDraft } from '../store/events.js';
import type { Db } from '../store/rows.js';
import type { LoadedWorkflowArtifact } from '../structure/loader.js';
import type { WorkflowRegistryService } from '../structure/registry.js';
import type { WorkflowAgentHarness, WorkflowConversationMessage } from '../types.js';
import type { TurnEdge } from '../waits/latest-turn.js';

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
  /** Runs `write` in one transaction, then publishes its events and their runs' summaries. */
  readonly commit: <A>(
    operation: string,
    write: (db: Db, emit: Emit) => A,
  ) => Effect.Effect<A, DatabaseError | WorkflowEngineError>;
  /** A read outside any transaction. */
  readonly read: <A>(operation: string, read: (db: Db) => A) => Effect.Effect<A, DatabaseError>;
  /** Wakes the run's driver. Safe to call at any time and from anywhere. */
  readonly kick: (runId: number) => void;
  /** Starts background work that outlives the caller, such as preparation after a launch. */
  readonly fork: (work: Effect.Effect<void, unknown>, label: string) => void;
  /** Imports a verified build by hash, cached in memory. */
  readonly loadArtifact: (
    artifactHash: string,
    workflowKey: string,
  ) => Effect.Effect<LoadedWorkflowArtifact, unknown>;
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

export interface HeadlessProcess {
  readonly runId: number;
  readonly operationId: number;
  readonly harness: WorkflowAgentHarness;
  readonly timer: ReturnType<typeof setTimeout> | null;
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
  readonly registry: WorkflowRegistryService;
  readonly places: PlacesPort;
  readonly agents: AgentPort;
  readonly headless: HeadlessPort;
  readonly checkpoints: CheckpointsPort;
  readonly internalEvents: InternalRuntimeEventBusService;
}

/** Worktrees and surfaces: read for launch validation, created by preparation. */
export interface PlacesPort {
  readonly workspace: Pick<
    WorkspaceRepositoryService,
    'findWorktree' | 'findProject' | 'listWorktrees'
  >;
  readonly workspaceService: Pick<
    WorkspaceServiceShape,
    'preflightWorktreeCreation' | 'openWorktree' | 'runWorktreeSetup'
  >;
  readonly surfaceRepository: Pick<
    SurfaceRepositoryService,
    'findSurface' | 'listWorkspaceSurfaceMetadata'
  >;
  readonly surfaces: Pick<SurfaceServiceShape, 'getSurfaceDetail' | 'createEmptySurface'>;
}

/** What checkpoint capture and export need: Git's HEAD, the content store, and new directories. */
export interface CheckpointsPort {
  /** The checkout's HEAD commit, or null when the repository has no commits yet. */
  readonly headCommit: (checkoutPath: string) => Effect.Effect<string | null, unknown>;
  readonly content: WorkflowContentStoreService;
  readonly createDetachedWorktree: WorkspaceServiceShape['createDetachedWorktree'];
  readonly checkNewDirectory: WorkspaceServiceShape['checkNewDirectory'];
}

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
    }) => Effect.Effect<void, unknown>;
  }) => Effect.Effect<
    {
      readonly agentSessionId: number;
      readonly paneId: number;
      readonly sentAt: string;
      readonly harnessSessionId: string;
    },
    unknown
  >;
  readonly send: (input: {
    readonly agentSessionId: number;
    readonly prompt: string;
  }) => Effect.Effect<{ readonly sentAt: string }, unknown>;
  readonly closePane: (input: {
    readonly surfaceId: number;
    readonly paneId: number;
  }) => Effect.Effect<void, unknown>;
  /** The harness a session was created with: what a prompt into it renders for. */
  readonly harnessOf: (agentSessionId: number) => Effect.Effect<WorkflowAgentHarness, unknown>;
  readonly conversation: (
    agentSessionId: number,
    turn?: HarnessConversationTurn,
  ) => Effect.Effect<readonly WorkflowConversationMessage[], unknown>;
  /** The observer's turn edges; `refresh` re-reads the harness records first and can fail. */
  readonly turnEdges: (
    agentSessionId: number,
    refresh: boolean,
  ) => Effect.Effect<readonly TurnEdge[], unknown>;
  /** Whether the session still has a live process. */
  readonly isAlive: (agentSessionId: number) => Effect.Effect<boolean>;
}

export interface HeadlessPort {
  /** Launches and pins the process. Its exit arrives as a PTY event on the internal bus. */
  readonly start: (input: {
    readonly harness: WorkflowAgentHarness;
    readonly cwd: string;
    readonly prompt: string;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
  }) => Effect.Effect<{ readonly ptyProcessId: number }, unknown>;
  /** Null while the process runs; its exit once it has ended. */
  readonly exitOf: (ptyProcessId: number) => Effect.Effect<HeadlessExit | null, unknown>;
  readonly capture: (input: {
    readonly ptyProcessId: number;
    readonly harness: WorkflowAgentHarness;
  }) => Effect.Effect<HeadlessCapture, unknown>;
  readonly terminate: (ptyProcessId: number) => Effect.Effect<void, unknown>;
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
