import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type {
  WorkflowFailureCode,
  WorkflowInvocationKind,
  WorkflowNodeKind,
  WorkflowOutcomeKind,
  WorkflowRunPosition,
  WorkflowSegmentKind,
  WorkflowWaitKind,
} from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../persistence/database.service.js';
import { DatabaseError, RuntimeDatabase } from '../../persistence/index.js';
import {
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowPauseIntervals,
  workflowRunAttachments,
  workflowRuns,
  workflowSegmentAttempts,
  workflowVersionAdoptions,
  workflowWaits,
  worktreeSurfaces,
  worktrees,
} from '../../persistence/schema.js';
import { normalizeDisplayName } from './display-name.js';
import { appendTransitions, type TransitionDraft } from './history.repository.js';
import {
  committed,
  rejected,
  type SegmentCommitOutcome,
  type WorkflowWriteResult,
} from './outcomes.js';
import {
  WorkflowPayloadStore,
  type PayloadPublishError,
  type PayloadSlot,
  type WorkflowPayloadStoreService,
} from './payload-store.js';
import type {
  WorkflowAttemptRecord,
  WorkflowExecutionRecord,
  WorkflowFrameRecord,
  WorkflowPauseIntervalRecord,
  WorkflowPauseReason,
  WorkflowRunAttachmentRecord,
  WorkflowRunPlacement,
  WorkflowRunRecord,
  WorkflowVersionAdoptionRecord,
  WorkflowWaitRecord,
} from './records.js';
import {
  attachmentRecord,
  attemptRecord,
  encodeRunPosition,
  executionRecord,
  frameRecord,
  pauseIntervalRecord,
  runRecord,
  versionAdoptionRecord,
  waitRecord,
} from './row-mappers.js';
import { slotColumns, slotFromColumns } from './slots.js';
import {
  silentWriteWake,
  wakingDatabase,
  WorkflowWriteWake,
  type WorkflowWriteWakeService,
} from './write-wake.js';

/**
 * A value a caller is recording.
 *
 * Wrapping it is what keeps "no value" and "the value `null`" apart all the way down to the column
 * pair: `undefined` means the slot was never produced, `{ value: null }` means the producer
 * genuinely produced JSON `null`.
 */
export interface RecordedValue {
  readonly value: unknown;
}

export interface CreateRunInput {
  readonly workflowKey: string;
  readonly title: string;
  readonly rootGraphKey: string;
  readonly artifactHash: string;
  readonly rootFrame: {
    readonly graphKey: string;
    readonly displayName?: string | null;
    /** The launch inputs, stored on the root frame exactly as a nested frame stores its mapping. */
    readonly parameters?: RecordedValue | undefined;
  };
  readonly origin: WorkflowRunPlacement;
  readonly destination: {
    readonly worktreeId: number | null;
    readonly worktreePath: string | null;
    readonly surfaceId: number | null;
  };
  readonly attachment: { readonly worktreeId: number; readonly surfaceId: number | null } | null;
}

/**
 * What the caller read to compose this claim's input, so the repository can check it is still true.
 *
 * The control revision orders this claim against other *controls*; it says nothing about whether the
 * operands the input was built from still hold. A Retry adoption repins the run, and a commit moves
 * the position and rewrites a frame's state — none of which touch the control revision in a way that
 * would tell a claim its prepared input has gone stale.
 *
 * Only genuinely mutable sources are listed. A delivered wait's event and a completed child's output
 * are immutable once written — the wait's monotonic guard and the child's completion fact both
 * forbid rewriting them — so fencing them would add ceremony without adding a guarantee. The run's
 * history revision is deliberately *not* a fence either: a diagnostic or an operation receipt bumps
 * it while changing no operand, and invalidating a correct input for that would be noise.
 */
export interface ClaimPreparation {
  /** The segment the input was composed for. */
  readonly position: WorkflowRunPosition;
  /** The pin the operands were read under. */
  readonly artifactHash: string;
  /** Each frame whose committed state fed the input, and the slot it held when read. */
  readonly frameStates: readonly {
    readonly frameId: number;
    readonly state: PayloadSlot | null;
  }[];
}

export interface ClaimSegmentInput {
  readonly runId: number;
  readonly controlRevision: number;
  readonly owner: string;
  readonly ownerIncarnation: string;
  /**
   * The data operands this segment is about to run against, composed by the caller.
   *
   * Required, not optional. The caller is the only party that knows what a given segment's input
   * *is* — a root graph entry initializes from its saved launch parameters and has no parent state,
   * while a child entry may carry parent-state operands for its parameter mapping and then
   * initialize from the mapped result — and an optional argument would let that evidence quietly go
   * on being absent. The repository never evaluates a callback or reconstructs an argument list; it
   * persists what it is given, atomically with the attempt.
   *
   * Executable context and services must not appear here: this is serialized and retained.
   */
  readonly input: RecordedValue;
  readonly preparation: ClaimPreparation;
}

export interface ClaimedSegment {
  readonly run: WorkflowRunRecord;
  readonly attempt: WorkflowAttemptRecord;
}

export interface AttemptFence {
  readonly runId: number;
  readonly attemptId: number;
  readonly owner: string;
  readonly ownerIncarnation: string;
}

export interface CommitGraphEntryInput extends AttemptFence {
  readonly frameId: number;
  readonly parameters?: RecordedValue | undefined;
  readonly state: RecordedValue;
  readonly frameDisplayName?: string | null;
  /** The entry node this graph dispatches into, created by this commit. */
  readonly entryNode: {
    readonly nodeId: string;
    readonly nodeKind: WorkflowNodeKind;
    readonly displayName?: string | null;
  };
}

/**
 * Opening a child frame runs no author code, so it allocates no attempt.
 *
 * The child's parameter mapping and `init` both belong to the child's own `graph_entry` segment —
 * that is what `parameter_mapping_failed` and `graph_init_failed` are failure codes *of*. This
 * transaction only creates the frame shell and moves the position into it.
 *
 * It is still a **dispatch**: it emits `node_dispatched` and advances the run. So it carries every
 * gate a claim carries — status, Pause, Cancel, the environment cache and the live placement
 * re-check — minus the one it cannot have, an attempt owner. Exclusion comes from the saved
 * position instead: whichever transaction commits first moves the run to `graph_entry`, and the
 * loser's position check rejects it before it writes anything.
 */
export interface EnterSubgraphInput {
  readonly runId: number;
  readonly controlRevision: number;
  /** The `node_callback` position this decision was prepared against. */
  readonly expectedPosition: WorkflowRunPosition;
  /** The pin the subgraph registration was read from. */
  readonly artifactHash: string;
  readonly parentExecutionId: number;
  readonly childGraphKey: string;
  readonly childDisplayName?: string | null;
}

export interface CommitNodeResultInput extends AttemptFence {
  readonly frameId: number;
  readonly executionId: number;
  readonly state: RecordedValue;
  /** The complete producer result, written before reduction was attempted. */
  readonly producerOutput: RecordedValue;
  readonly producerArtifactHash: string;
  readonly next:
    | { readonly kind: 'routing'; readonly edgeId: string }
    | {
        readonly kind: 'suspend';
        readonly waitKind: WorkflowWaitKind;
        readonly condition: RecordedValue;
      };
}

export interface CommitRoutingInput extends AttemptFence {
  readonly frameId: number;
  readonly executionId: number;
  readonly state: RecordedValue;
  readonly producerOutput: RecordedValue;
  readonly producerArtifactHash: string;
  readonly waitId?: number | null;
  readonly next:
    | {
        readonly kind: 'node';
        readonly nodeId: string;
        readonly nodeKind: WorkflowNodeKind;
        readonly displayName?: string | null;
      }
    | { readonly kind: 'outcome'; readonly outcomeId: string };
}

export interface PublishChildOutputInput extends AttemptFence {
  readonly frameId: number;
  readonly outcomeId: string;
  readonly outcomeKind: WorkflowOutcomeKind;
  readonly outcomeReason?: string | null;
  readonly output: RecordedValue;
  /** The pin that actually produced the output, which a later attempt carries forward unchanged. */
  readonly outputArtifactHash: string;
}

export interface CommitOutputMappingInput extends AttemptFence {
  readonly parentFrameId: number;
  readonly parentExecutionId: number;
  readonly state: RecordedValue;
  readonly producerOutput: RecordedValue;
  readonly producerArtifactHash: string;
  readonly edgeId: string;
}

export interface CompleteRunInput extends AttemptFence {
  readonly frameId: number;
  readonly outcomeId: string;
  readonly outcomeKind: WorkflowOutcomeKind;
  readonly outcomeReason?: string | null;
  readonly output: RecordedValue;
  readonly outputArtifactHash: string;
}

export interface FailSegmentInput extends AttemptFence {
  readonly code: WorkflowFailureCode;
  readonly message: string;
  readonly detail?: RecordedValue | undefined;
}

export interface DeliverWaitInput {
  readonly waitId: number;
  readonly event: RecordedValue;
  /**
   * The edge this node routes into once the wait is delivered.
   *
   * Required, and supplied by the caller rather than derived here, because the routing edge is a
   * property of the *pinned structure* and this repository does not read descriptors. An earlier
   * draft defaulted it to an empty string when it could not be found, which produced exactly the
   * thing the position union exists to forbid: a `routing` position naming no edge. The resolver
   * and startup recovery both already hold the pin, so neither has to guess.
   */
  readonly edgeId: string;
}

export interface WaitDelivery {
  readonly wait: WorkflowWaitRecord;
  /**
   * What the delivery did to the *run*, which is a different question from what it did to the wait.
   *
   * `advanced` — the run is ready to route. `late_evidence` — a terminal run kept the event and
   * moved nowhere. `held` — the run is blocked on an operation nobody can account for, so the event
   * is recorded and the wait is delivered, but the run does not resume: answering one gate is not
   * evidence about a different effect.
   */
  readonly outcome: 'advanced' | 'late_evidence' | 'held';
}

export interface ControlInput {
  readonly runId: number;
  readonly controlRevision: number;
}

/**
 * Resume is a *prepared* control, and two separate things can have moved under it.
 *
 * The control revision orders it against other controls. It does not say the run is still parked
 * where the caller reconciled it, and it says nothing at all about whether the destination still
 * exists — a worktree can be deleted without any control being applied. So Resume carries both the
 * position it was prepared against and accepts a live placement check, and a failure of either
 * leaves pin, position, state, pause intervals, revisions and history exactly as they were.
 */
export interface ResumeInput extends ControlInput {
  readonly expectedPosition: WorkflowRunPosition;
}

export interface AdoptRetryPinInput extends ControlInput {
  readonly artifactHash: string;
  /** The failed position the decision was prepared against, rechecked before adoption. */
  readonly expectedPosition: WorkflowRunPosition;
  readonly expectedOwner: string | null;
}

export interface DiagnosticInput {
  readonly runId: number;
  readonly kind: 'log' | 'ui_feedback';
  readonly detail: RecordedValue;
  readonly frameId?: number | null;
  readonly executionId?: number | null;
  readonly attemptId?: number | null;
}

export interface SegmentIdentity {
  readonly frameId: number;
  readonly executionId: number | null;
  readonly segmentKind: WorkflowSegmentKind;
  readonly segmentRef: string | null;
}

export interface WorkflowRunsRepositoryService {
  // --- lifecycle ------------------------------------------------------------
  readonly createRun: (
    input: CreateRunInput,
  ) => Effect.Effect<
    WorkflowWriteResult<{ run: WorkflowRunRecord; frame: WorkflowFrameRecord }>,
    DatabaseError | PayloadPublishError
  >;
  readonly claimSegment: (
    input: ClaimSegmentInput,
  ) => Effect.Effect<WorkflowWriteResult<ClaimedSegment>, DatabaseError | PayloadPublishError>;

