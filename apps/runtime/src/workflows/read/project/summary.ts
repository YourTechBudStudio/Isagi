import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type {
  WorkflowEnvironmentFailureDetail,
  WorkflowPlacement,
  WorkflowQuestionSpecDto,
  WorkflowRunControls,
  WorkflowRunSummary,
  WorkflowStopSummary,
  WorkflowUiFeedbackDto,
} from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../../persistence/database.service.js';
import {
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowOperations,
  workflowRunAttachments,
  workflowRunPreparations,
  workflowRuns,
  workflowSegmentAttempts,
  workflowTransitions,
  workflowVersionAdoptions,
  workflowWaits,
  worktreeSurfaces,
  worktrees,
} from '../../../persistence/schema.js';
import { CorruptRunPreparationError, preparationRecord } from '../../persistence/preparations.js';
import { runPosition } from '../../persistence/row-mappers.js';
import { slotFromColumns } from '../../persistence/slots.js';
import { decodeDiagnosticDetail, decodeEnvironmentFailureDetail } from './diagnostics.js';
import { columnSlotDto, inlineValue, isRecord } from './payloads.js';

type RunRow = typeof workflowRuns.$inferSelect;
type AttemptRow = typeof workflowSegmentAttempts.$inferSelect;
type RunPosition = ReturnType<typeof runPosition>;

/**
 * The run summary: where the run is now, what is holding it, and which controls the runtime will
 * actually accept.
 *
 * Availability is decided here rather than in the client, and rechecked at mutation time, so the bar
 * and the inspector cannot drift from the real preconditions. Everything else is a stored fact: the
 * summary never asks a session, a process or a loaded definition anything.
 */
export function projectSummary(
  db: RuntimeDrizzleDatabase,
  runId: number,
): WorkflowRunSummary | null {
  const row = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
  return row ? summaryDto(db, row) : null;
}

