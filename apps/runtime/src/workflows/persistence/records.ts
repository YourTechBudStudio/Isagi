import type {
  WorkflowAttemptStatus,
  WorkflowCapability,
  WorkflowEndCertainty,
  WorkflowExecutionStatus,
  WorkflowFailureCode,
  WorkflowFrameStatus,
  WorkflowInvocationKind,
  WorkflowNodeKind,
  WorkflowOperationStage,
  WorkflowOperationState,
  WorkflowOutcomeKind,
  WorkflowRunPosition,
  WorkflowRunStatus,
  WorkflowSegmentKind,
  WorkflowStopState,
  WorkflowTransitionKind,
  WorkflowWaitKind,
  WorkflowWaitStatus,
} from '@isagi/contracts';

import type { PayloadSlot } from './payload-store.js';

/**
 * Decoded durable records.
 *
 * These are the runtime's own shapes, not wire DTOs: they carry internal row ids (an operation's
 * numeric `id` alongside its public `operationKey`) and unresolved payload slots. The read
 * projection maps identities and resolves payloads; it never renames a status, because storage and
 * wire share one vocabulary by construction.
 */

export type WorkflowOperationTargetKind = 'agent_session' | 'pane' | 'pty_process' | 'none';
export type WorkflowOperationAttribution = 'not_applicable' | 'inferred_by_watermark' | 'ambiguous';
export type WorkflowVersionAdoptionReason = 'launch' | 'retry';
export type WorkflowPauseReason = 'control' | 'environment_deleted' | 'runtime_restart';

/** Retained placement provenance. Plain values with no foreign key: it outlives what it names. */
export interface WorkflowRunPlacement {
  readonly worktreeId: number | null;
  readonly worktreePath: string | null;
  readonly surfaceId: number | null;
  readonly paneId: number | null;
  readonly agentSessionId: number | null;
}

