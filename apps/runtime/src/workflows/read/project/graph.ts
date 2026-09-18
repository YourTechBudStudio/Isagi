import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';

import type {
  WorkflowCapability,
  WorkflowExecutionDto,
  WorkflowExecutionRoutingDto,
  WorkflowExecutionWaitDto,
  WorkflowFrameDto,
  WorkflowFrameOutputDto,
  WorkflowFrameSegmentDto,
  WorkflowLatestAttemptDto,
  WorkflowOperationSummaryDto,
  WorkflowPriorFailureDto,
  WorkflowQuestionSpecDto,
  WorkflowRecoveryMode,
  WorkflowSegmentFailure,
} from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../../persistence/database.service.js';
import {
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowOperations,
  workflowRuns,
  workflowSegmentAttempts,
  workflowTransitions,
  workflowWaits,
} from '../../../persistence/schema.js';
import { slotFromColumns } from '../../persistence/slots.js';
import { decodeDiagnosticDetail } from './diagnostics.js';
import { columnSlotDto, inlineValue, isRecord } from './payloads.js';

type FrameRow = typeof workflowGraphFrames.$inferSelect;
type ExecutionRow = typeof workflowNodeExecutions.$inferSelect;
type AttemptRow = typeof workflowSegmentAttempts.$inferSelect;

/**
 * The waterfall's two records, projected from stored facts alone.
 *
 * Nothing here consults a live session, a loaded definition or a running interpreter: a frame and a
 * node visit are whatever the database says they are. Four identities stay apart — a definition
 * address, a frame, a visit, an attempt — so one graph registered twice never merges its frames and
 * two visits to one node never share a row.
 *
 * These functions run inside the write transaction that captures a change, so every read below is a
 * synchronous indexed lookup over rows that transaction has already written.
 */

/** Prior failures are unbounded in principle; `attemptCount` stays the authority for how many. */
const maxPriorFailures = 20;

export function projectFrame(db: RuntimeDrizzleDatabase, frameId: number): WorkflowFrameDto | null {
  const row = db
    .select()
    .from(workflowGraphFrames)
    .where(eq(workflowGraphFrames.id, frameId))
    .get();
  return row ? frameDto(db, row) : null;
}

export function frameDto(db: RuntimeDrizzleDatabase, row: FrameRow): WorkflowFrameDto {
  const parent =
    row.parentExecutionId === null
      ? null
      : (db
          .select({ frameId: workflowNodeExecutions.frameId })
          .from(workflowNodeExecutions)
          .where(eq(workflowNodeExecutions.id, row.parentExecutionId))
          .get() ?? null);
  const executionCount = countOf(
    db
      .select({ value: sql<number>`count(*)` })
      .from(workflowNodeExecutions)
      .where(eq(workflowNodeExecutions.frameId, row.id))
      .get(),
  );

  return {
    frameId: row.id,
    parentExecutionId: row.parentExecutionId,
    parentFrameId: parent?.frameId ?? null,
    graphKey: row.graphKey,
    entryArtifactHash: row.entryArtifactHash,
    depth: row.depth,
    status: row.status,
    displayName: row.displayName,
    labelDiagnostic: labelDiagnosticOf(db, { frameId: row.id, executionId: null }),
    entry: frameSegment(db, row.id, 'graph_entry'),
    outputEvaluation: frameSegment(db, row.id, 'graph_output'),
    output: frameOutput(db, row),
    enteredAt: row.enteredAt,
    completedAt: row.completedAt,
    parametersRef: columnSlotDto(
      db,
      'workflow_graph_frames.parameters',
      row.parametersInline,
      row.parametersRef,
    ),
    stateRef: columnSlotDto(db, 'workflow_graph_frames.state', row.stateInline, row.stateRef),
    executionCount,
  };
}

/** The immutable fact a completed frame published. Its timing belongs to the segment that ran it. */
function frameOutput(db: RuntimeDrizzleDatabase, row: FrameRow): WorkflowFrameOutputDto | null {
  if (row.outcomeId === null || row.outcomeKind === null) return null;
  return {
    outcomeId: row.outcomeId,
    outcomeKind: row.outcomeKind,
    outcomeReason: row.outcomeReason,
    producedRef: columnSlotDto(db, 'workflow_graph_frames.output', row.outputInline, row.outputRef),
    producerArtifactHash: row.outputArtifactHash,
  };
}