export function summaryDto(db: RuntimeDrizzleDatabase, row: RunRow): WorkflowRunSummary {
  const position = runPosition(row.id, row.positionJson);
  const attachment = db
    .select()
    .from(workflowRunAttachments)
    .where(eq(workflowRunAttachments.runId, row.id))
    .get();
  const rootFrame = db
    .select()
    .from(workflowGraphFrames)
    .where(
      and(eq(workflowGraphFrames.runId, row.id), isNull(workflowGraphFrames.parentExecutionId)),
    )
    .get();
  const blockingOperation =
    db
      .select()
      .from(workflowOperations)
      .where(and(eq(workflowOperations.runId, row.id), eq(workflowOperations.state, 'uncertain')))
      .orderBy(asc(workflowOperations.id))
      .get() ?? null;

  // Read once and shared: the run-level failure and the preparation's own failure detail are two
  // views of the same attempt, and reading it twice would let them disagree within one summary.
  const failingAttempt =
    row.failureAttemptId === null
      ? null
      : (db
          .select()
          .from(workflowSegmentAttempts)
          .where(eq(workflowSegmentAttempts.id, row.failureAttemptId))
          .get() ?? null);

  const activeExecutionId =
    position.kind === 'node_callback' ||
    position.kind === 'awaiting_wait' ||
    position.kind === 'routing' ||
    position.kind === 'child_output_mapping'
      ? position.executionId
      : null;

  return {
    runId: row.id,
    workflowKey: row.workflowKey,
    title: row.title,
    rootGraphKey: row.rootGraphKey,
    status: row.status,
    paused: row.paused,
    revision: row.revision,
    artifactHash: row.artifactHash,
    pinOrdinal: pinOrdinal(db, row.id),
    outcome:
      row.outcomeId === null || row.outcomeKind === null
        ? null
        : {
            outcomeId: row.outcomeId,
            kind: row.outcomeKind,
            reason: rootFrame?.outcomeReason ?? null,
            producedRef: columnSlotDto(db, 'workflow_runs.output', row.outputInline, row.outputRef),
          },
    position,
    activeNode: activeNode(db, activeExecutionId),
    blockingWait: blockingWait(db, position),
    blockedOperation:
      row.blockedOperationId === null ? null : operationRef(db, row.blockedOperationId),
    failure: failure(row, failingAttempt),
    stopSummary: stopSummary(db, row.id),
    uiFeedback: uiFeedback(db, row.id),
    attachment:
      attachment === undefined
        ? null
        : { worktreeId: attachment.worktreeId, surfaceId: attachment.surfaceId },
    origin: placement(db, {
      worktreeId: row.originWorktreeId,
      worktreePath: row.originWorktreePath,
      surfaceId: row.originSurfaceId,
      paneId: row.originPaneId,
      agentSessionId: row.originAgentSessionId,
    }),
    destination: placement(db, {
      worktreeId: row.destinationWorktreeId,
      worktreePath: row.destinationWorktreePath,
      surfaceId: row.destinationSurfaceId,
      paneId: null,
      agentSessionId: null,
    }),
    preparation: preparation(db, row, position, failingAttempt),
    controls: controls(db, row, {
      attached: attachment !== undefined,
      blockingOperation,
      position,
      destinationLive: placementIsLive(db, row.destinationWorktreeId, row.destinationSurfaceId),
      destinationWorktreeId: row.destinationWorktreeId,
      originWorktreeId: row.originWorktreeId,
    }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
  };
}

/** 1-based position of the current pin in this run's adoption history. */
function pinOrdinal(db: RuntimeDrizzleDatabase, runId: number): number {
  const row = db
    .select({ value: sql<number>`count(*)` })
    .from(workflowVersionAdoptions)
    .where(eq(workflowVersionAdoptions.runId, runId))
    .get();
  // A run always adopts at launch, so the history is never empty; the floor keeps the DTO's
  // positive-integer contract intact rather than emitting a zero nothing could render.
  return Math.max(1, row?.value ?? 1);
}

function activeNode(db: RuntimeDrizzleDatabase, executionId: number | null) {
  if (executionId === null) return null;
  const execution = db
    .select()
    .from(workflowNodeExecutions)
    .where(eq(workflowNodeExecutions.id, executionId))
    .get();
  if (!execution) return null;
  const frame = db
    .select({ graphKey: workflowGraphFrames.graphKey })
    .from(workflowGraphFrames)
    .where(eq(workflowGraphFrames.id, execution.frameId))
    .get();
  return {
    frameId: execution.frameId,
    graphKey: frame?.graphKey ?? '',
    nodeId: execution.nodeId,
    nodeKind: execution.nodeKind,
    executionId: execution.id,
    visitIndex: execution.visitIndex,
    displayName: execution.displayName,
  };
}

/** The wait the run is actually parked on — never a wait some other visit armed earlier. */
function blockingWait(
  db: RuntimeDrizzleDatabase,
  position: RunPosition,
): WorkflowRunSummary['blockingWait'] {
  if (position.kind !== 'awaiting_wait') return null;
  const wait = db.select().from(workflowWaits).where(eq(workflowWaits.id, position.waitId)).get();
  if (!wait) return null;
  const condition = inlineValue(
    'workflow_waits.condition',
    slotFromColumns('workflow_waits.condition', wait.conditionInline, wait.conditionRef),
  );
  return {
    waitId: wait.id,
    kind: wait.waitKind,
    label: isRecord(condition) && typeof condition.label === 'string' ? condition.label : null,
    frameId: position.frameId,
    executionId: position.executionId,
    questions:
      isRecord(condition) && Array.isArray(condition.questions)
        ? (condition.questions as readonly WorkflowQuestionSpecDto[])
        : null,
    armedAt: wait.armedAt,
  };
}

function operationRef(db: RuntimeDrizzleDatabase, operationId: number) {
  const operation = db
    .select()
    .from(workflowOperations)
    .where(eq(workflowOperations.id, operationId))
    .get();
  if (!operation) return null;
  return {
    operationKey: operation.operationKey,
    frameId: operation.frameId,
    executionId: operation.executionId,
  };
}

function failure(row: RunRow, attempt: AttemptRow | null): WorkflowRunSummary['failure'] {
  if (row.failureCode === null || attempt === null) return null;
  return {
    code: row.failureCode,
    message: row.failureMessage ?? '',
    segmentKind: attempt.segmentKind,
    attemptId: attempt.id,
    frameId: attempt.frameId,
    executionId: attempt.executionId,
  };
}

/**
 * How this run's destination was chosen, and what preparing it actually did.
 *
 * The row is total: `createRun` writes it in the same transaction as the run itself, so an absent
 * one is corruption rather than an operational state — the same posture `runPosition` takes for an
 * unreadable position, and for the same reason. A fabricated stand-in would report a placement
 * decision nobody made, on the one record a person consults to find out where their work went.
 */
function preparation(
  db: RuntimeDrizzleDatabase,
  row: RunRow,
  position: RunPosition,
  failingAttempt: AttemptRow | null,
): WorkflowRunSummary['preparation'] {
  const prepared = db
    .select()
    .from(workflowRunPreparations)
    .where(eq(workflowRunPreparations.runId, row.id))
    .get();
  if (prepared === undefined) {
    throw new CorruptRunPreparationError(
      row.id,
      'row',
      'no row exists, though createRun writes one in the same transaction as the run',
    );
  }
  const record = preparationRecord(prepared);
  const status = preparationStatus(row, position);
  return {
    source: record.source,
    request: record.request,
    baseCommit: record.baseCommit,
    status,
    worktree: record.worktree,
    setup: record.setup,
    surface: record.surface,
    // Only a failed preparation has a preparation failure to report. A run that failed later failed
    // at another segment, and its detail belongs to that segment rather than to this record.
    failure: status === 'failed' ? environmentFailure(failingAttempt) : null,
  };
}

/**
 * Derived from the run's own facts, and stored nowhere.
 *
 * Storing it would create a second authority that can disagree with the position — and the position
 * is what the engine actually acts on. Read top to bottom:
 *
 * - past the preparation position, the commit happened, so the environment is prepared, whatever
 *   the run went on to do afterwards. A run cancelled or failed an hour later still prepared;
 * - still at it and terminal, it never committed a destination, and the resting state is what the
 *   run holds forever. `pending` is deliberately unreachable for a terminal run: a cancelled
 *   preparation may hold a real worktree and must never read as "in progress";
 * - otherwise it can still move, which is the only honest meaning of `pending`.
 *
 * `done` at this position is **unreachable** — completing a run moves its position off the
 * preparation segment in the same transaction — and is folded into `failed` rather than given its
 * own branch because the contract has no fifth literal and "ended without ever committing a
 * destination" is what `failed` says here. It is not a claim that completed runs report as failed;
 * a completed run left this position long before it completed.
 */
function preparationStatus(
  row: RunRow,
  position: RunPosition,
): WorkflowRunSummary['preparation']['status'] {
  if (position.kind !== 'environment_preparation') return 'prepared';
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status === 'failed' || row.status === 'done') return 'failed';
  return 'pending';
}