export interface WorkflowRunRecord {
  readonly id: number;
  readonly workflowKey: string;
  readonly title: string;
  readonly rootGraphKey: string;
  readonly artifactHash: string;
  readonly status: WorkflowRunStatus;
  readonly outcomeId: string | null;
  readonly outcomeKind: WorkflowOutcomeKind | null;
  readonly output: PayloadSlot | null;
  readonly position: WorkflowRunPosition;
  readonly activeFrameId: number | null;
  readonly paused: boolean;
  readonly environmentAvailable: boolean;
  readonly cancelRequested: boolean;
  readonly controlRevision: number;
  readonly revision: number;
  readonly activeAttemptId: number | null;
  readonly pendingInvocationKind: WorkflowInvocationKind | null;
  readonly owner: string | null;
  readonly ownerIncarnation: string | null;
  readonly failureCode: WorkflowFailureCode | null;
  readonly failureMessage: string | null;
  readonly failureAttemptId: number | null;
  readonly blockedOperationId: number | null;
  readonly origin: WorkflowRunPlacement;
  readonly destination: {
    readonly worktreeId: number | null;
    readonly worktreePath: string | null;
    readonly surfaceId: number | null;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

export interface WorkflowRunAttachmentRecord {
  readonly id: number;
  readonly runId: number;
  readonly worktreeId: number;
  readonly surfaceId: number | null;
  readonly attachedAt: string;
}

export interface WorkflowFrameRecord {
  readonly id: number;
  readonly runId: number;
  readonly parentExecutionId: number | null;
  readonly graphKey: string;
  readonly entryArtifactHash: string;
  readonly depth: number;
  readonly status: WorkflowFrameStatus;
  readonly displayName: string | null;
  readonly parameters: PayloadSlot | null;
  readonly state: PayloadSlot | null;
  readonly outcomeId: string | null;
  readonly outcomeKind: WorkflowOutcomeKind | null;
  readonly outcomeReason: string | null;
  readonly output: PayloadSlot | null;
  readonly outputArtifactHash: string | null;
  readonly enteredAt: string;
  readonly completedAt: string | null;
}

export interface WorkflowExecutionRecord {
  readonly id: number;
  readonly runId: number;
  readonly frameId: number;
  readonly nodeId: string;
  readonly nodeKind: WorkflowNodeKind;
  readonly visitIndex: number;
  readonly status: WorkflowExecutionStatus;
  readonly childFrameId: number | null;
  readonly displayName: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endCertainty: WorkflowEndCertainty;
}

export interface WorkflowAttemptRecord {
  readonly id: number;
  readonly runId: number;
  readonly frameId: number;
  readonly executionId: number | null;
  readonly segmentKind: WorkflowSegmentKind;
  readonly segmentRef: string | null;
  readonly attemptIndex: number;
  readonly artifactHash: string;
  readonly status: WorkflowAttemptStatus;
  readonly invocationKind: WorkflowInvocationKind;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endCertainty: WorkflowEndCertainty;
  readonly failureCode: WorkflowFailureCode | null;
  readonly failureMessage: string | null;
  readonly input: PayloadSlot | null;
  /** The recovery operand. Written before reduction is attempted and never cleared. */
  readonly producerOutput: PayloadSlot | null;
  /** The pin that produced the operand — not necessarily this attempt's own pin. */
  readonly producerArtifactHash: string | null;
  readonly failureDetail: PayloadSlot | null;
}

export interface WorkflowTransitionRecord {
  readonly id: number;
  readonly runId: number;
  readonly revision: number;
  readonly recordedAt: string;
  readonly kind: WorkflowTransitionKind;
  readonly frameId: number | null;
  readonly executionId: number | null;
  readonly attemptId: number | null;
  readonly operationId: number | null;
  readonly waitId: number | null;
  readonly artifactHash: string | null;
  readonly state: PayloadSlot | null;
  readonly detail: PayloadSlot | null;
}

export interface WorkflowWaitRecord {
  readonly id: number;
  readonly runId: number;
  readonly executionId: number;
  readonly waitKind: WorkflowWaitKind;
  readonly condition: PayloadSlot | null;
  readonly status: WorkflowWaitStatus;
  readonly armedAt: string;
  readonly deliveredAt: string | null;
  readonly consumedAt: string | null;
  readonly event: PayloadSlot | null;
}

export interface WorkflowOperationRecord {
  readonly id: number;
  readonly operationKey: string;
  readonly runId: number;
  readonly frameId: number;
  readonly executionId: number;
  readonly originAttemptId: number;
  readonly capability: WorkflowCapability;
  readonly callIndex: number;
  readonly requestFingerprint: string;
  readonly request: PayloadSlot | null;
  readonly artifactHash: string;
  readonly state: WorkflowOperationState;
  readonly stage: WorkflowOperationStage | null;
  readonly receipt: PayloadSlot | null;
  readonly result: PayloadSlot | null;
  readonly targetKind: WorkflowOperationTargetKind;
  readonly targetId: number | null;
  readonly ptyProcessId: number | null;
  readonly captureOwner: string | null;
  readonly attribution: WorkflowOperationAttribution;
  readonly correlatedStartSeq: number | null;
  readonly correlatedHarnessSessionId: string | null;
  readonly submissionWatermark: string | null;
  readonly stopState: WorkflowStopState;
  readonly stopDetail: string | null;
  readonly stopRequestedAt: string | null;
  readonly stopSettledAt: string | null;
  readonly uncertaintyDetail: string | null;
  readonly lateEvidence: PayloadSlot | null;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
  readonly settledAt: string | null;
}

export interface WorkflowArtifactRecord {
  readonly artifactHash: string;
  readonly workflowKey: string;
  readonly contractVersion: number;
  readonly manifestVersion: number;
  readonly descriptorVersion: number;
  readonly sdkVersion: string;
  readonly verifierVersion: string;
  readonly sourceHash: string;
  readonly structureHash: string;
  readonly rootGraphKey: string;
  readonly descriptor: PayloadSlot | null;
  readonly firstSeenAt: string;
}

export interface WorkflowVersionAdoptionRecord {
  readonly id: number;
  readonly runId: number;
  readonly artifactHash: string;
  readonly reason: WorkflowVersionAdoptionReason;
  readonly attemptId: number | null;
  readonly adoptedAt: string;
}

export interface WorkflowPauseIntervalRecord {
  readonly id: number;
  readonly runId: number;
  readonly reason: WorkflowPauseReason;
  readonly pausedAt: string;
  readonly resumedAt: string | null;
}
