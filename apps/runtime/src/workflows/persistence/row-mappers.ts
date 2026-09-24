import type { WorkflowAgentHarness } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Schema } from 'effect';

import {
  agentHarnessSchema,
  workflowRunPositionSchema,
  type WorkflowOperationUsage,
  type WorkflowRunPosition,
} from '@isagi/contracts';

import type {
  workflowArtifacts,
  workflowCheckpointEntries,
  workflowCheckpoints,
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowOperations,
  workflowPauseIntervals,
  workflowRunAttachments,
  workflowRuns,
  workflowSegmentAttempts,
  workflowTransitions,
  workflowVersionAdoptions,
  workflowWaits,
} from '../../persistence/schema.js';
import type {
  WorkflowArtifactRecord,
  WorkflowAttemptRecord,
  WorkflowCheckpointEntryRecord,
  WorkflowCheckpointRecord,
  WorkflowExecutionRecord,
  WorkflowFrameRecord,
  WorkflowOperationRecord,
  WorkflowPauseIntervalRecord,
  WorkflowRunAttachmentRecord,
  WorkflowRunRecord,
  WorkflowTransitionRecord,
  WorkflowVersionAdoptionRecord,
  WorkflowWaitRecord,
} from './records.js';
import { slotFromColumns } from './slots.js';

type RunRow = typeof workflowRuns.$inferSelect;
type AttachmentRow = typeof workflowRunAttachments.$inferSelect;
type FrameRow = typeof workflowGraphFrames.$inferSelect;
type ExecutionRow = typeof workflowNodeExecutions.$inferSelect;
type AttemptRow = typeof workflowSegmentAttempts.$inferSelect;
type TransitionRow = typeof workflowTransitions.$inferSelect;
type WaitRow = typeof workflowWaits.$inferSelect;
type OperationRow = typeof workflowOperations.$inferSelect;
type ArtifactRow = typeof workflowArtifacts.$inferSelect;
type AdoptionRow = typeof workflowVersionAdoptions.$inferSelect;
type PauseIntervalRow = typeof workflowPauseIntervals.$inferSelect;
type CheckpointRow = typeof workflowCheckpoints.$inferSelect;
type CheckpointEntryRow = typeof workflowCheckpointEntries.$inferSelect;

export class CorruptRunPositionError extends Error {
  readonly _tag = 'CorruptRunPositionError';
  constructor(
    readonly runId: number,
    readonly detail: string,
  ) {
    super(`Run ${runId} has an unreadable saved position: ${detail}`);
  }
}

const decodePosition = Schema.decodeUnknownSync(workflowRunPositionSchema);

/**
 * Decodes the saved position through the shared contracts schema, so the durable position and the
 * transmitted one cannot drift into two shapes.
 *
 * Decoding proves *shape*, never referential validity: that a `routing` position names a frame, an
 * execution and an edge says nothing about whether those rows exist, belong to this run, or match
 * the pinned structure. The repository checks run membership and the saved-position validator
 * checks the descriptor. What this does guarantee is that a corrupt position fails loudly instead of
 * defaulting to a plausible one — resuming at a guessed position is how a run silently re-executes
 * committed work.
 */
export function runPosition(runId: number, positionJson: string): WorkflowRunPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(positionJson) as unknown;
  } catch (cause) {
    throw new CorruptRunPositionError(runId, `not valid JSON (${String(cause)})`);
  }
  try {
    return decodePosition(parsed);
  } catch (cause) {
    throw new CorruptRunPositionError(runId, String(cause));
  }
}

export function encodeRunPosition(position: WorkflowRunPosition): string {
  return JSON.stringify(position);
}