/**
 * The failing attempt's own account of what preparation was doing when it stopped.
 *
 * Projected here so a client renders a preparation failure from the summary alone, without fetching
 * the attempt. Null when the failing attempt belongs to another segment, when there is no failing
 * attempt at all — a Retry interrupted between adopting its pin and claiming its attempt is failed
 * by startup recovery with nothing to blame, and is still retryable — or when the recorded detail
 * does not read back. All three are "no detail", never "no failure".
 */
function environmentFailure(attempt: AttemptRow | null): WorkflowEnvironmentFailureDetail | null {
  if (attempt === null || attempt.segmentKind !== 'environment_preparation') return null;
  const detail = inlineValue(
    'workflow_segment_attempts.failure_detail',
    slotFromColumns(
      'workflow_segment_attempts.failure_detail',
      attempt.failureDetailInline,
      attempt.failureDetailRef,
    ),
  );
  return decodeEnvironmentFailureDetail(detail);
}

/**
 * How much of a requested stop was actually observed.
 *
 * Null until something was asked to stop, because "nothing was requested" and "everything confirmed"
 * are different answers and a zeroed summary would read like the second.
 */
function stopSummary(db: RuntimeDrizzleDatabase, runId: number): WorkflowStopSummary | null {
  const rows = db
    .select({ stopState: workflowOperations.stopState })
    .from(workflowOperations)
    .where(eq(workflowOperations.runId, runId))
    .all();
  const summary = { requested: 0, confirmed: 0, failed: 0, unsupported: 0, pending: 0 };
  for (const row of rows) {
    if (row.stopState === 'not_requested') continue;
    summary.requested += 1;
    if (row.stopState === 'confirmed') summary.confirmed += 1;
    else if (row.stopState === 'failed') summary.failed += 1;
    else if (row.stopState === 'unsupported') summary.unsupported += 1;
    else summary.pending += 1;
  }
  return summary.requested === 0 ? null : summary;
}

function uiFeedback(db: RuntimeDrizzleDatabase, runId: number): WorkflowUiFeedbackDto | null {
  const row = db
    .select()
    .from(workflowTransitions)
    .where(and(eq(workflowTransitions.runId, runId), eq(workflowTransitions.kind, 'ui_feedback')))
    .orderBy(desc(workflowTransitions.revision))
    .get();
  if (!row) return null;
  const detail = inlineValue(
    'workflow_transitions.detail',
    slotFromColumns('workflow_transitions.detail', row.detailInline, row.detailRef),
  );
  const decoded = decodeDiagnosticDetail(detail);
  if (decoded?.source !== 'ui_feedback') return null;
  return {
    kind: decoded.kind,
    ...(decoded.phase === undefined ? {} : { phase: decoded.phase }),
    ...(decoded.message === undefined ? {} : { message: decoded.message }),
  };
}