  // --- attempt-ownership commits -------------------------------------------
  readonly commitGraphEntry: (
    input: CommitGraphEntryInput,
  ) => Effect.Effect<
    WorkflowWriteResult<SegmentCommitOutcome>,
    DatabaseError | PayloadPublishError
  >;
  readonly enterSubgraph: (
    input: EnterSubgraphInput,
  ) => Effect.Effect<WorkflowWriteResult<{ childFrameId: number }>, DatabaseError>;
  readonly commitNodeResult: (
    input: CommitNodeResultInput,
  ) => Effect.Effect<
    WorkflowWriteResult<SegmentCommitOutcome>,
    DatabaseError | PayloadPublishError
  >;
  readonly commitRouting: (
    input: CommitRoutingInput,
  ) => Effect.Effect<
    WorkflowWriteResult<SegmentCommitOutcome>,
    DatabaseError | PayloadPublishError
  >;
  readonly publishChildOutput: (
    input: PublishChildOutputInput,
  ) => Effect.Effect<
    WorkflowWriteResult<SegmentCommitOutcome>,
    DatabaseError | PayloadPublishError
  >;
  readonly commitOutputMapping: (
    input: CommitOutputMappingInput,
  ) => Effect.Effect<
    WorkflowWriteResult<SegmentCommitOutcome>,
    DatabaseError | PayloadPublishError
  >;
  readonly completeRun: (
    input: CompleteRunInput,
  ) => Effect.Effect<
    WorkflowWriteResult<SegmentCommitOutcome>,
    DatabaseError | PayloadPublishError
  >;
  readonly failSegment: (
    input: FailSegmentInput,
  ) => Effect.Effect<
    WorkflowWriteResult<SegmentCommitOutcome>,
    DatabaseError | PayloadPublishError
  >;

  /**
   * Records the producer's result *before* reduction is attempted.
   *
   * Separate from the commit on purpose: the whole point is that it survives a reduction that then
   * fails, a crash with no failure code at all, and any number of later attempts.
   */
  readonly captureProducerOutput: (
    input: AttemptFence & {
      readonly producerOutput: RecordedValue;
      readonly producerArtifactHash: string;
    },
    /** True when this call wrote the operand; false when an earlier capture already held it. */
  ) => Effect.Effect<WorkflowWriteResult<boolean>, DatabaseError | PayloadPublishError>;

  /** The saved operand for a segment, if any prior attempt produced one. */
  readonly findProducerOutput: (
    segment: SegmentIdentity,
  ) => Effect.Effect<
    { readonly slot: PayloadSlot; readonly producerArtifactHash: string | null } | null,
    DatabaseError
  >;

  // --- waits ----------------------------------------------------------------
  readonly deliverWait: (
    input: DeliverWaitInput,
  ) => Effect.Effect<WorkflowWriteResult<WaitDelivery>, DatabaseError | PayloadPublishError>;
  readonly consumeHumanWait: (
    input: DeliverWaitInput,
  ) => Effect.Effect<WorkflowWriteResult<WaitDelivery>, DatabaseError | PayloadPublishError>;
  readonly supersedeWait: (input: {
    readonly waitId: number;
    readonly lateEvent?: RecordedValue | undefined;
  }) => Effect.Effect<WorkflowWriteResult<WorkflowWaitRecord>, DatabaseError | PayloadPublishError>;

  // --- controls -------------------------------------------------------------
  readonly applyPause: (
    input: ControlInput,
  ) => Effect.Effect<WorkflowWriteResult<void>, DatabaseError>;
  readonly applyResume: (
    input: ResumeInput,
  ) => Effect.Effect<WorkflowWriteResult<void>, DatabaseError>;
  readonly applyCancel: (
    input: ControlInput,
  ) => Effect.Effect<WorkflowWriteResult<void>, DatabaseError>;
  readonly adoptRetryPin: (
    input: AdoptRetryPinInput,
  ) => Effect.Effect<WorkflowWriteResult<void>, DatabaseError>;
  /** `detached: false` means the run had no attachment left, which is a repeat rather than a fault. */
  readonly detachRun: (
    input: ControlInput,
  ) => Effect.Effect<WorkflowWriteResult<{ readonly detached: boolean }>, DatabaseError>;

  // --- recovery -------------------------------------------------------------
  readonly parkUnfinishedRuns: (input: {
    readonly now?: string;
  }) => Effect.Effect<readonly number[], DatabaseError>;
  /**
   * Records that the environment under these runs went away, or came back.
   *
   * One transaction per run does everything that fact implies: the dispatch gate, the pause band
   * where there is one to open, and the history that makes any of it visible. They were three
   * separate operations before, and the gap between them was reachable — a crash after the gate was
   * lowered left a run undispatchable with nothing on record, and the next startup saw the gate
   * already lowered and moved on, so the run stayed silently stuck forever.
   *
   * Idempotent by the state it is asserting rather than by a caller-side filter: a run already
   * recorded as parked for a missing environment is left alone, so one absence never draws two
   * bands, while a run whose gate is down with no pause to explain it is repaired.
   *
   * Returns the runs this call actually changed.
   */
  readonly applyEnvironmentAvailability: (input: {
    readonly runIds: readonly number[];
    readonly available: boolean;
    readonly detail?: RecordedValue | undefined;
  }) => Effect.Effect<readonly number[], DatabaseError | PayloadPublishError>;
  readonly blockRun: (input: {
    readonly runId: number;
    readonly operationId: number;
  }) => Effect.Effect<WorkflowWriteResult<{ blocked: boolean }>, DatabaseError>;

  readonly appendDiagnostic: (
    input: DiagnosticInput,
  ) => Effect.Effect<WorkflowWriteResult<void>, DatabaseError | PayloadPublishError>;

  // --- reads ----------------------------------------------------------------
  readonly findRun: (runId: number) => Effect.Effect<WorkflowRunRecord | null, DatabaseError>;
  readonly listDispatchable: () => Effect.Effect<readonly WorkflowRunRecord[], DatabaseError>;
  readonly listNonTerminal: () => Effect.Effect<readonly WorkflowRunRecord[], DatabaseError>;
  readonly listByDestinationWorktree: (
    worktreeId: number,
  ) => Effect.Effect<readonly WorkflowRunRecord[], DatabaseError>;
  readonly listByDestinationWorktrees: (
    worktreeIds: readonly number[],
  ) => Effect.Effect<readonly WorkflowRunRecord[], DatabaseError>;
  readonly listByDestinationSurface: (
    surfaceId: number,
  ) => Effect.Effect<readonly WorkflowRunRecord[], DatabaseError>;
  readonly findAttachment: (
    runId: number,
  ) => Effect.Effect<WorkflowRunAttachmentRecord | null, DatabaseError>;
  readonly findFrame: (frameId: number) => Effect.Effect<WorkflowFrameRecord | null, DatabaseError>;
  readonly listFrames: (
    runId: number,
  ) => Effect.Effect<readonly WorkflowFrameRecord[], DatabaseError>;
  /** Root-to-leaf frames that a saved-position check has to validate. */
  readonly listActiveFrames: (
    runId: number,
  ) => Effect.Effect<readonly WorkflowFrameRecord[], DatabaseError>;
  readonly findExecution: (
    executionId: number,
  ) => Effect.Effect<WorkflowExecutionRecord | null, DatabaseError>;
  readonly listExecutions: (
    frameId: number,
  ) => Effect.Effect<readonly WorkflowExecutionRecord[], DatabaseError>;
  readonly findAttempt: (
    attemptId: number,
  ) => Effect.Effect<WorkflowAttemptRecord | null, DatabaseError>;
  readonly listAttemptsForSegment: (
    segment: SegmentIdentity,
  ) => Effect.Effect<readonly WorkflowAttemptRecord[], DatabaseError>;
  readonly listAttemptsForFrame: (
    frameId: number,
  ) => Effect.Effect<readonly WorkflowAttemptRecord[], DatabaseError>;
  readonly findWait: (waitId: number) => Effect.Effect<WorkflowWaitRecord | null, DatabaseError>;
  readonly listArmedWaits: (
    runId?: number,
  ) => Effect.Effect<readonly WorkflowWaitRecord[], DatabaseError>;
  /**
   * Every wait a node visit armed, newest last.
   *
   * The router needs it because a `routing` position names an edge, not a wait: the wait that
   * delivered the event is found by asking the execution what it armed, rather than by widening the
   * position union with an id only one of its arrival paths would ever carry.
   */
  readonly listWaitsForExecution: (
    executionId: number,
  ) => Effect.Effect<readonly WorkflowWaitRecord[], DatabaseError>;
  readonly listPauseIntervals: (
    runId: number,
  ) => Effect.Effect<readonly WorkflowPauseIntervalRecord[], DatabaseError>;
  readonly listVersionAdoptions: (
    runId: number,
  ) => Effect.Effect<readonly WorkflowVersionAdoptionRecord[], DatabaseError>;
}

export const WorkflowRunsRepository = Context.GenericTag<WorkflowRunsRepositoryService>(
  'isagi/WorkflowRunsRepository',
);

export const WorkflowRunsRepositoryLive = Layer.effect(
  WorkflowRunsRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const payloads = yield* WorkflowPayloadStore;
    const wake = yield* WorkflowWriteWake;
    return makeWorkflowRunsRepository(database, payloads, wake);
  }),
);

/**
 * The repository, independent of how its dependencies are provided.
 *
 * Every write below goes through one named transaction. That is deliberate: the invariants here are
 * not the interpreter's happy path to maintain. Attempt allocation has exactly one entry point, a
 * claim and its attempt share one transaction, a producer's result is durable before anything tries
 * to reduce it, and the four guard classes decide independently whether a write applies. An engine
 * built on top of this cannot accidentally create a second attempt or drop an outcome, because it
 * is never given the opportunity.
 */