/**
 * A segment the frame owns: entering the graph, or evaluating its output.
 *
 * Projected exactly like a node visit's segments, from the same shared records, because they are
 * the same thing — author code, an attempt, a pin, a failure, a repair — happening where no node
 * execution exists to carry them. A failed initialization and an evaluation that threw before any
 * outcome existed are visible here and nowhere else short of the attempts route, which is precisely
 * what the dock must not need.
 *
 * Attempts of one frame-owned segment kind are scoped to the *latest* segment reference, so a
 * repaired evaluation of one outcome never shows another outcome's failures as its own.
 */
function frameSegment(
  db: RuntimeDrizzleDatabase,
  frameId: number,
  segmentKind: 'graph_entry' | 'graph_output',
): WorkflowFrameSegmentDto | null {
  const all = db
    .select()
    .from(workflowSegmentAttempts)
    .where(
      and(
        eq(workflowSegmentAttempts.frameId, frameId),
        isNull(workflowSegmentAttempts.executionId),
        eq(workflowSegmentAttempts.segmentKind, segmentKind),
      ),
    )
    .orderBy(asc(workflowSegmentAttempts.id))
    .all();
  const latest = all.at(-1);
  if (!latest) return null;
  const attempts = all.filter((attempt) => attempt.segmentRef === latest.segmentRef);
  const first = attempts[0]!;
  return {
    segmentKind,
    segmentRef: latest.segmentRef,
    attemptCount: attempts.length,
    startedAt: first.startedAt,
    endedAt: latest.endedAt,
    endCertainty: latest.endCertainty,
    firstArtifactHash: first.artifactHash,
    latestArtifactHash: latest.artifactHash,
    latestAttempt: latestAttemptDto(db, latest),
    priorFailures: priorFailures(db, attempts, latest),
  };
}

export function projectExecution(
  db: RuntimeDrizzleDatabase,
  executionId: number,
): WorkflowExecutionDto | null {
  const row = db
    .select()
    .from(workflowNodeExecutions)
    .where(eq(workflowNodeExecutions.id, executionId))
    .get();
  return row ? executionDto(db, row) : null;
}

export function executionDto(db: RuntimeDrizzleDatabase, row: ExecutionRow): WorkflowExecutionDto {
  const frame = db
    .select()
    .from(workflowGraphFrames)
    .where(eq(workflowGraphFrames.id, row.frameId))
    .get();
  if (!frame) {
    throw new Error(`Node execution ${row.id} names frame ${row.frameId}, which does not exist.`);
  }

  const attempts = db
    .select()
    .from(workflowSegmentAttempts)
    .where(eq(workflowSegmentAttempts.executionId, row.id))
    .orderBy(asc(workflowSegmentAttempts.id))
    .all();
  const latest = attempts.at(-1) ?? null;
  const callback = lastOfKind(attempts, 'node_callback');
  const routingAttempt = lastOfKind(attempts, 'routing');
  const wait = db
    .select()
    .from(workflowWaits)
    .where(eq(workflowWaits.executionId, row.id))
    .orderBy(desc(workflowWaits.id))
    .get();

  const currentPin = db
    .select({ artifactHash: workflowRuns.artifactHash })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, row.runId))
    .get();

  return {
    executionId: row.id,
    frameId: row.frameId,
    parentExecutionId: frame.parentExecutionId,
    graphKey: frame.graphKey,
    depth: frame.depth,
    nodeId: row.nodeId,
    nodeKind: row.nodeKind,
    visitIndex: row.visitIndex,
    status: row.status,
    displayName: row.displayName,
    labelDiagnostic: labelDiagnosticOf(db, { frameId: null, executionId: row.id }),
    childFrameId: row.childFrameId,
    // Returned inline so a spanning subgraph bar needs no second request per row.
    childFrame: row.childFrameId === null ? null : projectFrame(db, row.childFrameId),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endCertainty: row.endCertainty,
    callbackStartedAt: callback?.startedAt ?? null,
    callbackEndedAt: callback?.endedAt ?? null,
    waitArmedAt: wait?.armedAt ?? null,
    waitDeliveredAt: wait?.deliveredAt ?? null,
    attemptCount: attempts.length,
    // A visit dispatched but not yet attempted has no attempt to take a pin from, and the pin in
    // force is the run's own. A visit repaired under a later pin reads first → latest.
    firstArtifactHash:
      attempts[0]?.artifactHash ?? currentPin?.artifactHash ?? frame.entryArtifactHash,
    latestArtifactHash: latest?.artifactHash ?? currentPin?.artifactHash ?? frame.entryArtifactHash,
    latestAttempt: latest ? latestAttemptDto(db, latest) : null,
    priorFailures: priorFailures(db, attempts, latest),
    routing: routingAttempt ? routingDto(db, routingAttempt) : null,
    wait: wait ? waitDto(db, wait) : null,
    operationSummary: operationSummary(db, row),
    // The Data slots. `stateIn` is the frame's committed state boundary as this visit began, which
    // is a fact of the frame's history rather than a column on the visit; `candidate` is the
    // producer operand the callback recorded before reduction; `update` is the update inside that
    // operand, available when the operand is inline; `stateOut` is the boundary the reduction
    // committed.
    stateInRef: stateBefore(db, row),
    candidateRef: callback
      ? columnSlotDto(
          db,
          'workflow_segment_attempts.producer_output',
          callback.producerOutputInline,
          callback.producerOutputRef,
        )
      : null,
    updateRef: updateInside(db, callback, 'workflow_segment_attempts.producer_output'),
    stateOutRef: stateAfter(db, row),
  };
}