export function runRecord(row: RunRow): WorkflowRunRecord {
  return {
    id: row.id,
    workflowKey: row.workflowKey,
    title: row.title,
    rootGraphKey: row.rootGraphKey,
    artifactHash: row.artifactHash,
    status: row.status,
    outcomeId: row.outcomeId,
    outcomeKind: row.outcomeKind,
    output: slotFromColumns('workflow_runs.output', row.outputInline, row.outputRef),
    position: runPosition(row.id, row.positionJson),
    activeFrameId: row.activeFrameId,
    paused: row.paused,
    environmentAvailable: row.environmentAvailable,
    cancelRequested: row.cancelRequested,
    controlRevision: row.controlRevision,
    revision: row.revision,
    activeAttemptId: row.activeAttemptId,
    pendingInvocationKind: row.pendingInvocationKind,
    owner: row.owner,
    ownerIncarnation: row.ownerIncarnation,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    failureAttemptId: row.failureAttemptId,
    blockedOperationId: row.blockedOperationId,
    origin: {
      worktreeId: row.originWorktreeId,
      worktreePath: row.originWorktreePath,
      surfaceId: row.originSurfaceId,
      paneId: row.originPaneId,
      agentSessionId: row.originAgentSessionId,
    },
    destination: {
      worktreeId: row.destinationWorktreeId,
      worktreePath: row.destinationWorktreePath,
      surfaceId: row.destinationSurfaceId,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
  };
}

export function attachmentRecord(row: AttachmentRow): WorkflowRunAttachmentRecord {
  return {
    id: row.id,
    runId: row.runId,
    worktreeId: row.worktreeId,
    surfaceId: row.surfaceId,
    attachedAt: row.attachedAt,
  };
}

export function frameRecord(row: FrameRow): WorkflowFrameRecord {
  return {
    id: row.id,
    runId: row.runId,
    parentExecutionId: row.parentExecutionId,
    graphKey: row.graphKey,
    entryArtifactHash: row.entryArtifactHash,
    depth: row.depth,
    status: row.status,
    displayName: row.displayName,
    parameters: slotFromColumns(
      'workflow_graph_frames.parameters',
      row.parametersInline,
      row.parametersRef,
    ),
    state: slotFromColumns('workflow_graph_frames.state', row.stateInline, row.stateRef),
    outcomeId: row.outcomeId,
    outcomeKind: row.outcomeKind,
    outcomeReason: row.outcomeReason,
    output: slotFromColumns('workflow_graph_frames.output', row.outputInline, row.outputRef),
    outputArtifactHash: row.outputArtifactHash,
    enteredAt: row.enteredAt,
    completedAt: row.completedAt,
  };
}

export function executionRecord(row: ExecutionRow): WorkflowExecutionRecord {
  return {
    id: row.id,
    runId: row.runId,
    frameId: row.frameId,
    nodeId: row.nodeId,
    nodeKind: row.nodeKind,
    visitIndex: row.visitIndex,
    status: row.status,
    childFrameId: row.childFrameId,
    displayName: row.displayName,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endCertainty: row.endCertainty,
  };
}

export function attemptRecord(row: AttemptRow): WorkflowAttemptRecord {
  return {
    id: row.id,
    runId: row.runId,
    frameId: row.frameId,
    executionId: row.executionId,
    segmentKind: row.segmentKind,
    segmentRef: row.segmentRef,
    attemptIndex: row.attemptIndex,
    artifactHash: row.artifactHash,
    status: row.status,
    invocationKind: row.invocationKind,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endCertainty: row.endCertainty,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    input: slotFromColumns('workflow_segment_attempts.input', row.inputInline, row.inputRef),
    producerOutput: slotFromColumns(
      'workflow_segment_attempts.producer_output',
      row.producerOutputInline,
      row.producerOutputRef,
    ),
    producerArtifactHash: row.producerArtifactHash,
    failureDetail: slotFromColumns(
      'workflow_segment_attempts.failure_detail',
      row.failureDetailInline,
      row.failureDetailRef,
    ),
  };
}

export function transitionRecord(row: TransitionRow): WorkflowTransitionRecord {
  return {
    id: row.id,
    runId: row.runId,
    revision: row.revision,
    recordedAt: row.recordedAt,
    kind: row.kind,
    frameId: row.frameId,
    executionId: row.executionId,
    attemptId: row.attemptId,
    operationId: row.operationId,
    waitId: row.waitId,
    artifactHash: row.artifactHash,
    state: slotFromColumns('workflow_transitions.state', row.stateInline, row.stateRef),
    detail: slotFromColumns('workflow_transitions.detail', row.detailInline, row.detailRef),
  };
}

export function waitRecord(row: WaitRow): WorkflowWaitRecord {
  return {
    id: row.id,
    runId: row.runId,
    executionId: row.executionId,
    waitKind: row.waitKind,
    condition: slotFromColumns('workflow_waits.condition', row.conditionInline, row.conditionRef),
    status: row.status,
    armedAt: row.armedAt,
    deliveredAt: row.deliveredAt,
    consumedAt: row.consumedAt,
    event: slotFromColumns('workflow_waits.event', row.eventInline, row.eventRef),
  };
}

export function operationRecord(row: OperationRow): WorkflowOperationRecord {
  return {
    id: row.id,
    operationKey: row.operationKey,
    runId: row.runId,
    frameId: row.frameId,
    executionId: row.executionId,
    originAttemptId: row.originAttemptId,
    capability: row.capability,
    callIndex: row.callIndex,
    requestFingerprint: row.requestFingerprint,
    request: slotFromColumns('workflow_operations.request', row.requestInline, row.requestRef),
    artifactHash: row.artifactHash,
    state: row.state,
    stage: row.stage,
    receipt: slotFromColumns('workflow_operations.receipt', row.receiptInline, row.receiptRef),
    result: slotFromColumns('workflow_operations.result', row.resultInline, row.resultRef),
    targetKind: row.targetKind,
    targetId: row.targetId,
    ptyProcessId: row.ptyProcessId,
    captureOwner: row.captureOwner,
    attribution: row.attribution,
    correlatedStartSeq: row.correlatedStartSeq,
    correlatedHarnessSessionId: row.correlatedHarnessSessionId,
    submissionWatermark: row.submissionWatermark,
    stopState: row.stopState,
    stopDetail: row.stopDetail,
    stopRequestedAt: row.stopRequestedAt,
    stopSettledAt: row.stopSettledAt,
    uncertaintyDetail: row.uncertaintyDetail,
    lateEvidence: slotFromColumns(
      'workflow_operations.late_evidence',
      row.lateEvidenceInline,
      row.lateEvidenceRef,
    ),
    harness: harnessFromColumn(row.harness),
    model: row.model,
    effort: row.effort,
    cwd: row.cwd,
    runtimeId: row.runtimeId,
    incarnationId: row.incarnationId,
    usage: usageFromColumn(row.usageJson),
    createdAt: row.createdAt,
    dispatchedAt: row.dispatchedAt,
    settledAt: row.settledAt,
  };
}

const agentHarnesses = agentHarnessSchema.literals;

/**
 * The harness column is plain `text`, not an enum, because it is provenance about a past operation.
 *
 * A harness the product no longer recognises must still read back as *something honest*, and the
 * honest answer is "unknown" rather than a value the rest of the system would treat as live.
 */
export function harnessFromColumn(value: string | null): WorkflowAgentHarness | null {
  return (agentHarnesses as readonly string[]).includes(value ?? '')
    ? (value as WorkflowAgentHarness)
    : null;
}

/**
 * Usage as the provider reported it, or nothing.
 *
 * Every field is read independently and a non-numeric one becomes `null`, so a provider that
 * renames or drops a field degrades that field alone instead of discarding the whole record. No
 * total is computed: `inputTokens` is the bare uncached input, and a presentation that wants a true
 * total must account for the cache counts itself rather than have the runtime invent one.
 */
export function usageFromColumn(value: string | null): WorkflowOperationUsage | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  const numberAt = (key: string) => (typeof fields[key] === 'number' ? fields[key] : null);
  return {
    inputTokens: numberAt('inputTokens'),
    cacheReadInputTokens: numberAt('cacheReadInputTokens'),
    cacheCreationInputTokens: numberAt('cacheCreationInputTokens'),
    outputTokens: numberAt('outputTokens'),
    costUsd: numberAt('costUsd'),
  };
}