export function makeWorkflowRunsRepository(
  runtimeDatabase: Pick<
    import('../../persistence/index.js').RuntimeDatabaseService,
    'use' | 'transaction'
  >,
  payloads: WorkflowPayloadStoreService,
  /** Told that a write finished, never what it wrote. Defaults to nobody listening. */
  wake: WorkflowWriteWakeService = silentWriteWake,
): WorkflowRunsRepositoryService {
  // Every transaction below goes through this handle, so the delta publisher is woken by the fact
  // that a write happened rather than by each write site remembering to say so.
  const database = wakingDatabase(runtimeDatabase, wake);
  /**
   * Publishes a recorded value ahead of the transaction that will reference it.
   *
   * This is the publication barrier, and it is here rather than at each call site so it cannot be
   * forgotten: bytes are durable before any row points at them. The reverse — a committed reference
   * to bytes that were never written — is the failure this ordering exists to make impossible. A
   * database failure after a successful publication leaves an unreferenced payload, which is
   * acceptable garbage.
   */
  const publish = (recorded: RecordedValue | undefined | null) =>
    recorded === undefined || recorded === null
      ? Effect.succeed(null)
      : payloads.publish(recorded.value);

  const findRunRow = (db: RuntimeDrizzleDatabase, runId: number) =>
    db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();

  return {
    createRun: (input) =>
      Effect.gen(function* () {
        const parameters = yield* publish(input.rootFrame.parameters);
        return yield* database.transaction('workflow_create_run', (db) => {
          const now = new Date().toISOString();

          if (input.attachment?.surfaceId != null) {
            const occupant = db
              .select({ runId: workflowRunAttachments.runId })
              .from(workflowRunAttachments)
              .where(eq(workflowRunAttachments.surfaceId, input.attachment.surfaceId))
              .get();
            // Checked rather than left to the unique index so the caller gets the occupying run
            // instead of a constraint violation. The index still backs it under a race.
            if (occupant) return rejected<never>({ kind: 'surface_busy', runId: occupant.runId });
          }

          // The run and its root frame reference each other, so one of them is written first with a
          // placeholder. `terminal` is the honest placeholder — it names no segment — and it is
          // overwritten later in this same transaction, so no reader ever observes it.
          const runRow = db
            .insert(workflowRuns)
            .values({
              workflowKey: input.workflowKey,
              title: input.title,
              rootGraphKey: input.rootGraphKey,
              artifactHash: input.artifactHash,
              status: 'ready',
              positionJson: encodeRunPosition({ kind: 'terminal' }),
              originWorktreeId: input.origin.worktreeId,
              originWorktreePath: input.origin.worktreePath,
              originSurfaceId: input.origin.surfaceId,
              originPaneId: input.origin.paneId,
              originAgentSessionId: input.origin.agentSessionId,
              destinationWorktreeId: input.destination.worktreeId,
              destinationWorktreePath: input.destination.worktreePath,
              destinationSurfaceId: input.destination.surfaceId,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();

          const parameterColumns = slotColumns(parameters);
          const frameRow = db
            .insert(workflowGraphFrames)
            .values({
              runId: runRow.id,
              parentExecutionId: null,
              graphKey: input.rootFrame.graphKey,
              entryArtifactHash: input.artifactHash,
              depth: 0,
              status: 'initializing',
              displayName: normalizeDisplayName(input.rootFrame.displayName),
              parametersInline: parameterColumns.inline,
              parametersRef: parameterColumns.ref,
              enteredAt: now,
            })
            .returning()
            .get();

          const position: WorkflowRunPosition = { kind: 'graph_entry', frameId: frameRow.id };
          db.update(workflowRuns)
            .set({ positionJson: encodeRunPosition(position), activeFrameId: frameRow.id })
            .where(eq(workflowRuns.id, runRow.id))
            .run();

          if (input.attachment) {
            db.insert(workflowRunAttachments)
              .values({
                runId: runRow.id,
                worktreeId: input.attachment.worktreeId,
                surfaceId: input.attachment.surfaceId,
                attachedAt: now,
              })
              .run();
          }

          db.insert(workflowVersionAdoptions)
            .values({
              runId: runRow.id,
              artifactHash: input.artifactHash,
              reason: 'launch',
              attemptId: null,
              adoptedAt: now,
            })
            .run();

          const transitions = appendTransitions(
            db,
            runRow.id,
            [
              {
                kind: 'run_started',
                frameId: frameRow.id,
                artifactHash: input.artifactHash,
              },
            ],
            now,
          );

          const run = runRecord(findRunRow(db, runRow.id)!);
          return committed({ run, frame: frameRecord(frameRow) }, transitions);
        });
      }),

    claimSegment: (input) =>
      Effect.gen(function* () {
        // Published before the transaction opens, like every other recorded value. A claim that is
        // then rejected leaves an unreferenced payload, which is acceptable garbage; the reverse —
        // an allocated attempt referencing bytes that were never written — is what this ordering
        // makes impossible.
        const composedInput = yield* publish(input.input);
        return yield* database.transaction('workflow_claim_segment', (db) => {
          const now = new Date().toISOString();
          const row = findRunRow(db, input.runId);
          if (!row) return rejected<never>({ kind: 'run_not_found' });
          if (row.controlRevision !== input.controlRevision) {
            return rejected<never>({
              kind: 'control_revision_changed',
              controlRevision: row.controlRevision,
            });
          }
          if (row.status !== 'ready')
            return rejected<never>({ kind: 'not_claimable', reason: 'status' });
          if (row.paused) return rejected<never>({ kind: 'not_claimable', reason: 'paused' });
          if (row.cancelRequested) {
            return rejected<never>({ kind: 'not_claimable', reason: 'cancel_requested' });
          }
          if (!row.environmentAvailable) {
            return rejected<never>({ kind: 'not_claimable', reason: 'environment_unavailable' });
          }
          // The live re-check. `environment_available` is a cache for cheap filtering, never the
          // authority: a missed deletion notification costs one rejected claim here rather than a
          // callback running against a worktree that is gone. Reading the owner's rows is read
          // composition; this repository never writes them.
          if (!placementIsLive(db, row.destinationWorktreeId, row.destinationSurfaceId)) {
            return rejected<never>({ kind: 'not_claimable', reason: 'placement_missing' });
          }

          const run = runRecord(row);

          // The prepared input is checked before anything is allocated, so a stale preparation costs
          // one rejected claim and leaves no attempt, no ownership, no pending invocation kind and no
          // history behind.
          if (encodeRunPosition(run.position) !== encodeRunPosition(input.preparation.position)) {
            return rejected<never>({ kind: 'position_mismatch' });
          }
          if (run.artifactHash !== input.preparation.artifactHash) {
            return rejected<never>({ kind: 'stale_preparation', source: 'artifact_hash' });
          }
          for (const source of input.preparation.frameStates) {
            const frame = db
              .select()
              .from(workflowGraphFrames)
              .where(eq(workflowGraphFrames.id, source.frameId))
              .get();
            const current = frame
              ? slotFromColumns('workflow_graph_frames.state', frame.stateInline, frame.stateRef)
              : null;
            if (!frame || frame.runId !== run.id || !sameSlot(current, source.state)) {
              return rejected<never>({ kind: 'stale_preparation', source: 'frame_state' });
            }
          }

          const segment = segmentFromPosition(run.position);
          if (!segment) {
            return rejected<never>({ kind: 'not_claimable', reason: 'position_not_executable' });
          }

          const priorAttempts = countAttemptsForSegment(db, segment);
          const attemptIndex = priorAttempts + 1;
          // Derived, never carried by one flag: only Retry can announce itself in advance, and an
          // adopted Retry has to win even across a restart, which is why the pending kind is consulted
          // before the attempt count.
          const invocationKind: WorkflowInvocationKind =
            row.pendingInvocationKind === 'retry'
              ? 'retry'
              : attemptIndex > 1
                ? 'resumed'
                : 'initial';

          const inputColumns = slotColumns(composedInput);
          const attemptRow = db
            .insert(workflowSegmentAttempts)
            .values({
              runId: run.id,
              frameId: segment.frameId,
              executionId: segment.executionId,
              segmentKind: segment.segmentKind,
              segmentRef: segment.segmentRef,
              attemptIndex,
              artifactHash: run.artifactHash,
              status: 'running',
              invocationKind,
              startedAt: now,
              endCertainty: 'observed',
              // Written once, with the attempt, and never rewritten. A later retry allocates its own
              // attempt with its own input, so what each try was actually given stays inspectable.
              inputInline: inputColumns.inline,
              inputRef: inputColumns.ref,
            })
            .returning()
            .get();

          db.update(workflowRuns)
            .set({
              status: 'running',
              owner: input.owner,
              ownerIncarnation: input.ownerIncarnation,
              activeAttemptId: attemptRow.id,
              pendingInvocationKind: null,
              updatedAt: now,
            })
            .where(eq(workflowRuns.id, run.id))
            .run();

          if (segment.executionId !== null) {
            db.update(workflowNodeExecutions)
              .set({ status: executionStatusForSegment(segment.segmentKind) })
              .where(eq(workflowNodeExecutions.id, segment.executionId))
              .run();
          }

          const transitions = appendTransitions(
            db,
            run.id,
            [
              {
                kind: 'node_dispatched',
                frameId: segment.frameId,
                executionId: segment.executionId,
                attemptId: attemptRow.id,
                artifactHash: run.artifactHash,
              },
            ],
            now,
          );

          return committed(
            { run: runRecord(findRunRow(db, run.id)!), attempt: attemptRecord(attemptRow) },
            transitions,
          );
        });
      }),

    commitGraphEntry: (input) =>
      Effect.gen(function* () {
        const parameters = yield* publish(input.parameters);
        const state = yield* publish(input.state);
        return yield* ownedCommit(database, 'workflow_commit_graph_entry', input, (db, ctx) => {
          const parameterColumns = slotColumns(parameters);
          const stateColumns = slotColumns(state);
          db.update(workflowGraphFrames)
            .set({
              status: 'active',
              ...(parameters
                ? { parametersInline: parameterColumns.inline, parametersRef: parameterColumns.ref }
                : {}),
              stateInline: stateColumns.inline,
              stateRef: stateColumns.ref,
              ...(input.frameDisplayName === undefined
                ? {}
                : { displayName: normalizeDisplayName(input.frameDisplayName) }),
            })
            .where(eq(workflowGraphFrames.id, input.frameId))
            .run();

          const execution = createExecution(db, {
            runId: ctx.run.id,
            frameId: input.frameId,
            nodeId: input.entryNode.nodeId,
            nodeKind: input.entryNode.nodeKind,
            displayName: input.entryNode.displayName ?? null,
            now: ctx.now,
          });

          finishAttempt(db, ctx, 'succeeded');
          setPosition(db, ctx.run.id, {
            position: { kind: 'node_callback', frameId: input.frameId, executionId: execution.id },
            activeFrameId: input.frameId,
            status: 'ready',
            now: ctx.now,
          });

          return {
            value: 'advanced' as SegmentCommitOutcome,
            drafts: [
              {
                kind: 'graph_entered' as const,
                frameId: input.frameId,
                // The entry node's first visit is created *by* this transition, so the transition
                // names it. Without that identity the visit would exist with nothing in history
                // pointing at it, and a client recovering by revision would never learn it was
                // dispatched — the frame's entry is the one place a node execution is born with no
                // attempt of its own to name it.
                executionId: execution.id,
                attemptId: ctx.attempt.id,
                artifactHash: ctx.attempt.artifactHash,
                state,
              },
            ],
          };
        });
      }),

    enterSubgraph: (input) =>
      database.transaction('workflow_enter_subgraph', (db) => {
        const now = new Date().toISOString();
        const row = findRunRow(db, input.runId);
        if (!row) return rejected<never>({ kind: 'run_not_found' });
        if (row.controlRevision !== input.controlRevision) {
          return rejected<never>({
            kind: 'control_revision_changed',
            controlRevision: row.controlRevision,
          });
        }
        // The same dispatch gates a claim applies, in the same order, because this advances the run
        // exactly as a claim does. Pause means "no further dispatch", and entering a subgraph is a
        // dispatch — the only difference is that no author callback runs inside it.
        if (row.status !== 'ready')
          return rejected<never>({ kind: 'not_claimable', reason: 'status' });
        if (row.paused) return rejected<never>({ kind: 'not_claimable', reason: 'paused' });
        if (row.cancelRequested) {
          return rejected<never>({ kind: 'not_claimable', reason: 'cancel_requested' });
        }
        if (!row.environmentAvailable) {
          return rejected<never>({ kind: 'not_claimable', reason: 'environment_unavailable' });
        }
        if (!placementIsLive(db, row.destinationWorktreeId, row.destinationSurfaceId)) {
          return rejected<never>({ kind: 'not_claimable', reason: 'placement_missing' });
        }

        const run = runRecord(row);
        if (
          encodeRunPosition(run.position) !== encodeRunPosition(input.expectedPosition) ||
          run.position.kind !== 'node_callback' ||
          run.position.executionId !== input.parentExecutionId
        ) {
          return rejected<never>({ kind: 'position_mismatch' });
        }
        // The registration was read from a pin. A Retry that repinned the run between the read and
        // this write must not open a frame for a subgraph the new structure may not declare.
        if (run.artifactHash !== input.artifactHash) {
          return rejected<never>({ kind: 'stale_preparation', source: 'artifact_hash' });
        }

        const parent = db
          .select()
          .from(workflowNodeExecutions)
          .where(eq(workflowNodeExecutions.id, input.parentExecutionId))
          .get();
        if (!parent || parent.runId !== run.id)
          return rejected<never>({ kind: 'position_mismatch' });
        const parentFrame = db
          .select()
          .from(workflowGraphFrames)
          .where(eq(workflowGraphFrames.id, parent.frameId))
          .get();
        if (!parentFrame || parentFrame.runId !== run.id) {
          return rejected<never>({ kind: 'position_mismatch' });
        }
        // One execution opens at most one child frame. A second frame under the same visit would
        // give the parent's mapping two candidate results and no rule for choosing between them.
        if (parent.childFrameId !== null) return rejected<never>({ kind: 'position_mismatch' });

        const childFrame = db
          .insert(workflowGraphFrames)
          .values({
            runId: run.id,
            parentExecutionId: parent.id,
            graphKey: input.childGraphKey,
            entryArtifactHash: run.artifactHash,
            depth: parentFrame.depth + 1,
            status: 'initializing',
            displayName: normalizeDisplayName(input.childDisplayName),
            enteredAt: now,
          })
          .returning()
          .get();

        db.update(workflowNodeExecutions)
          .set({ childFrameId: childFrame.id, status: 'running' })
          .where(eq(workflowNodeExecutions.id, parent.id))
          .run();

        setPosition(db, run.id, {
          position: { kind: 'graph_entry', frameId: childFrame.id },
          activeFrameId: childFrame.id,
          status: 'ready',
          now,
        });

        const transitions = appendTransitions(
          db,
          run.id,
          [
            {
              kind: 'node_dispatched',
              frameId: childFrame.id,
              executionId: parent.id,
              artifactHash: run.artifactHash,
            },
          ],
          now,
        );
        return committed({ childFrameId: childFrame.id }, transitions);
      }),

    commitNodeResult: (input) =>
      Effect.gen(function* () {
        const state = yield* publish(input.state);
        const producerOutput = yield* publish(input.producerOutput);
        const condition =
          input.next.kind === 'suspend' ? yield* publish(input.next.condition) : null;
        return yield* ownedCommit(
          database,
          'workflow_commit_node_result',
          input,
          (db, ctx) => {
            writeFrameState(db, input.frameId, state);
            captureProducer(db, ctx.attempt.id, producerOutput, input.producerArtifactHash);
            finishAttempt(db, ctx, 'succeeded');

            if (input.next.kind === 'routing') {
              db.update(workflowNodeExecutions)
                .set({ status: 'routing' })
                .where(eq(workflowNodeExecutions.id, input.executionId))
                .run();
              setPosition(db, ctx.run.id, {
                position: {
                  kind: 'routing',
                  frameId: input.frameId,
                  executionId: input.executionId,
                  edgeId: input.next.edgeId,
                },
                activeFrameId: input.frameId,
                status: 'ready',
                now: ctx.now,
              });
              return {
                value: 'advanced' as SegmentCommitOutcome,
                drafts: [
                  {
                    kind: 'state_reduced' as const,
                    frameId: input.frameId,
                    executionId: input.executionId,
                    attemptId: ctx.attempt.id,
                    artifactHash: ctx.attempt.artifactHash,
                    state,
                  },
                ],
              };
            }

            const conditionColumns = slotColumns(condition);
            const wait = db
              .insert(workflowWaits)
              .values({
                runId: ctx.run.id,
                executionId: input.executionId,
                waitKind: (input.next as { waitKind: WorkflowWaitKind }).waitKind,
                conditionInline: conditionColumns.inline,
                conditionRef: conditionColumns.ref,
                status: 'armed',
                armedAt: ctx.now,
              })
              .returning()
              .get();
            db.update(workflowNodeExecutions)
              .set({ status: 'awaiting' })
              .where(eq(workflowNodeExecutions.id, input.executionId))
              .run();
            setPosition(db, ctx.run.id, {
              position: {
                kind: 'awaiting_wait',
                frameId: input.frameId,
                executionId: input.executionId,
                waitId: wait.id,
              },
              activeFrameId: input.frameId,
              status: 'waiting',
              now: ctx.now,
            });
            return {
              value: 'advanced' as SegmentCommitOutcome,
              drafts: [
                {
                  kind: 'state_reduced' as const,
                  frameId: input.frameId,
                  executionId: input.executionId,
                  attemptId: ctx.attempt.id,
                  artifactHash: ctx.attempt.artifactHash,
                  state,
                },
                {
                  kind: 'wait_armed' as const,
                  frameId: input.frameId,
                  executionId: input.executionId,
                  attemptId: ctx.attempt.id,
                  waitId: wait.id,
                },
              ],
            };
          },
          { producerOutput, producerArtifactHash: input.producerArtifactHash },
        );
      }),

    commitRouting: (input) =>
      Effect.gen(function* () {
        const state = yield* publish(input.state);
        const producerOutput = yield* publish(input.producerOutput);
        return yield* ownedCommit(
          database,
          'workflow_commit_routing',
          input,
          (db, ctx) => {
            writeFrameState(db, input.frameId, state);
            captureProducer(db, ctx.attempt.id, producerOutput, input.producerArtifactHash);
            finishAttempt(db, ctx, 'succeeded');
            db.update(workflowNodeExecutions)
              .set({ status: 'completed', endedAt: ctx.now, endCertainty: 'observed' })
              .where(eq(workflowNodeExecutions.id, input.executionId))
              .run();
            if (input.waitId != null) {
              db.update(workflowWaits)
                .set({ status: 'consumed', consumedAt: ctx.now })
                .where(eq(workflowWaits.id, input.waitId))
                .run();
            }

            const drafts: TransitionDraft[] = [
              {
                kind: 'state_reduced',
                frameId: input.frameId,
                executionId: input.executionId,
                attemptId: ctx.attempt.id,
                artifactHash: ctx.attempt.artifactHash,
                state,
              },
            ];

            if (input.next.kind === 'node') {
              const execution = createExecution(db, {
                runId: ctx.run.id,
                frameId: input.frameId,
                nodeId: input.next.nodeId,
                nodeKind: input.next.nodeKind,
                displayName: input.next.displayName ?? null,
                now: ctx.now,
              });
              setPosition(db, ctx.run.id, {
                position: {
                  kind: 'node_callback',
                  frameId: input.frameId,
                  executionId: execution.id,
                },
                activeFrameId: input.frameId,
                status: 'ready',
                now: ctx.now,
              });
              drafts.push({
                kind: 'routed',
                frameId: input.frameId,
                executionId: execution.id,
                attemptId: ctx.attempt.id,
              });
            } else {
              setPosition(db, ctx.run.id, {
                position: {
                  kind: 'graph_output',
                  frameId: input.frameId,
                  outcomeId: input.next.outcomeId,
                },
                activeFrameId: input.frameId,
                status: 'ready',
                now: ctx.now,
              });
              drafts.push({
                kind: 'routed',
                frameId: input.frameId,
                executionId: input.executionId,
                attemptId: ctx.attempt.id,
              });
            }

            return { value: 'advanced' as SegmentCommitOutcome, drafts };
          },
          { producerOutput, producerArtifactHash: input.producerArtifactHash },
        );
      }),

    publishChildOutput: (input) =>
      Effect.gen(function* () {
        const output = yield* publish(input.output);
        return yield* ownedCommit(
          database,
          'workflow_publish_child_output',
          input,
          (db, ctx) => {
            const outputColumns = slotColumns(output);
            const frame = db
              .select()
              .from(workflowGraphFrames)
              .where(eq(workflowGraphFrames.id, input.frameId))
              .get();

            // Every check below runs before the first write. This transaction publishes a *child's*
            // output; a root's is `workflow_complete_run`, and letting a root through here would
            // complete its frame while leaving the run asking for an output it already has.
            const guard = guardOutputPublication(db, ctx, {
              frame,
              frameId: input.frameId,
              outcomeId: input.outcomeId,
              expected: 'child',
            });
            if (guard) return guard as WorkflowWriteResult<SegmentCommitOutcome>;

            db.update(workflowGraphFrames)
              .set({
                status: 'completed',
                outcomeId: input.outcomeId,
                outcomeKind: input.outcomeKind,
                outcomeReason: input.outcomeReason ?? null,
                outputInline: outputColumns.inline,
                outputRef: outputColumns.ref,
                // The pin that *produced* the value, which a reusing attempt carries forward
                // unchanged. Recording the committing attempt's pin here would falsify the
                // immutable completion fact the parent's mapping and router read.
                outputArtifactHash: input.outputArtifactHash,
                completedAt: ctx.now,
              })
              .where(eq(workflowGraphFrames.id, input.frameId))
              .run();
            captureProducer(db, ctx.attempt.id, output, input.outputArtifactHash);
            finishAttempt(db, ctx, 'succeeded');

            const parent = db
              .select()
              .from(workflowNodeExecutions)
              .where(eq(workflowNodeExecutions.id, frame!.parentExecutionId!))
              .get()!;
            db.update(workflowNodeExecutions)
              .set({ status: 'mapping' })
              .where(eq(workflowNodeExecutions.id, parent.id))
              .run();
            setPosition(db, ctx.run.id, {
              position: {
                kind: 'child_output_mapping',
                frameId: parent.frameId,
                executionId: parent.id,
                childFrameId: input.frameId,
              },
              activeFrameId: parent.frameId,
              status: 'ready',
              now: ctx.now,
            });
            return {
              value: 'advanced' as SegmentCommitOutcome,
              drafts: [
                {
                  kind: 'graph_completed' as const,
                  frameId: input.frameId,
                  attemptId: ctx.attempt.id,
                  artifactHash: input.outputArtifactHash,
                },
                {
                  kind: 'child_output_published' as const,
                  frameId: parent.frameId,
                  executionId: parent.id,
                  attemptId: ctx.attempt.id,
                },
              ],
            };
          },
          { producerOutput: output, producerArtifactHash: input.outputArtifactHash },
        );
      }),

    commitOutputMapping: (input) =>
      Effect.gen(function* () {
        const state = yield* publish(input.state);
        const producerOutput = yield* publish(input.producerOutput);
        return yield* ownedCommit(
          database,
          'workflow_commit_output_mapping',
          input,
          (db, ctx) => {
            writeFrameState(db, input.parentFrameId, state);
            captureProducer(db, ctx.attempt.id, producerOutput, input.producerArtifactHash);
            finishAttempt(db, ctx, 'succeeded');
            db.update(workflowNodeExecutions)
              .set({ status: 'routing' })
              .where(eq(workflowNodeExecutions.id, input.parentExecutionId))
              .run();
            setPosition(db, ctx.run.id, {
              position: {
                kind: 'routing',
                frameId: input.parentFrameId,
                executionId: input.parentExecutionId,
                edgeId: input.edgeId,
              },
              activeFrameId: input.parentFrameId,
              status: 'ready',
              now: ctx.now,
            });
            return {
              value: 'advanced' as SegmentCommitOutcome,
              drafts: [
                {
                  kind: 'output_mapped' as const,
                  frameId: input.parentFrameId,
                  executionId: input.parentExecutionId,
                  attemptId: ctx.attempt.id,
                  state,
                },
              ],
            };
          },
          { producerOutput, producerArtifactHash: input.producerArtifactHash },
        );
      }),

    completeRun: (input) =>
      Effect.gen(function* () {
        const output = yield* publish(input.output);
        return yield* ownedCommit(
          database,
          'workflow_complete_run',
          input,
          (db, ctx) => {
            const outputColumns = slotColumns(output);
            const frame = db
              .select()
              .from(workflowGraphFrames)
              .where(eq(workflowGraphFrames.id, input.frameId))
              .get();

            // The mirror of the child guard, and equally load-bearing: completing the run from a
            // child frame would strand every ancestor frame open and publish a nested graph's
            // output as the whole run's.
            const guard = guardOutputPublication(db, ctx, {
              frame,
              frameId: input.frameId,
              outcomeId: input.outcomeId,
              expected: 'root',
            });
            if (guard) return guard as WorkflowWriteResult<SegmentCommitOutcome>;

            db.update(workflowGraphFrames)
              .set({
                status: 'completed',
                outcomeId: input.outcomeId,
                outcomeKind: input.outcomeKind,
                outcomeReason: input.outcomeReason ?? null,
                outputInline: outputColumns.inline,
                outputRef: outputColumns.ref,
                outputArtifactHash: input.outputArtifactHash,
                completedAt: ctx.now,
              })
              .where(eq(workflowGraphFrames.id, input.frameId))
              .run();
            captureProducer(db, ctx.attempt.id, output, input.outputArtifactHash);
            finishAttempt(db, ctx, 'succeeded');
            db.update(workflowRuns)
              .set({
                status: 'done',
                outcomeId: input.outcomeId,
                outcomeKind: input.outcomeKind,
                outputInline: outputColumns.inline,
                outputRef: outputColumns.ref,
                positionJson: encodeRunPosition({ kind: 'terminal' }),
                activeFrameId: null,
                endedAt: ctx.now,
                updatedAt: ctx.now,
              })
              .where(eq(workflowRuns.id, ctx.run.id))
              .run();
            const drafts: TransitionDraft[] = [
              {
                kind: 'graph_completed',
                frameId: input.frameId,
                attemptId: ctx.attempt.id,
                artifactHash: input.outputArtifactHash,
              },
              { kind: 'run_completed', frameId: input.frameId, attemptId: ctx.attempt.id },
            ];
            drafts.push(...closeOpenPause(db, ctx.run.id, ctx.now));
            return { value: 'advanced' as SegmentCommitOutcome, drafts };
          },
          { producerOutput: output, producerArtifactHash: input.outputArtifactHash },
        );
      }),

    failSegment: (input) =>
      Effect.gen(function* () {
        const detail = yield* publish(input.detail);
        return yield* ownedCommit(database, 'workflow_fail_segment', input, (db, ctx) => {
          const detailColumns = slotColumns(detail);
          db.update(workflowSegmentAttempts)
            .set({
              status: 'failed',
              endedAt: ctx.now,
              endCertainty: 'observed',
              failureCode: input.code,
              failureMessage: input.message,
              failureDetailInline: detailColumns.inline,
              failureDetailRef: detailColumns.ref,
            })
            .where(eq(workflowSegmentAttempts.id, ctx.attempt.id))
            .run();
          if (ctx.attempt.executionId !== null) {
            db.update(workflowNodeExecutions)
              .set({ status: 'failed', endedAt: ctx.now, endCertainty: 'observed' })
              .where(eq(workflowNodeExecutions.id, ctx.attempt.executionId))
              .run();
          }
          // Frame state, waits, operations and every prior attempt are untouched: a failed segment
          // is a place to resume from, not a reason to unwind what already committed.
          db.update(workflowRuns)
            .set({
              status: 'failed',
              owner: null,
              ownerIncarnation: null,
              activeAttemptId: null,
              failureCode: input.code,
              failureMessage: input.message,
              failureAttemptId: ctx.attempt.id,
              endedAt: ctx.now,
              updatedAt: ctx.now,
            })
            .where(eq(workflowRuns.id, ctx.run.id))
            .run();
          const drafts: TransitionDraft[] = [
            {
              kind: 'segment_failed',
              frameId: ctx.attempt.frameId,
              executionId: ctx.attempt.executionId,
              attemptId: ctx.attempt.id,
              artifactHash: ctx.attempt.artifactHash,
              detail,
            },
          ];
          drafts.push(...closeOpenPause(db, ctx.run.id, ctx.now));
          return { value: 'advanced' as SegmentCommitOutcome, drafts };
        });
      }),

    captureProducerOutput: (input) =>
      Effect.gen(function* () {
        const producerOutput = yield* publish(input.producerOutput);
        return yield* database.transaction('workflow_capture_producer_output', (db) => {
          const now = new Date().toISOString();
          const row = findRunRow(db, input.runId);
          if (!row) return rejected<boolean>({ kind: 'run_not_found' });
          const attempt = db
            .select()
            .from(workflowSegmentAttempts)
            .where(eq(workflowSegmentAttempts.id, input.attemptId))
            .get();
          // The same authorization every other attempt write uses. Recording is permitted after a
          // Cancel — what already happened is a fact, and forgetting it is what would force a
          // producer to run twice — but it is still only *this* worker, on *this* incarnation, that
          // may record what its own claimed attempt produced.
          if (
            !attempt ||
            attempt.status !== 'running' ||
            row.activeAttemptId !== attempt.id ||
            row.owner !== input.owner ||
            row.ownerIncarnation !== input.ownerIncarnation
          ) {
            return rejected<boolean>({ kind: 'attempt_not_owned' });
          }

          // Idempotent on the operand, not on the call: a repeat finds the first capture and
          // changes nothing — neither the bytes nor the producing pin — and allocates no second
          // revision. The original producer's pin is what any versioned fact derived from the value
          // has to name, so overwriting it is exactly the corruption this guards against.
          const captured = captureProducer(
            db,
            attempt.id,
            producerOutput,
            input.producerArtifactHash,
          );
          if (!captured) return committed(false, []);

          // Its own revision, atomically with the capture. Reading the attempt row directly is how
          // the interpreter recovers, but revision-based inspection recovery has no other way to
          // learn that this segment now carries a reusable operand — and that is precisely the fact
          // that decides whether a Retry re-runs the producer or resumes at reduction. A rollback
          // publishes nothing; a capture followed by a crash stays discoverable on its own.
          const transitions = appendTransitions(
            db,
            row.id,
            [
              {
                kind: 'producer_output_captured',
                frameId: attempt.frameId,
                executionId: attempt.executionId,
                attemptId: attempt.id,
                artifactHash: input.producerArtifactHash,
              },
            ],
            now,
          );
          return committed(true, transitions);
        });
      }),

    findProducerOutput: (segment) =>
      database.use('workflow_find_producer_output', (db) => {
        const rows = attemptsForSegmentQuery(db, segment)
          .orderBy(asc(workflowSegmentAttempts.id))
          .all();
        for (const row of rows) {
          const record = attemptRecord(row);
          // The first captured operand wins and is never invalidated: only a successful commit ends
          // a segment, so every path out of a failed or interrupted attempt keeps it.
          if (record.producerOutput) {
            return {
              slot: record.producerOutput,
              producerArtifactHash: record.producerArtifactHash,
            };
          }
        }
        return null;
      }),

    deliverWait: (input) =>
      deliverWaitInternal(database, payloads, 'workflow_deliver_wait', input, 'world'),
    consumeHumanWait: (input) =>
      deliverWaitInternal(database, payloads, 'workflow_consume_human_wait', input, 'operator'),

    supersedeWait: (input) =>
      Effect.gen(function* () {
        const lateEvent = yield* publish(input.lateEvent);
        return yield* database.transaction('workflow_supersede_wait', (db) => {
          const now = new Date().toISOString();
          const wait = db
            .select()
            .from(workflowWaits)
            .where(eq(workflowWaits.id, input.waitId))
            .get();
          if (!wait) return rejected<never>({ kind: 'run_not_found' });
          if (wait.status !== 'armed') {
            return rejected<never>({ kind: 'wait_already_resolved', status: wait.status });
          }
          const eventColumns = slotColumns(lateEvent);
          const updated = db
            .update(workflowWaits)
            .set({
              status: 'superseded',
              ...(lateEvent
                ? { eventInline: eventColumns.inline, eventRef: eventColumns.ref }
                : {}),
            })
            .where(eq(workflowWaits.id, input.waitId))
            .returning()
            .get();
          const transitions = appendTransitions(
            db,
            wait.runId,
            [
              {
                kind: 'wait_delivered',
                executionId: wait.executionId,
                waitId: wait.id,
                detail: lateEvent,
              },
            ],
            now,
          );
          return committed(waitRecord(updated), transitions);
        });
      }),

    applyPause: ({ runId, controlRevision }) =>
      database.transaction('workflow_apply_pause', (db) =>
        withControlFence(db, runId, controlRevision, (run, now) => {
          const drafts = openPause(db, run.id, 'control', now);
          db.update(workflowRuns)
            .set({ paused: true, controlRevision: run.controlRevision + 1, updatedAt: now })
            .where(eq(workflowRuns.id, run.id))
            .run();
          return { value: undefined as void, drafts };
        }),
      ),

    applyResume: (input) =>
      database.transaction('workflow_apply_resume', (db) =>
        withControlFence(db, input.runId, input.controlRevision, (run, now) => {
          // Checked before anything is written, and checked separately, because they fail for
          // different reasons and a caller has to be able to tell them apart: the destination is
          // gone, versus the run moved on since this Resume was prepared.
          //
          // Both halves of the environment gate are required. Live placement is the authority, but
          // the persisted flag is what the *claim* consults, so accepting a Resume while it is down
          // would lift the pause and hand the dispatcher a run it then refuses — a run left running
          // in name, undispatchable in fact, with nothing on record saying why. A stale flag is
          // corrected where it is derived, by startup re-derivation, not by the control that is
          // supposed to be honouring it.
          if (
            !run.environmentAvailable ||
            !placementIsLive(db, run.destination.worktreeId, run.destination.surfaceId)
          ) {
            return rejected<void>({
              kind: 'environment_unavailable',
              worktreeId: run.destination.worktreeId,
              surfaceId: run.destination.surfaceId,
            });
          }
          if (encodeRunPosition(run.position) !== encodeRunPosition(input.expectedPosition)) {
            return rejected<void>({ kind: 'position_mismatch' });
          }

          // A pause band and the control that ended it are two facts, and the waterfall needs both:
          // `pause_closed` bounds the band, `control_applied` says a person resumed rather than the
          // runtime deciding on its own.
          const drafts = [
            ...closeOpenPause(db, run.id, now),
            {
              kind: 'control_applied' as const,
              detail: { inline: JSON.stringify({ control: 'resume' }), ref: null },
            },
          ];
          db.update(workflowRuns)
            .set({ paused: false, controlRevision: run.controlRevision + 1, updatedAt: now })
            .where(eq(workflowRuns.id, run.id))
            .run();
          return { value: undefined as void, drafts };
        }),
      ),

    applyCancel: ({ runId, controlRevision }) =>
      database.transaction('workflow_apply_cancel', (db) =>
        withControlFence(db, runId, controlRevision, (run, now) => {
          const drafts = [
            ...closeOpenPause(db, run.id, now),
            {
              kind: 'control_applied' as const,
              detail: { inline: JSON.stringify({ control: 'cancel' }), ref: null },
            },
          ];
          db.update(workflowRuns)
            .set({
              cancelRequested: true,
              status: 'cancelled',
              controlRevision: run.controlRevision + 1,
              endedAt: now,
              updatedAt: now,
            })
            .where(eq(workflowRuns.id, run.id))
            .run();
          return { value: undefined as void, drafts };
        }),
      ),

    adoptRetryPin: (input) =>
      database.transaction('workflow_adopt_retry_pin', (db) =>
        withControlFence(db, input.runId, input.controlRevision, (run, now) => {
          // Retry adoption is additionally fenced on the exact failed position and the same
          // ownership it was prepared against, so a run that moved on cannot be repinned by a stale
          // decision.
          if (
            encodeRunPosition(run.position) !== encodeRunPosition(input.expectedPosition) ||
            run.owner !== input.expectedOwner
          ) {
            return rejected<void>({ kind: 'position_mismatch' });
          }
          db.insert(workflowVersionAdoptions)
            .values({
              runId: run.id,
              artifactHash: input.artifactHash,
              reason: 'retry',
              attemptId: null,
              adoptedAt: now,
            })
            .run();
          db.update(workflowRuns)
            .set({
              artifactHash: input.artifactHash,
              status: 'ready',
              failureCode: null,
              failureMessage: null,
              failureAttemptId: null,
              endedAt: null,
              controlRevision: run.controlRevision + 1,
              // No attempt is allocated here. The next claim stamps it, so a crash between adoption
              // and dispatch leaves an ordinary ready run with a new pin rather than a half-owned
              // attempt.
              pendingInvocationKind: 'retry',
              updatedAt: now,
            })
            .where(eq(workflowRuns.id, run.id))
            .run();

          const drafts: TransitionDraft[] = [
            { kind: 'retry_pin_adopted', artifactHash: input.artifactHash },
            {
              kind: 'control_applied',
              detail: { inline: JSON.stringify({ control: 'retry' }), ref: null },
            },
          ];
          // Adoption is not a Resume. A run that was paused when it failed stays paused, and its
          // band re-opens here because the terminal transition that closed it has been undone.
          if (run.paused) drafts.unshift(...openPause(db, run.id, 'control', now));
          return { value: undefined as void, drafts };
        }),
      ),

    detachRun: ({ runId, controlRevision }) =>
      database.transaction('workflow_detach_run', (db) =>
        withControlFence(db, runId, controlRevision, (run, now) => {
          // Dismiss releases a *finished* run's placement. An active run has to be cancelled first:
          // detaching it would take the surface back while the work carried on, which is the one
          // outcome the retention policy calls dishonest. Checked here rather than only in the
          // control layer so no caller can reach the write without it.
          if (!isTerminal(run.status)) {
            return rejected<{ readonly detached: boolean }>({
              kind: 'run_active',
              status: run.status,
            });
          }
          const attachment = db
            .select()
            .from(workflowRunAttachments)
            .where(eq(workflowRunAttachments.runId, run.id))
            .get();
          // A repeat Dismiss is inert: it reports that the run is already detached and writes
          // nothing, so a retried request cannot fill the waterfall with controls that changed
          // nothing.
          if (!attachment) return { value: { detached: false }, drafts: [] };

          db.delete(workflowRunAttachments).where(eq(workflowRunAttachments.runId, run.id)).run();
          db.update(workflowRuns)
            .set({ controlRevision: run.controlRevision + 1, updatedAt: now })
            .where(eq(workflowRuns.id, run.id))
            .run();
          return {
            value: { detached: true },
            drafts: [
              {
                kind: 'control_applied' as const,
                detail: { inline: JSON.stringify({ control: 'dismiss' }), ref: null },
              },
            ],
          };
        }),
      ),

    parkUnfinishedRuns: () =>
      database.transaction('workflow_park_unfinished_runs', (db) => {
        const now = new Date().toISOString();
        const rows = db
          .select()
          .from(workflowRuns)
          .where(inArray(workflowRuns.status, ['ready', 'running', 'waiting', 'blocked']))
          .all();
        const parked: number[] = [];
        for (const row of rows) {
          // No owner predicate: clearing ownership is what this is *for*. A previous incarnation's
          // claim is exactly what has to be released.
          const drafts = openPause(db, row.id, 'runtime_restart', now);
          if (row.activeAttemptId !== null) {
            const attempt = db
              .select()
              .from(workflowSegmentAttempts)
              .where(eq(workflowSegmentAttempts.id, row.activeAttemptId))
              .get();
            if (attempt?.status === 'running') {
              // Interrupted, not failed: nobody observed how it ended, and inventing an end would
              // be a claim the runtime cannot support. Its recorded operands stay inspectable and
              // reusable.
              db.update(workflowSegmentAttempts)
                .set({ status: 'interrupted', endCertainty: 'unknown' })
                .where(eq(workflowSegmentAttempts.id, attempt.id))
                .run();
              if (attempt.executionId !== null) {
                db.update(workflowNodeExecutions)
                  .set({ endCertainty: 'unknown' })
                  .where(eq(workflowNodeExecutions.id, attempt.executionId))
                  .run();
              }
            }
          }
          db.update(workflowRuns)
            .set({
              paused: true,
              owner: null,
              ownerIncarnation: null,
              activeAttemptId: null,
              status: row.status === 'running' ? 'ready' : row.status,
              updatedAt: now,
            })
            .where(eq(workflowRuns.id, row.id))
            .run();
          appendTransitions(
            db,
            row.id,
            [
              ...drafts,
              {
                kind: 'control_applied',
                detail: {
                  inline: JSON.stringify({ control: 'runtime_restart', parked: true }),
                  ref: null,
                },
              },
            ],
            now,
          );
          parked.push(row.id);
        }
        return parked;
      }),

    applyEnvironmentAvailability: (input) =>
      Effect.gen(function* () {
        const detail = yield* publish(input.detail);
        return yield* database.transaction('workflow_apply_environment_availability', (db) => {
          const now = new Date().toISOString();
          const changed: number[] = [];
          for (const runId of input.runIds) {
            const row = findRunRow(db, runId);
            if (!row) continue;
            const control = input.available ? 'environment_restored' : 'environment_deleted';
            const recordedDetail = detail ?? {
              inline: JSON.stringify({ control }),
              ref: null,
            };

            if (input.available) {
              // Restoration lifts nothing on its own. A run paused because its environment vanished
              // stays paused until a person resumes it: the runtime learning that a worktree is back
              // is not the same as a person asking for the work to continue. The gate flag and the
              // recorded fact are all that change.
              if (row.environmentAvailable) continue;
              db.update(workflowRuns)
                .set({ environmentAvailable: true, updatedAt: now })
                .where(eq(workflowRuns.id, runId))
                .run();
              appendTransitions(
                db,
                runId,
                [{ kind: 'control_applied', detail: recordedDetail }],
                now,
              );
              changed.push(runId);
              continue;
            }

            if (isTerminal(row.status)) {
              // A stopped run is not parked — there is nothing left to gate — but the loss is still
              // recorded. Its attachment has already cascaded away, and a run that never transitions
              // again would otherwise keep reporting a surface that no longer exists.
              if (!row.environmentAvailable) continue;
              db.update(workflowRuns)
                .set({ environmentAvailable: false, updatedAt: now })
                .where(eq(workflowRuns.id, runId))
                .run();
              appendTransitions(
                db,
                runId,
                [{ kind: 'control_applied', detail: recordedDetail }],
                now,
              );
              changed.push(runId);
              continue;
            }

            // Already parked for this absence: nothing to say, and nothing to draw twice.
            if (!row.environmentAvailable && row.paused) continue;

            const drafts = openPause(db, runId, 'environment_deleted', now);
            db.update(workflowRuns)
              .set({ paused: true, environmentAvailable: false, updatedAt: now })
              .where(eq(workflowRuns.id, runId))
              .run();
            appendTransitions(
              db,
              runId,
              [...drafts, { kind: 'control_applied', detail: recordedDetail }],
              now,
            );
            changed.push(runId);
          }
          return changed;
        });
      }),

    blockRun: (input) =>
      database.transaction('workflow_block_run', (db) => {
        const now = new Date().toISOString();
        const row = findRunRow(db, input.runId);
        if (!row) return rejected<never>({ kind: 'run_not_found' });
        // The operation and its diagnostic are recorded either way. Only the *status* is gated:
        // reconciliation legitimately finds uncertainty on a cancelled run, and that uncertainty
        // belongs on the operation rather than resurrecting the run.
        const blocked = !isTerminal(row.status);
        if (blocked) {
          db.update(workflowRuns)
            .set({ status: 'blocked', blockedOperationId: input.operationId, updatedAt: now })
            .where(eq(workflowRuns.id, row.id))
            .run();
        } else {
          db.update(workflowRuns)
            .set({ blockedOperationId: input.operationId, updatedAt: now })
            .where(eq(workflowRuns.id, row.id))
            .run();
        }
        const transitions = appendTransitions(
          db,
          row.id,
          [{ kind: 'run_blocked', operationId: input.operationId }],
          now,
        );
        return committed({ blocked }, transitions);
      }),

    appendDiagnostic: (input) =>
      Effect.gen(function* () {
        const detail = yield* publish(input.detail);
        return yield* database.transaction('workflow_append_diagnostic', (db) => {
          const now = new Date().toISOString();
          const row = findRunRow(db, input.runId);
          if (!row) return rejected<void>({ kind: 'run_not_found' });
          // Fenced only on the run existing. A diagnostic written just before a callback failure —
          // or after a Cancel — is exactly the one worth keeping, so no guard may discard it.
          const transitions = appendTransitions(
            db,
            row.id,
            [
              {
                kind: input.kind,
                frameId: input.frameId ?? null,
                executionId: input.executionId ?? null,
                attemptId: input.attemptId ?? null,
                detail,
              },
            ],
            now,
          );
          return committed<void>(undefined, transitions);
        });
      }),

    findRun: (runId) =>
      database.use('workflow_find_run', (db) => {
        const row = findRunRow(db, runId);
        return row ? runRecord(row) : null;
      }),

    listDispatchable: () =>
      database.use('workflow_list_dispatchable', (db) =>
        db
          .select()
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.status, 'ready'),
              eq(workflowRuns.paused, false),
              eq(workflowRuns.cancelRequested, false),
              eq(workflowRuns.environmentAvailable, true),
            ),
          )
          .orderBy(asc(workflowRuns.id))
          .all()
          .map(runRecord),
      ),

    listNonTerminal: () =>
      database.use('workflow_list_non_terminal', (db) =>
        db
          .select()
          .from(workflowRuns)
          .where(inArray(workflowRuns.status, ['ready', 'running', 'waiting', 'blocked']))
          .orderBy(asc(workflowRuns.id))
          .all()
          .map(runRecord),
      ),

    listByDestinationWorktree: (worktreeId) =>
      database.use('workflow_list_by_destination_worktree', (db) =>
        db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.destinationWorktreeId, worktreeId))
          .all()
          .map(runRecord),
      ),

    listByDestinationWorktrees: (worktreeIds) =>
      database.use('workflow_list_by_destination_worktrees', (db) =>
        worktreeIds.length === 0
          ? []
          : db
              .select()
              .from(workflowRuns)
              .where(inArray(workflowRuns.destinationWorktreeId, [...worktreeIds]))
              .all()
              .map(runRecord),
      ),

    listByDestinationSurface: (surfaceId) =>
      database.use('workflow_list_by_destination_surface', (db) =>
        db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.destinationSurfaceId, surfaceId))
          .all()
          .map(runRecord),
      ),

    findAttachment: (runId) =>
      database.use('workflow_find_attachment', (db) => {
        const row = db
          .select()
          .from(workflowRunAttachments)
          .where(eq(workflowRunAttachments.runId, runId))
          .get();
        return row ? attachmentRecord(row) : null;
      }),

    findFrame: (frameId) =>
      database.use('workflow_find_frame', (db) => {
        const row = db
          .select()
          .from(workflowGraphFrames)
          .where(eq(workflowGraphFrames.id, frameId))
          .get();
        return row ? frameRecord(row) : null;
      }),

    listFrames: (runId) =>
      database.use('workflow_list_frames', (db) =>
        db
          .select()
          .from(workflowGraphFrames)
          .where(eq(workflowGraphFrames.runId, runId))
          .orderBy(asc(workflowGraphFrames.id))
          .all()
          .map(frameRecord),
      ),

    listActiveFrames: (runId) =>
      database.use('workflow_list_active_frames', (db) =>
        db
          .select()
          .from(workflowGraphFrames)
          .where(
            and(eq(workflowGraphFrames.runId, runId), ne(workflowGraphFrames.status, 'completed')),
          )
          .orderBy(asc(workflowGraphFrames.depth), asc(workflowGraphFrames.id))
          .all()
          .map(frameRecord),
      ),

    findExecution: (executionId) =>
      database.use('workflow_find_execution', (db) => {
        const row = db
          .select()
          .from(workflowNodeExecutions)
          .where(eq(workflowNodeExecutions.id, executionId))
          .get();
        return row ? executionRecord(row) : null;
      }),

    listExecutions: (frameId) =>
      database.use('workflow_list_executions', (db) =>
        db
          .select()
          .from(workflowNodeExecutions)
          .where(eq(workflowNodeExecutions.frameId, frameId))
          .orderBy(asc(workflowNodeExecutions.id))
          .all()
          .map(executionRecord),
      ),

    findAttempt: (attemptId) =>
      database.use('workflow_find_attempt', (db) => {
        const row = db
          .select()
          .from(workflowSegmentAttempts)
          .where(eq(workflowSegmentAttempts.id, attemptId))
          .get();
        return row ? attemptRecord(row) : null;
      }),

    listAttemptsForSegment: (segment) =>
      database.use('workflow_list_segment_attempts', (db) =>
        attemptsForSegmentQuery(db, segment)
          .orderBy(asc(workflowSegmentAttempts.attemptIndex))
          .all()
          .map(attemptRecord),
      ),

    listAttemptsForFrame: (frameId) =>
      database.use('workflow_list_frame_attempts', (db) =>
        db
          .select()
          .from(workflowSegmentAttempts)
          .where(eq(workflowSegmentAttempts.frameId, frameId))
          .orderBy(asc(workflowSegmentAttempts.id))
          .all()
          .map(attemptRecord),
      ),

    findWait: (waitId) =>
      database.use('workflow_find_wait', (db) => {
        const row = db.select().from(workflowWaits).where(eq(workflowWaits.id, waitId)).get();
        return row ? waitRecord(row) : null;
      }),

    listWaitsForExecution: (executionId) =>
      database.use('workflow_list_waits_for_execution', (db) =>
        db
          .select()
          .from(workflowWaits)
          .where(eq(workflowWaits.executionId, executionId))
          .orderBy(asc(workflowWaits.id))
          .all()
          .map(waitRecord),
      ),

    listArmedWaits: (runId) =>
      database.use('workflow_list_armed_waits', (db) =>
        db
          .select()
          .from(workflowWaits)
          .where(
            runId === undefined
              ? eq(workflowWaits.status, 'armed')
              : and(eq(workflowWaits.status, 'armed'), eq(workflowWaits.runId, runId)),
          )
          .orderBy(asc(workflowWaits.id))
          .all()
          .map(waitRecord),
      ),

    listPauseIntervals: (runId) =>
      database.use('workflow_list_pause_intervals', (db) =>
        db
          .select()
          .from(workflowPauseIntervals)
          .where(eq(workflowPauseIntervals.runId, runId))
          .orderBy(asc(workflowPauseIntervals.id))
          .all()
          .map(pauseIntervalRecord),
      ),

    listVersionAdoptions: (runId) =>
      database.use('workflow_list_version_adoptions', (db) =>
        db
          .select()
          .from(workflowVersionAdoptions)
          .where(eq(workflowVersionAdoptions.runId, runId))
          .orderBy(asc(workflowVersionAdoptions.id))
          .all()
          .map(versionAdoptionRecord),
      ),
  } satisfies WorkflowRunsRepositoryService;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type TransactionalDatabase = Pick<
  import('../../persistence/index.js').RuntimeDatabaseService,
  'use' | 'transaction'