function lastOfKind(attempts: readonly AttemptRow[], kind: AttemptRow['segmentKind']) {
  return attempts.filter((attempt) => attempt.segmentKind === kind).at(-1) ?? null;
}

function latestAttemptDto(
  db: RuntimeDrizzleDatabase,
  attempt: AttemptRow,
): WorkflowLatestAttemptDto {
  return {
    attemptId: attempt.id,
    attemptIndex: attempt.attemptIndex,
    artifactHash: attempt.artifactHash,
    status: attempt.status,
    invocationKind: attempt.invocationKind,
    failure: failureOf(db, attempt),
    recoveryMode: recoveryModeOf(attempt),
    producerArtifactHash: attempt.producerArtifactHash,
  };
}

/**
 * What a repair of this segment would actually do, derived from the saved operand rather than from
 * the failure code: a producer result that reached its durable slot is reused, and a segment that
 * never got one runs its producer again.
 */
export function recoveryModeOf(attempt: AttemptRow): WorkflowRecoveryMode {
  return attempt.producerOutputInline !== null || attempt.producerOutputRef !== null
    ? 'reuse_producer_output'
    : 'rerun_producer';
}

export function failureOf(
  db: RuntimeDrizzleDatabase,
  attempt: AttemptRow,
): WorkflowSegmentFailure | null {
  if (attempt.failureCode === null) return null;
  return {
    code: attempt.failureCode,
    message: attempt.failureMessage ?? '',
    detail: columnSlotDto(
      db,
      'workflow_segment_attempts.failure_detail',
      attempt.failureDetailInline,
      attempt.failureDetailRef,
    ),
  };
}

/**
 * Failures earlier attempts of this visit recorded, kept even once a later attempt succeeded.
 *
 * A repaired step has to keep explaining what went wrong and what fixed it, so each failure names
 * the later attempt of the *same segment* that succeeded — a callback failure is not repaired by a
 * routing attempt that ran afterwards.
 */
function priorFailures(
  db: RuntimeDrizzleDatabase,
  attempts: readonly AttemptRow[],
  latest: AttemptRow | null,
): readonly WorkflowPriorFailureDto[] {
  const failures = attempts.filter(
    (attempt) => attempt.failureCode !== null && attempt.id !== latest?.id,
  );
  return failures.slice(-maxPriorFailures).map((attempt) => {
    const repair =
      attempts.find(
        (candidate) =>
          candidate.id > attempt.id &&
          candidate.segmentKind === attempt.segmentKind &&
          candidate.segmentRef === attempt.segmentRef &&
          candidate.status === 'succeeded',
      ) ?? null;
    return {
      attemptId: attempt.id,
      attemptIndex: attempt.attemptIndex,
      segmentKind: attempt.segmentKind,
      artifactHash: attempt.artifactHash,
      failure: failureOf(db, attempt)!,
      repairedByAttemptIndex: repair?.attemptIndex ?? null,
      repairedByArtifactHash: repair?.artifactHash ?? null,
    };
  });
}