export function artifactRecord(row: ArtifactRow): WorkflowArtifactRecord {
  return {
    artifactHash: row.artifactHash,
    workflowKey: row.workflowKey,
    contractVersion: row.contractVersion,
    manifestVersion: row.manifestVersion,
    descriptorVersion: row.descriptorVersion,
    sdkVersion: row.sdkVersion,
    verifierVersion: row.verifierVersion,
    sourceHash: row.sourceHash,
    structureHash: row.structureHash,
    rootGraphKey: row.rootGraphKey,
    descriptor: slotFromColumns(
      'workflow_artifacts.descriptor',
      row.descriptorInline,
      row.descriptorRef,
    ),
    firstSeenAt: row.firstSeenAt,
  };
}

export function versionAdoptionRecord(row: AdoptionRow): WorkflowVersionAdoptionRecord {
  return {
    id: row.id,
    runId: row.runId,
    artifactHash: row.artifactHash,
    reason: row.reason,
    attemptId: row.attemptId,
    adoptedAt: row.adoptedAt,
  };
}

export function pauseIntervalRecord(row: PauseIntervalRow): WorkflowPauseIntervalRecord {
  return {
    id: row.id,
    runId: row.runId,
    reason: row.reason,
    pausedAt: row.pausedAt,
    resumedAt: row.resumedAt,
  };
}