/**
 * Retained placement, and whether what it names still exists.
 *
 * The identifiers are descriptive columns with no foreign key, so they outlive the rows they name;
 * `available` is read composition over the owner's tables, exactly as the engine's own environment
 * check reads them.
 */
function placement(
  db: RuntimeDrizzleDatabase,
  named: {
    readonly worktreeId: number | null;
    readonly worktreePath: string | null;
    readonly surfaceId: number | null;
    readonly paneId: number | null;
    readonly agentSessionId: number | null;
  },
): WorkflowPlacement {
  return { ...named, available: placementIsLive(db, named.worktreeId, named.surfaceId) };
}

function worktreeExists(db: RuntimeDrizzleDatabase, worktreeId: number): boolean {
  return db.select().from(worktrees).where(eq(worktrees.id, worktreeId)).get() !== undefined;
}

function placementIsLive(
  db: RuntimeDrizzleDatabase,
  worktreeId: number | null,
  surfaceId: number | null,
): boolean {
  if (worktreeId === null) return false;
  const worktree = db.select().from(worktrees).where(eq(worktrees.id, worktreeId)).get();
  if (!worktree) return false;
  if (surfaceId === null) return true;
  const surface = db
    .select()
    .from(worktreeSurfaces)
    .where(eq(worktreeSurfaces.id, surfaceId))
    .get();
  return surface !== undefined && surface.worktreeId === worktreeId;
}

/**
 * Which controls the runtime will accept right now.
 *
 * These mirror the preconditions the control layer enforces — and the write fences underneath it
 * re-check every one of them at mutation time, so a stale `true` here costs a rejection rather than
 * an unguarded write.
 */
function controls(
  db: RuntimeDrizzleDatabase,
  row: RunRow,
  context: {
    readonly attached: boolean;
    readonly blockingOperation: typeof workflowOperations.$inferSelect | null;
    readonly position: RunPosition;
    /** Whether the destination this run would resume into still exists. */
    readonly destinationLive: boolean;
    readonly destinationWorktreeId: number | null;
    /** Where the run was launched from. The only worktree a preparing run has. */
    readonly originWorktreeId: number | null;
  },
): WorkflowRunControls {
  const terminal = row.status === 'done' || row.status === 'failed' || row.status === 'cancelled';
  const preparing = context.position.kind === 'environment_preparation';
  // Retry resolves the latest verified version, which it can only do from a worktree — and a run
  // that has not committed a destination has only the one it was launched from. Same rule, read
  // against whichever worktree the run actually has.
  const retryWorktreeId = preparing ? context.originWorktreeId : context.destinationWorktreeId;
  const humanWait =
    context.position.kind === 'awaiting_wait'
      ? (db
          .select()
          .from(workflowWaits)
          .where(eq(workflowWaits.id, context.position.waitId))
          .get() ?? null)
      : null;
  return {
    // Parking a preparation would hand the run to a dispatcher that deliberately never claims this
    // segment, so the control refuses it and the flag says so rather than offering a dead action.
    pause: !terminal && !row.paused && !preparing,
    // Resume lifts a dispatch gate, so it needs somewhere to dispatch *into*. Both halves of the
    // environment gate the write enforces are mirrored here — the persisted availability flag the
    // claim consults, and live placement — because offering Resume for either half being down means
    // offering an action the runtime will refuse, and lifting a pause into a dispatcher that then
    // refuses the run is worse than not offering it at all.
    resume: !terminal && row.paused && row.environmentAvailable && context.destinationLive,
    // Unknown delivery is not overridable: a run holding an unresolved uncertainty cannot be
    // repinned around it, so Retry stays unavailable until that operation is accounted for.
    // Retry also has to resolve the latest verified version, which it can only do from a worktree —
    // but it does not need a surface, so this rule is narrower than Resume's on purpose.
    retry:
      (row.status === 'failed' || row.status === 'blocked') &&
      context.blockingOperation === null &&
      retryWorktreeId !== null &&
      worktreeExists(db, retryWorktreeId),
    cancel: !terminal,
    // Dismiss releases a stopped run's placement. Without an attachment there is nothing to release.
    dismiss: terminal && context.attached,
    advance:
      humanWait !== null &&
      humanWait.status === 'armed' &&
      (humanWait.waitKind === 'user_continue' || humanWait.waitKind === 'user_input') &&
      row.status !== 'blocked',
  };
}