>;

interface OwnedContext {
  readonly run: WorkflowRunRecord;
  readonly attempt: WorkflowAttemptRecord;
  readonly now: string;
}

interface CommitPlan<A> {
  readonly value: A;
  readonly drafts: readonly TransitionDraft[];
}

/**
 * The attempt-ownership fence and the cancel gate, applied once for every commit that records what
 * the currently claimed attempt did.
 *
 * Two things are deliberately separate here. **Whether this worker may record** is the fence: the
 * attempt must still be running, still be the run's active attempt, and still be held by this owner
 * and this runtime incarnation. **Whether the graph advances** is one further read of
 * `cancel_requested` inside the same transaction.
 *
 * `paused` is *not* consulted. Pause gates the next claim; an in-flight callback keeps its
 * permission to reach its durable boundary, and revision guards have no say at all — an already
 * claimed attempt's outcome is structurally incapable of being dropped because a newer control
 * arrived while it was running.
 */
function ownedCommit<A>(
  database: TransactionalDatabase,
  operation: string,
  fence: AttemptFence,
  advance: (
    db: RuntimeDrizzleDatabase,
    ctx: OwnedContext,
  ) => CommitPlan<A> | WorkflowWriteResult<A>,
  cancelledEvidence?: {
    readonly producerOutput: PayloadSlot | null;
    readonly producerArtifactHash: string;
  },
): Effect.Effect<WorkflowWriteResult<A>, DatabaseError> {
  return database.transaction(operation, (db) => {
    const now = new Date().toISOString();
    const row = db.select().from(workflowRuns).where(eq(workflowRuns.id, fence.runId)).get();
    if (!row) return rejected<A>({ kind: 'run_not_found' });
    const attemptRow = db
      .select()
      .from(workflowSegmentAttempts)
      .where(eq(workflowSegmentAttempts.id, fence.attemptId))
      .get();
    if (
      !attemptRow ||
      attemptRow.status !== 'running' ||
      row.activeAttemptId !== attemptRow.id ||
      row.owner !== fence.owner ||
      row.ownerIncarnation !== fence.ownerIncarnation
    ) {
      return rejected<A>({ kind: 'attempt_not_owned' });
    }

    const ctx: OwnedContext = {
      run: runRecord(row),
      attempt: attemptRecord(attemptRow),
      now,
    };

    if (row.cancelRequested) {
      // Cancel revokes permission to advance, never permission to record. The candidate result is
      // kept on the attempt as cancelled-attempt evidence, no state is reduced, no position moves,
      // and the run stays cancelled.
      if (cancelledEvidence) {
        captureProducer(
          db,
          ctx.attempt.id,
          cancelledEvidence.producerOutput,
          cancelledEvidence.producerArtifactHash,
        );
      }
      db.update(workflowSegmentAttempts)
        .set({ status: 'cancelled', endedAt: now, endCertainty: 'observed' })
        .where(eq(workflowSegmentAttempts.id, ctx.attempt.id))
        .run();
      db.update(workflowRuns)
        .set({ activeAttemptId: null, owner: null, ownerIncarnation: null, updatedAt: now })
        .where(eq(workflowRuns.id, ctx.run.id))
        .run();
      const transitions = appendTransitions(
        db,
        ctx.run.id,
        [
          {
            kind: 'control_applied',
            frameId: ctx.attempt.frameId,
            executionId: ctx.attempt.executionId,
            attemptId: ctx.attempt.id,
            detail: {
              inline: JSON.stringify({ control: 'cancel', effect: 'attempt_cancelled' }),
              ref: null,
            },
          },
        ],
        now,
      );
      return committed('cancelled_evidence' as unknown as A, transitions);
    }

    const plan = advance(db, ctx);
    // A plan may refuse instead of proceeding. Every such check runs before the plan writes
    // anything, so a refusal leaves the frame, run, attempt, position, pause intervals and history
    // exactly as they were — the transaction simply has nothing to roll back.
    if ('ok' in plan) return plan;
    const transitions = appendTransitions(db, ctx.run.id, plan.drafts, now);
    return committed(plan.value, transitions);
  });
}