/**
 * The routing segment as its own row: an edge function has a decision, a bar on the clock and a
 * failure of its own, none of which belong to the callback that preceded it.
 *
 * `chosen` and `updateRef` come from the decision operand the router saved before reducing. A
 * decision large enough to be stored out of line leaves both null rather than guessed; the operand
 * itself stays retrievable through the retained attempts API.
 */
function routingDto(db: RuntimeDrizzleDatabase, attempt: AttemptRow): WorkflowExecutionRoutingDto {
  const decision = inlineValue(
    'workflow_segment_attempts.producer_output',
    slotFromColumns(
      'workflow_segment_attempts.producer_output',
      attempt.producerOutputInline,
      attempt.producerOutputRef,
    ),
  );
  const chosen = isRecord(decision) && typeof decision.to === 'string' ? decision.to : null;
  return {
    edgeId: attempt.segmentRef,
    attemptIndex: attempt.attemptIndex,
    chosen,
    updateRef: updateInside(db, attempt, 'workflow_segment_attempts.producer_output'),
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    failure: failureOf(db, attempt),
  };
}

/** The `update` inside a producer operand, when that operand is inline. */
function updateInside(db: RuntimeDrizzleDatabase, attempt: AttemptRow | null, slotName: string) {
  if (!attempt) return null;
  const operand = inlineValue(
    slotName,
    slotFromColumns(slotName, attempt.producerOutputInline, attempt.producerOutputRef),
  );
  if (!isRecord(operand) || !Object.hasOwn(operand, 'update')) return null;
  return { inline: operand.update };
}

function waitDto(
  db: RuntimeDrizzleDatabase,
  row: typeof workflowWaits.$inferSelect,
): WorkflowExecutionWaitDto {
  const condition = inlineValue(
    'workflow_waits.condition',
    slotFromColumns('workflow_waits.condition', row.conditionInline, row.conditionRef),
  );
  const event = inlineValue(
    'workflow_waits.event',
    slotFromColumns('workflow_waits.event', row.eventInline, row.eventRef),
  );
  return {
    waitId: row.id,
    kind: row.waitKind,
    status: row.status,
    label: isRecord(condition) && typeof condition.label === 'string' ? condition.label : null,
    questions: questionsOf(condition),
    answers: answersOf(event),
    armedAt: row.armedAt,
    deliveredAt: row.deliveredAt,
  };
}

function questionsOf(condition: unknown): readonly WorkflowQuestionSpecDto[] | null {
  if (!isRecord(condition) || !Array.isArray(condition.questions)) return null;
  return condition.questions as readonly WorkflowQuestionSpecDto[];
}

function answersOf(event: unknown) {
  if (!isRecord(event) || !isRecord(event.answers)) return null;
  return event.answers as Record<string, string | readonly string[] | boolean>;
}

/**
 * What this visit actually called, counted from durable operation rows.
 *
 * A subgraph visit's count includes the operations its nested frames performed, without pretending
 * the subgraph callback issued them: the capabilities are the ones actually recorded, at whatever
 * depth. A visit that is waiting for a human keeps the operations it performed before suspending —
 * hiding them is what would make the dock lie about an effect that is still out there.
 */
function operationSummary(
  db: RuntimeDrizzleDatabase,
  row: ExecutionRow,
): WorkflowOperationSummaryDto {
  const executionIds = [row.id, ...nestedExecutionIds(db, row.childFrameId)];
  const rows = executionIds.flatMap((executionId) =>
    db
      .select({
        capability: workflowOperations.capability,
        state: workflowOperations.state,
      })
      .from(workflowOperations)
      .where(eq(workflowOperations.executionId, executionId))
      .all(),
  );
  const capabilities = new Set<WorkflowCapability>();
  let unresolved = 0;
  for (const operation of rows) {
    capabilities.add(operation.capability);
    if (isUnresolved(operation.state)) unresolved += 1;
  }
  return { count: rows.length, unresolved, capabilities: [...capabilities].sort() };
}

