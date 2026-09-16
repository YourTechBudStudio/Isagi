import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type {
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
  workflowRuns,
  workflowSegmentAttempts,
  workflowTransitions,
  workflowVersionAdoptions,
  workflowWaits,
  worktreeSurfaces,
  worktrees,
} from '../../../persistence/schema.js';
import { runPosition } from '../../persistence/row-mappers.js';
import { slotFromColumns } from '../../persistence/slots.js';
import { columnSlotDto, inlineValue, isRecord } from './payloads.js';

type RunRow = typeof workflowRuns.$inferSelect;

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
    failure: failure(db, row),
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
    controls: controls(db, row, {
      attached: attachment !== undefined,
      blockingOperation,
      position,
      destinationLive: placementIsLive(db, row.destinationWorktreeId, row.destinationSurfaceId),
      destinationWorktreeId: row.destinationWorktreeId,
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
  position: ReturnType<typeof runPosition>,
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

function failure(db: RuntimeDrizzleDatabase, row: RunRow): WorkflowRunSummary['failure'] {
  if (row.failureCode === null || row.failureAttemptId === null) return null;
  const attempt = db
    .select()
    .from(workflowSegmentAttempts)
    .where(eq(workflowSegmentAttempts.id, row.failureAttemptId))
    .get();
  if (!attempt) return null;
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
  if (!isRecord(detail)) return null;
  return {
    ...(typeof detail.kind === 'string' && isFeedbackKind(detail.kind)
      ? { kind: detail.kind }
      : {}),
    ...(typeof detail.phase === 'string' ? { phase: detail.phase } : {}),
    ...(typeof detail.message === 'string' ? { message: detail.message } : {}),
  };
}

function isFeedbackKind(value: string): value is 'info' | 'warning' | 'error' {
  return value === 'info' || value === 'warning' || value === 'error';
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
    readonly position: ReturnType<typeof runPosition>;
    /** Whether the destination this run would resume into still exists. */
    readonly destinationLive: boolean;
    readonly destinationWorktreeId: number | null;
  },
): WorkflowRunControls {
  const terminal = row.status === 'done' || row.status === 'failed' || row.status === 'cancelled';
  const humanWait =
    context.position.kind === 'awaiting_wait'
      ? (db
          .select()
          .from(workflowWaits)
          .where(eq(workflowWaits.id, context.position.waitId))
          .get() ?? null)
      : null;
  return {
    pause: !terminal && !row.paused,
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
      context.destinationWorktreeId !== null &&
      worktreeExists(db, context.destinationWorktreeId),
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