/**
 * The checks both output-publication transactions share, run before either writes anything.
 *
 * Three separate questions, because they fail for different reasons and a caller has to be able to
 * tell them apart:
 *
 * 1. **Run membership.** The frame exists and belongs to this run. A frame id from another run is
 *    not a position this attempt may publish.
 * 2. **Saved position.** The run is actually parked at `graph_output` on *this* frame for *this*
 *    outcome. Attempt ownership says a worker holds the run; it does not say the run is still
 *    asking for the thing being published.
 * 3. **Frame role, checked reciprocally.** A child frame names a parent execution, that execution
 *    exists, belongs to this run, and points back at this frame. A one-way non-null parent id is
 *    not enough: a dangling or mismatched link would let a frame be mapped into a parent that never
 *    invoked it.
 *
 * Returns a rejection, or `null` to proceed.
 */
function guardOutputPublication(
  db: RuntimeDrizzleDatabase,
  ctx: OwnedContext,
  input: {
    readonly frame: typeof workflowGraphFrames.$inferSelect | undefined;
    readonly frameId: number;
    readonly outcomeId: string;
    readonly expected: 'root' | 'child';
  },
): WorkflowWriteResult<never> | null {
  const frame = input.frame;
  if (!frame || frame.runId !== ctx.run.id) return rejected({ kind: 'position_mismatch' });

  const position = ctx.run.position;
  if (
    position.kind !== 'graph_output' ||
    position.frameId !== input.frameId ||
    position.outcomeId !== input.outcomeId
  ) {
    return rejected({ kind: 'position_mismatch' });
  }

  const isRoot = frame.parentExecutionId === null;
  if (isRoot !== (input.expected === 'root')) {
    return rejected({ kind: 'frame_role_mismatch', expected: input.expected });
  }
  if (isRoot) return null;

  const parent = db
    .select()
    .from(workflowNodeExecutions)
    .where(eq(workflowNodeExecutions.id, frame.parentExecutionId!))
    .get();
  if (!parent || parent.runId !== ctx.run.id || parent.childFrameId !== frame.id) {
    return rejected({ kind: 'frame_role_mismatch', expected: 'child' });
  }
  return null;
}

