import { eq } from 'drizzle-orm';

import type {
  WorkflowAttemptDto,
  WorkflowOperationDto,
  WorkflowTransitionDto,
  WorkflowVersionDto,
} from '@isagi/contracts';

import type { RuntimeDrizzleDatabase } from '../../../persistence/database.service.js';
import {
  workflowOperations,
  workflowSegmentAttempts,
  workflowTransitions,
  workflowVersionAdoptions,
} from '../../../persistence/schema.js';
import { failureOf, recoveryModeOf } from './graph.js';
import { columnSlotDto } from './payloads.js';

type OperationRow = typeof workflowOperations.$inferSelect;
type AttemptRow = typeof workflowSegmentAttempts.$inferSelect;
type TransitionRow = typeof workflowTransitions.$inferSelect;
type AdoptionRow = typeof workflowVersionAdoptions.$inferSelect;

/** An operation with no recorded request could not have crossed a boundary, nor be matched on re-entry. */
export class OperationWithoutRequestError extends Error {
  readonly _tag = 'OperationWithoutRequestError';
  constructor(readonly operationKey: string) {
    super(
      `Operation ${operationKey} has no recorded request, which intent writes before the effect crosses its boundary.`,
    );
  }
}

export function projectOperation(
  db: RuntimeDrizzleDatabase,
  operationId: number,
): WorkflowOperationDto | null {
  const row = db
    .select()
    .from(workflowOperations)
    .where(eq(workflowOperations.id, operationId))
    .get();
  return row ? operationDto(db, row) : null;
}

/**
 * One durable external operation, with every fact recovery and inspection depend on.
 *
 * Intent, receipt, fingerprint, stage, target, stop and late evidence all stay inspectable: they are
 * what separates "the prompt was submitted" from "a resource was allocated", and an operation
 * outlives the attempt that dispatched it, so `attemptId` is provenance rather than ownership.
 */
export function operationDto(db: RuntimeDrizzleDatabase, row: OperationRow): WorkflowOperationDto {
  const requestRef = columnSlotDto(
    db,
    'workflow_operations.request',
    row.requestInline,
    row.requestRef,
  );
  if (requestRef === null) throw new OperationWithoutRequestError(row.operationKey);
  return {
    operationKey: row.operationKey,
    frameId: row.frameId,
    executionId: row.executionId,
    attemptId: row.originAttemptId,
    capability: row.capability,
    callIndex: row.callIndex,
    state: row.state,
    stage: row.stage,
    requestRef,
    requestHash: row.requestFingerprint,
    receiptRef: columnSlotDto(db, 'workflow_operations.receipt', row.receiptInline, row.receiptRef),
    resultRef: columnSlotDto(db, 'workflow_operations.result', row.resultInline, row.resultRef),
    target: {
      agentSessionId: row.targetKind === 'agent_session' ? row.targetId : null,
      paneId: row.targetKind === 'pane' ? row.targetId : null,
      ptyProcessId: row.ptyProcessId,
      // The harness ledger's start sequence for the turn this submission was correlated to, scoped
      // to the operation's agent session. It is the only durable turn identity the runtime records
      // (ADR 0007's raw native evidence); no friendlier id is invented for the wire.
      turnId: row.correlatedStartSeq === null ? null : String(row.correlatedStartSeq),
    },
    stop: {
      state: row.stopState,
      detail: row.stopDetail,
      requestedAt: row.stopRequestedAt,
      settledAt: row.stopSettledAt,
    },
    uncertaintyDetail: row.uncertaintyDetail,
    lateEvidenceRef: columnSlotDto(
      db,
      'workflow_operations.late_evidence',
      row.lateEvidenceInline,
      row.lateEvidenceRef,
    ),
    createdAt: row.createdAt,
    dispatchedAt: row.dispatchedAt,
    settledAt: row.settledAt,
  };
}

export function attemptDto(db: RuntimeDrizzleDatabase, row: AttemptRow): WorkflowAttemptDto {
  return {
    attemptId: row.id,
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
    failure: failureOf(db, row),
    inputRef: columnSlotDto(db, 'workflow_segment_attempts.input', row.inputInline, row.inputRef),
    producerOutputRef: columnSlotDto(
      db,
      'workflow_segment_attempts.producer_output',
      row.producerOutputInline,
      row.producerOutputRef,
    ),
    producerArtifactHash: row.producerArtifactHash,
    recoveryMode: recoveryModeOf(row),
  };
}

export function transitionDto(
  db: RuntimeDrizzleDatabase,
  row: TransitionRow,
  operationKey: string | null,
): WorkflowTransitionDto {
  return {
    revision: row.revision,
    recordedAt: row.recordedAt,
    kind: row.kind,
    frameId: row.frameId,
    executionId: row.executionId,
    attemptId: row.attemptId,
    operationKey,
    waitId: row.waitId,
    artifactHash: row.artifactHash,
    detailRef: columnSlotDto(db, 'workflow_transitions.detail', row.detailInline, row.detailRef),
    stateRef: columnSlotDto(db, 'workflow_transitions.state', row.stateInline, row.stateRef),
  };
}

/** One adoption, numbered by its position in the run's adoption history. */
export function versionDto(
  row: AdoptionRow,
  pinOrdinal: number,
  artifact: {
    readonly sdkVersion: string;
    readonly verifierVersion: string;
    readonly rootGraphKey: string;
  },
): WorkflowVersionDto {
  return {
    artifactHash: row.artifactHash,
    pinOrdinal,
    sdkVersion: artifact.sdkVersion,
    verifierVersion: artifact.verifierVersion,
    rootGraphKey: artifact.rootGraphKey,
    adoptedAt: row.adoptedAt,
    adoptedBy: row.reason,
  };
}