/** Settled states that still hold the run — `uncertain` above all — are not resolved. */
function isUnresolved(state: (typeof workflowOperations.$inferSelect)['state']) {
  return state === 'intended' || state === 'dispatched' || state === 'uncertain';
}

/** Every execution beneath a child frame, breadth-first, bounded by the run's own frame count. */
function nestedExecutionIds(
  db: RuntimeDrizzleDatabase,
  childFrameId: number | null,
): readonly number[] {
  if (childFrameId === null) return [];
  const executionIds: number[] = [];
  const frames = [childFrameId];
  while (frames.length > 0) {
    const frameId = frames.shift()!;
    const executions = db
      .select({ id: workflowNodeExecutions.id, childFrameId: workflowNodeExecutions.childFrameId })
      .from(workflowNodeExecutions)
      .where(eq(workflowNodeExecutions.frameId, frameId))
      .all();
    for (const execution of executions) {
      executionIds.push(execution.id);
      if (execution.childFrameId !== null) frames.push(execution.childFrameId);
    }
  }
  return executionIds;
}

/**
 * The frame state boundary this visit started from.
 *
 * Read as the frame's last committed state as of the transition that created the visit, because
 * that is where the boundary actually lives: a visit does not own a copy of the state it read, and
 * the attempt's recorded input is a claim envelope rather than the boundary itself. The bound is
 * inclusive because a graph entry commits the initial state *and* dispatches the entry node in one
 * transition — that state is exactly what the entry node then reads.
 */
function stateBefore(db: RuntimeDrizzleDatabase, row: ExecutionRow) {
  const created = db
    .select({ revision: workflowTransitions.revision })
    .from(workflowTransitions)
    .where(eq(workflowTransitions.executionId, row.id))
    .orderBy(asc(workflowTransitions.revision))
    .get();
  if (!created) return null;
  const previous = db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.frameId, row.frameId),
        lte(workflowTransitions.revision, created.revision),
        sql`(${workflowTransitions.stateInline} IS NOT NULL OR ${workflowTransitions.stateRef} IS NOT NULL)`,
      ),
    )
    .orderBy(desc(workflowTransitions.revision))
    .get();
  return previous
    ? columnSlotDto(db, 'workflow_transitions.state', previous.stateInline, previous.stateRef)
    : null;
}

/** The boundary this visit's reduction committed, which is the state the next segment reads. */
function stateAfter(db: RuntimeDrizzleDatabase, row: ExecutionRow) {
  const reduced = db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.executionId, row.id),
        eq(workflowTransitions.kind, 'state_reduced'),
      ),
    )
    .orderBy(desc(workflowTransitions.revision))
    .get();
  return reduced
    ? columnSlotDto(db, 'workflow_transitions.state', reduced.stateInline, reduced.stateRef)
    : null;
}

/**
 * A failed display-name capture, which is a diagnostic and never a segment failure.
 *
 * Recorded as a `log` transition carrying `code: 'label_failed'`, so the message is read back from
 * the same durable record the run's history already carries.
 */
function labelDiagnosticOf(
  db: RuntimeDrizzleDatabase,
  target: { readonly frameId: number | null; readonly executionId: number | null },
): string | null {
  const rows = db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.kind, 'log'),
        target.executionId === null
          ? and(
              eq(workflowTransitions.frameId, target.frameId!),
              isNull(workflowTransitions.executionId),
            )
          : eq(workflowTransitions.executionId, target.executionId),
      ),
    )
    .orderBy(desc(workflowTransitions.revision))
    .limit(10)
    .all();
  for (const transition of rows) {
    const detail = inlineValue(
      'workflow_transitions.detail',
      slotFromColumns('workflow_transitions.detail', transition.detailInline, transition.detailRef),
    );
    const decoded = decodeDiagnosticDetail(detail);
    if (decoded?.source === 'runtime_diagnostic' && decoded.code === 'label_failed') {
      return decoded.message;
    }
  }
  return null;
}

function countOf(row: { readonly value: number } | undefined): number {
  return row?.value ?? 0;
}