/**
 * The control-revision fence: authorization to act on a decision prepared from asynchronously read
 * state.
 *
 * Artifact resolution, structural validation and reconciliation all happen outside the transaction,
 * so a newer Pause, Cancel or Retry has to win over a stale prepared action. Bumping the revision is
 * what makes duplicate commands unable to create two live attempts for one position.
 */
function withControlFence<A>(
  db: RuntimeDrizzleDatabase,
  runId: number,
  controlRevision: number,
  apply: (run: WorkflowRunRecord, now: string) => CommitPlan<A> | WorkflowWriteResult<A>,
): WorkflowWriteResult<A> {
  const now = new Date().toISOString();
  const row = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
  if (!row) return rejected<A>({ kind: 'run_not_found' });
  if (row.controlRevision !== controlRevision) {
    return rejected<A>({ kind: 'control_revision_changed', controlRevision: row.controlRevision });
  }
  const outcome = apply(runRecord(row), now);
  if ('ok' in outcome) return outcome;
  const transitions = appendTransitions(db, runId, outcome.drafts, now);
  return committed(outcome.value, transitions);
}

/**
 * Wait delivery, fenced on the wait's own identity.
 *
 * Delivery arrives whenever the world produces it — long after the attempt that armed the wait has
 * closed, sometimes after the runtime restarted. So the guard is the wait row and nothing else, and
 * it is monotonic: a duplicate delivery is a no-op rather than a conflict, which is what lets the
 * dispatcher, the resolver and startup recovery all call this safely.
 *
 * The event is recorded unconditionally. Whether the run *advances* is a separate question answered
 * by whether the run is still non-terminal: a cancelled, done or failed run keeps its status and
 * position and takes the event as late evidence.
 */
