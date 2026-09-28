import type {
  AgentHarness,
  WorkflowCheckpointDto,
  WorkflowCheckpointSummaryDto,
  WorkflowEventDto,
  WorkflowExecutionDetailDto,
  WorkflowExecutionSummaryDto,
  WorkflowGraphInvocationDto,
  WorkflowOperationDto,
  WorkflowOperationUsage,
  WorkflowRunControls,
  WorkflowRunSummary,
  WorkflowUiFeedbackDto,
  WorkflowWaitDto,
} from '@isagi/contracts';

import type { SavedResult } from '../engine/results.js';
import type { CheckpointScope } from '../store/checkpoints.js';
import { latestUiFeedback } from '../store/events.js';
import {
  fromJson,
  type CheckpointRow,
  type Db,
  type EventRow,
  type ExecutionRow,
  type InvocationRow,
  type OperationRow,
  type Outcome,
  type RunError,
  type RunPlacement,
  type RunRow,
} from '../store/rows.js';
import { getRun } from '../store/runs.js';
import { findLeafExecution, getInvocation } from '../store/tree.js';

/**
 * Rows to wire DTOs. Plain mapping: every value here is read straight from a column, and the few
 * derived fields — `current`, `uiFeedback`, `controls` — come from one small query each.
 */

export function runSummary(db: Db, run: RunRow): WorkflowRunSummary {
  const leaf = findLeafExecution(db, run.id);
  const invocation = leaf ? getInvocation(db, leaf.invocationId) : null;
  const ui = latestUiFeedback(db, run.id);
  const placement = fromJson<RunPlacement>(run.placementJson);
  const error = fromJson<RunError>(run.errorJson);
  return {
    runId: run.id,
    projectId: run.projectId,
    workflowKey: run.workflowKey,
    title: run.title,
    artifactHash: run.artifactHash,
    status: run.status,
    origin: {
      worktreeId: run.originWorktreeId,
      worktreePath: run.originWorktreePath,
      surfaceId: run.originSurfaceId,
      paneId: run.originPaneId,
      agentSessionId: run.originAgentSessionId,
    },
    placement: {
      source: placement.source,
      request: placement.request,
      baseCommit: placement.baseCommit,
    },
    worktreeId: run.worktreeId,
    worktreePath: run.worktreePath,
    setupDone: run.setupDone,
    surfaceId: run.surfaceId,
    current:
      leaf && invocation
        ? {
            executionId: leaf.id,
            invocationId: leaf.invocationId,
            graphKey: invocation.graphKey,
            nodeId: leaf.nodeId,
            nodeKind: leaf.nodeKind,
            label: leaf.label,
            wait: leaf.status === 'waiting' ? waitOf(leaf) : null,
          }
        : null,
    uiFeedback: ui ? fromJson<WorkflowUiFeedbackDto>(ui.dataJson) : null,
    error,
    outcome: fromJson<Outcome>(run.outcomeJson),
    controls: controlsOf(run, error),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    endedAt: run.endedAt,
  };
}

export function runSummaryById(db: Db, runId: number): WorkflowRunSummary | null {
  const run = getRun(db, runId);
  return run ? runSummary(db, run) : null;
}

/**
 * Which controls the runtime accepts now. Resume and Retry need a surface to continue into; the one
 * exception is retrying a failed preparation, which may still be about to create its surface.
 */
export function controlsOf(run: RunRow, error: RunError | null): WorkflowRunControls {
  const attached = run.surfaceId !== null;
  return {
    pause: run.status === 'running' || run.status === 'waiting',
    resume: run.status === 'paused' && attached,
    retry: run.status === 'failed' && (attached || error?.stage === 'environment'),
    cancel: ['preparing', 'running', 'waiting', 'paused', 'failed'].includes(run.status),
    dismiss: ['completed', 'failed', 'cancelled'].includes(run.status) && attached,
  };
}