/**
 * A checkpoint row that breaks the representation invariants its CHECK constraints and repository
 * enforce. Thrown rather than repaired: a checkpoint read with a guessed base or a dropped exclusion
 * would describe a different filesystem than the one that was captured.
 */
export class CorruptCheckpointRowError extends Error {
  readonly _tag = 'CorruptCheckpointRowError';
  constructor(
    readonly table: 'workflow_checkpoints' | 'workflow_checkpoint_entries',
    readonly rowId: number,
    readonly detail: string,
  ) {
    super(`${table} row ${rowId} is unreadable: ${detail}`);
  }
}

export function checkpointRecord(row: CheckpointRow): WorkflowCheckpointRecord {
  const corrupt = (detail: string) =>
    new CorruptCheckpointRowError('workflow_checkpoints', row.id, detail);
  let base: WorkflowCheckpointRecord['base'];
  if (row.baseKind === 'git') {
    if (row.baseCommitSha === null) throw corrupt('a git base has no commit');
    base = { kind: 'git', repositoryId: row.repositoryProjectId, commitSha: row.baseCommitSha };
  } else {
    if (row.baseReason === null) throw corrupt('a none base has no reason');
    base = { kind: 'none', reason: row.baseReason };
  }
  return {
    id: row.id,
    checkpointKey: row.checkpointKey,
    runId: row.runId,
    frameId: row.frameId,
    executionId: row.executionId,
    attemptId: row.attemptId,
    artifactHash: row.artifactHash,
    parentCheckpointId: row.parentCheckpointId,
    nodeId: row.nodeId,
    title: row.title,
    base,
    repositoryProjectId: row.repositoryProjectId,
    repositoryRootPath: row.repositoryRootPath,
    counts: {
      scopes: row.scopeCount,
      files: row.fileCount,
      absences: row.absentCount,
      warnings: row.warningCount,
    },
    createdAt: row.createdAt,
  };
}

export function checkpointEntryRecord(row: CheckpointEntryRow): WorkflowCheckpointEntryRecord {
  const corrupt = (detail: string) =>
    new CorruptCheckpointRowError('workflow_checkpoint_entries', row.id, detail);
  const placement = { checkpointId: row.checkpointId, seq: row.seq };
  const required = <T>(value: T | null, column: string): T => {
    if (value === null) throw corrupt(`a ${row.kind} row has no ${column}`);
    return value;
  };
  switch (row.kind) {
    case 'scope':
      return {
        ...placement,
        kind: 'scope',
        path: required(row.path, 'path'),
        scopeId: required(row.scopeId, 'scope_id'),
        scopeKind: required(row.scopeKind, 'scope_kind'),
        exclusions: readStringArray(required(row.exclusionsJson, 'exclusions_json'), corrupt),
        capturedBy: required(row.capturedByCheckpointKey, 'captured_by_checkpoint_key'),
      };
    case 'file':
      return {
        ...placement,
        kind: 'file',
        path: required(row.path, 'path'),
        fileKey: required(row.fileKey, 'file_key'),
        contentRef: required(row.contentRef, 'content_ref'),
        byteSize: required(row.byteSize, 'byte_size'),
        executable: required(row.executable, 'executable'),
      };
    case 'absent':
      return { ...placement, kind: 'absent', path: required(row.path, 'path') };
    case 'warning':
      return {
        ...placement,
        kind: 'warning',
        reason: required(row.warningReason, 'warning_reason'),
        path: row.path,
        scopeId: row.scopeId,
        detail:
          row.warningDetailJson === null ? null : readScalarRecord(row.warningDetailJson, corrupt),
        observedBy: required(row.observedByCheckpointKey, 'observed_by_checkpoint_key'),
      };
    case 'change':
      return {
        ...placement,
        kind: 'change',
        operation: required(row.changeOperation, 'change_operation'),
        path: required(row.path, 'path'),
        contentRef: row.contentRef,
        byteSize: row.byteSize,
        executable: row.executable,
      };
  }
}

function readStringArray(value: string, corrupt: (detail: string) => Error): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw corrupt('exclusions_json is not a string array');
  }
  return parsed;
}

function readScalarRecord(
  value: string,
  corrupt: (detail: string) => Error,
): Readonly<Record<string, string | number>> {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((item) => typeof item === 'string' || typeof item === 'number')
  ) {
    throw corrupt('warning_detail_json is not an object of scalars');
  }
  return parsed as Record<string, string | number>;
}