/**
 * Who is delivering: the world, or a person.
 *
 * The difference decides what happens to a blocked run. An external event is evidence and is always
 * recorded; an operator's answer is an action, and one that cannot take effect must not silently
 * consume the gate it was aimed at.
 */
type DeliverySource = 'world' | 'operator';

function deliverWaitInternal(
  database: TransactionalDatabase,
  payloads: WorkflowPayloadStoreService,
  operation: string,
  input: DeliverWaitInput,
  source: DeliverySource,
) {
  return Effect.gen(function* () {
    const event = yield* payloads.publish(input.event.value);
    return yield* database.transaction(operation, (db) => {
      const now = new Date().toISOString();
      const wait = db.select().from(workflowWaits).where(eq(workflowWaits.id, input.waitId)).get();
      if (!wait) return rejected<WaitDelivery>({ kind: 'run_not_found' });
      if (wait.status !== 'armed') {
        return rejected<WaitDelivery>({ kind: 'wait_already_resolved', status: wait.status });
      }
      const blockedRow = db
        .select({ status: workflowRuns.status, blocked: workflowRuns.blockedOperationId })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, wait.runId))
        .get();
      // Read and refused inside the transaction, so a run that becomes blocked between a caller's
      // check and this write cannot slip an answer through — and one that is already blocked cannot
      // have its gate quietly consumed by an answer nothing will ever act on.
      if (source === 'operator' && blockedRow?.status === 'blocked') {
        return rejected<WaitDelivery>({
          kind: 'run_blocked',
          blockedOperationId: blockedRow.blocked,
        });
      }
      const eventColumns = slotColumns(event);
      const updated = db
        .update(workflowWaits)
        .set({
          status: 'delivered',
          deliveredAt: now,
          eventInline: eventColumns.inline,
          eventRef: eventColumns.ref,
        })
        .where(eq(workflowWaits.id, wait.id))
        .returning()
        .get();

      const row = db.select().from(workflowRuns).where(eq(workflowRuns.id, wait.runId)).get()!;
      const drafts: TransitionDraft[] = [
        {
          kind: 'wait_delivered',
          executionId: wait.executionId,
          waitId: wait.id,
          detail: event,
        },
      ];

      // A blocked run holds an external effect whose outcome nobody established. Resuming it
      // because an *unrelated* gate was answered would be exactly the operator assertion the design
      // refuses: the wait is real and its event is recorded, but the block is the run's own
      // obligation and only settling that operation — or Cancel — discharges it.
      const held = row.status === 'blocked';
      const advances = row.status === 'waiting';
      if (advances) {
        const execution = db
          .select()
          .from(workflowNodeExecutions)
          .where(eq(workflowNodeExecutions.id, wait.executionId))
          .get()!;
        db.update(workflowNodeExecutions)
          .set({ status: 'routing' })
          .where(eq(workflowNodeExecutions.id, execution.id))
          .run();
        // Readiness is unconditional: `paused` gates the dispatcher's claim, not the status, so a
        // wait that resolves during a pause reaches `ready` and simply waits for the gate to lift
        // rather than stranding at `waiting`.
        db.update(workflowRuns)
          .set({
            status: 'ready',
            positionJson: encodeRunPosition({
              kind: 'routing',
              frameId: execution.frameId,
              executionId: execution.id,
              edgeId: input.edgeId,
            }),
            updatedAt: now,
          })
          .where(eq(workflowRuns.id, row.id))
          .run();
      }

      const transitions = appendTransitions(db, row.id, drafts, now);
      return committed<WaitDelivery>(
        {
          wait: waitRecord(updated),
          outcome: advances
            ? ('advanced' as const)
            : held
              ? ('held' as const)
              : ('late_evidence' as const),
        },
        transitions,
      );
    });
  });
}