export function invocationDto(row: InvocationRow): WorkflowGraphInvocationDto {
  return {
    invocationId: row.id,
    parentExecutionId: row.parentExecutionId,
    graphKey: row.graphKey,
    depth: row.depth,
    label: row.label,
    status: row.status,
    parameters: fromJson(row.parametersJson),
    state: fromJson(row.stateJson),
    outcome: fromJson<Outcome>(row.outcomeJson),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

export function executionSummaryDto(row: ExecutionRow): WorkflowExecutionSummaryDto {
  return {
    executionId: row.id,
    runId: row.runId,
    invocationId: row.invocationId,
    nodeId: row.nodeId,
    nodeKind: row.nodeKind,
    visitIndex: row.visitIndex,
    label: row.label,
    artifactHash: row.artifactHash,
    status: row.status,
    retryOf: row.retryOf,
    wait: waitOf(row),
    routedTo: fromJson<{ readonly to: string }>(row.decisionJson)?.to ?? null,
    childInvocationId: row.childInvocationId,
    checkpointId: row.checkpointId,
    error: fromJson<RunError>(row.errorJson),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

export function executionDetailDto(
  row: ExecutionRow,
  operations: readonly OperationRow[],
): WorkflowExecutionDetailDto {
  return {
    ...executionSummaryDto(row),
    result: fromJson(row.resultJson),
    event: fromJson(row.eventJson),
    decision: fromJson(row.decisionJson),
    stateAfter: fromJson(row.stateAfterJson),
    operations: operations.map(operationDto),
  };
}

export function operationDto(row: OperationRow): WorkflowOperationDto {
  return {
    operationId: row.id,
    runId: row.runId,
    executionId: row.executionId,
    seq: row.seq,
    kind: row.kind,
    agentSessionId: row.agentSessionId,
    paneId: row.paneId,
    harness: row.harness as AgentHarness | null,
    model: row.model,
    effort: row.effort,
    request: fromJson(row.requestJson),
    status: row.status,
    responseText: row.responseText,
    result: fromJson(row.resultJson),
    harnessSessionId: row.harnessSessionId,
    usage: fromJson<WorkflowOperationUsage>(row.usageJson),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

export function checkpointDto(row: CheckpointRow): WorkflowCheckpointDto {
  return {
    checkpointId: row.id,
    runId: row.runId,
    executionId: row.executionId,
    title: row.title,
    commitSha: row.commitSha,
    createdAt: row.createdAt,
    scopes: fromJson<CheckpointScope[]>(row.scopesJson),
  };
}

export function checkpointSummaryDto(row: CheckpointRow): WorkflowCheckpointSummaryDto {
  const { scopes, ...checkpoint } = checkpointDto(row);
  return {
    ...checkpoint,
    scopes: scopes.map(({ files, ...scope }) => ({ ...scope, fileCount: files.length })),
  };
}

export function eventDto(row: EventRow): WorkflowEventDto {
  return {
    eventId: row.id,
    runId: row.runId,
    executionId: row.executionId,
    at: row.at,
    category: row.category,
    kind: row.kind,
    message: row.message,
    data: fromJson(row.dataJson),
  };
}

/** What a suspended execution waits for, read from the result its node function returned. */
export function waitOf(row: ExecutionRow): WorkflowWaitDto | null {
  const result = fromJson<SavedResult>(row.resultJson);
  if (!result || result.type !== 'suspend') return null;
  const wait = result.wait;
  switch (wait.kind) {
    case 'agent_turn':
      return {
        kind: 'agent_turn',
        target: { agentSessionId: wait.target.agentSessionId, sentAt: wait.target.sentAt },
      };
    case 'user_continue':
      return wait.label === undefined
        ? { kind: 'user_continue' }
        : { kind: 'user_continue', label: wait.label };
    case 'user_input':
      return { kind: 'user_input', questions: wait.questions };
    case 'headless_agent':
      return {
        kind: 'headless_agent',
        operations: wait.operations.map((handle) => ({ operationId: handle.operationId })),
      };
  }
}

/** A page of rows in id order, fetched with one extra row to learn whether more exist. */
export function page<Row extends { readonly id: number }, Item>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => Item,
): { readonly items: Item[]; readonly nextCursor: number | null } {
  const items = rows.slice(0, limit);
  return {
    items: items.map(map),
    nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  };
}