/** The run's *current* segment, derived from its saved position. */
function segmentFromPosition(position: WorkflowRunPosition): SegmentIdentity | null {
  switch (position.kind) {
    case 'graph_entry':
      return {
        frameId: position.frameId,
        executionId: null,
        segmentKind: 'graph_entry',
        segmentRef: null,
      };
    case 'node_callback':
      return {
        frameId: position.frameId,
        executionId: position.executionId,
        segmentKind: 'node_callback',
        segmentRef: null,
      };
    case 'routing':
      return {
        frameId: position.frameId,
        executionId: position.executionId,
        segmentKind: 'routing',
        segmentRef: position.edgeId,
      };
    case 'graph_output':
      return {
        frameId: position.frameId,
        executionId: null,
        segmentKind: 'graph_output',
        segmentRef: position.outcomeId,
      };
    case 'child_output_mapping':
      return {
        frameId: position.frameId,
        executionId: position.executionId,
        segmentKind: 'output_mapping',
        segmentRef: null,
      };
    // A run parked on a wait or already finished has no segment to claim. Both are ordinary states,
    // which is why they reject the claim rather than being treated as corruption.
    case 'awaiting_wait':
    case 'terminal':
      return null;
  }
}

function executionStatusForSegment(kind: WorkflowSegmentKind) {
  switch (kind) {
    case 'routing':
      return 'routing' as const;
    case 'output_mapping':
      return 'mapping' as const;
    default:
      return 'running' as const;
  }
}

function attemptsForSegmentQuery(db: RuntimeDrizzleDatabase, segment: SegmentIdentity) {
  return db
    .select()
    .from(workflowSegmentAttempts)
    .where(
      and(
        eq(workflowSegmentAttempts.frameId, segment.frameId),
        segment.executionId === null
          ? isNull(workflowSegmentAttempts.executionId)
          : eq(workflowSegmentAttempts.executionId, segment.executionId),
        eq(workflowSegmentAttempts.segmentKind, segment.segmentKind),
        segment.segmentRef === null
          ? isNull(workflowSegmentAttempts.segmentRef)
          : eq(workflowSegmentAttempts.segmentRef, segment.segmentRef),
      ),
    );
}

function countAttemptsForSegment(db: RuntimeDrizzleDatabase, segment: SegmentIdentity): number {
  return attemptsForSegmentQuery(db, segment).all().length;
}

function createExecution(
  db: RuntimeDrizzleDatabase,
  input: {
    readonly runId: number;
    readonly frameId: number;
    readonly nodeId: string;
    readonly nodeKind: WorkflowNodeKind;
    readonly displayName: string | null;
    readonly now: string;
  },
) {
  // Zero-based: a first visit is 0, and a loop back to this node creates a new row rather than
  // reopening the old one. That is what keeps a definition node and an iteration of it distinct.
  const visitIndex = db
    .select()
    .from(workflowNodeExecutions)
    .where(
      and(
        eq(workflowNodeExecutions.frameId, input.frameId),
        eq(workflowNodeExecutions.nodeId, input.nodeId),
      ),
    )
    .all().length;
  return db
    .insert(workflowNodeExecutions)
    .values({
      runId: input.runId,
      frameId: input.frameId,
      nodeId: input.nodeId,
      nodeKind: input.nodeKind,
      visitIndex,
      status: 'running',
      displayName: normalizeDisplayName(input.displayName),
      startedAt: input.now,
      endCertainty: 'observed',
    })
    .returning()
    .get();
}

function writeFrameState(
  db: RuntimeDrizzleDatabase,
  frameId: number,
  state: PayloadSlot | null,
): void {
  const columns = slotColumns(state);
  db.update(workflowGraphFrames)
    .set({ stateInline: columns.inline, stateRef: columns.ref })
    .where(eq(workflowGraphFrames.id, frameId))
    .run();
}

/**
 * Writes the producer's operand and the pin that produced it.
 *
 * Never overwrites an existing capture: a later attempt that *reuses* a saved operand must keep the
 * original producer's pin, because that pin is what any versioned fact derived from the value has
 * to name.
 */
function captureProducer(
  db: RuntimeDrizzleDatabase,
  attemptId: number,
  producerOutput: PayloadSlot | null,
  producerArtifactHash: string,
): boolean {
  if (!producerOutput) return false;
  const existing = db
    .select()
    .from(workflowSegmentAttempts)
    .where(eq(workflowSegmentAttempts.id, attemptId))
    .get();
  if (!existing || existing.producerOutputInline !== null || existing.producerOutputRef !== null) {
    return false;
  }
  const columns = slotColumns(producerOutput);
  db.update(workflowSegmentAttempts)
    .set({
      producerOutputInline: columns.inline,
      producerOutputRef: columns.ref,
      producerArtifactHash,
    })
    .where(eq(workflowSegmentAttempts.id, attemptId))
    .run();
  return true;
}

function finishAttempt(db: RuntimeDrizzleDatabase, ctx: OwnedContext, status: 'succeeded'): void {
  db.update(workflowSegmentAttempts)
    .set({ status, endedAt: ctx.now, endCertainty: 'observed' })
    .where(eq(workflowSegmentAttempts.id, ctx.attempt.id))
    .run();
  db.update(workflowRuns)
    .set({ activeAttemptId: null, owner: null, ownerIncarnation: null, updatedAt: ctx.now })
    .where(eq(workflowRuns.id, ctx.run.id))
    .run();
}

function setPosition(
  db: RuntimeDrizzleDatabase,
  runId: number,
  input: {
    readonly position: WorkflowRunPosition;
    readonly activeFrameId: number | null;
    readonly status: 'ready' | 'waiting';
    readonly now: string;
  },
): void {
  db.update(workflowRuns)
    .set({
      positionJson: encodeRunPosition(input.position),
      activeFrameId: input.activeFrameId,
      status: input.status,
      updatedAt: input.now,
    })
    .where(eq(workflowRuns.id, runId))
    .run();
}

/**
 * Opens a pause band, or reports that one is already open.
 *
 * Idempotent by construction: repeated Pause, repeated environment parking and a restart that parks
 * an already-parked run all find the open interval and add nothing. A duplicated band would make
 * every derived pause duration wrong, and the partial unique index makes the invariant structural
 * rather than conventional.
 */
function openPause(
  db: RuntimeDrizzleDatabase,
  runId: number,
  reason: WorkflowPauseReason,
  now: string,
): TransitionDraft[] {
  const open = findOpenPause(db, runId);
  if (open) return [];
  db.insert(workflowPauseIntervals).values({ runId, reason, pausedAt: now }).run();
  return [{ kind: 'pause_opened', detail: { inline: JSON.stringify({ reason }), ref: null } }];
}

function closeOpenPause(db: RuntimeDrizzleDatabase, runId: number, now: string): TransitionDraft[] {
  const open = findOpenPause(db, runId);
  if (!open) return [];
  db.update(workflowPauseIntervals)
    .set({ resumedAt: now })
    .where(eq(workflowPauseIntervals.id, open.id))
    .run();
  return [
    {
      kind: 'pause_closed',
      detail: { inline: JSON.stringify({ reason: open.reason }), ref: null },
    },
  ];
}

function findOpenPause(db: RuntimeDrizzleDatabase, runId: number) {
  return db
    .select()
    .from(workflowPauseIntervals)
    .where(and(eq(workflowPauseIntervals.runId, runId), isNull(workflowPauseIntervals.resumedAt)))
    .get();
}

/**
 * A run that can no longer advance or authorize new work.
 *
 * Exported because the operation boundary asks the same question immediately before crossing an
 * external boundary, and two copies of "what counts as terminal" is exactly the drift that lets one
 * of them quietly fall behind.
 */
export function isTerminalRunStatus(status: WorkflowRunRecord['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

function isTerminal(status: WorkflowRunRecord['status']): boolean {
  return isTerminalRunStatus(status);
}

/**
 * Whether the run's destination still exists.
 *
 * Read-only composition over rows the surface and workspace services own: this repository never
 * writes them (ADR 0008). Checking live rather than trusting the cached flag is what makes a
 * dropped deletion notification cost one rejected claim instead of a callback running against a
 * worktree that is gone.
 */
function placementIsLive(
  db: RuntimeDrizzleDatabase,
  worktreeId: number | null,
  surfaceId: number | null,
): boolean {
  if (worktreeId !== null) {
    const worktree = db
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(eq(worktrees.id, worktreeId))
      .get();
    if (!worktree) return false;
  }
  if (surfaceId !== null) {
    const surface = db
      .select({ id: worktreeSurfaces.id })
      .from(worktreeSurfaces)
      .where(eq(worktreeSurfaces.id, surfaceId))
      .get();
    if (!surface) return false;
  }
  return true;
}

/** Content equality for a recorded slot, which is what makes a prepared operand checkable. */
function sameSlot(left: PayloadSlot | null, right: PayloadSlot | null): boolean {
  if (left === null || right === null) return left === right;
  return left.inline === right.inline && left.ref === right.ref;
}
