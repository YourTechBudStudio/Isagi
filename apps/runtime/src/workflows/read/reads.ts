import type { WorkflowStructureDescriptor } from '@yourtechbudstudio/isagi-workflow-verifier/structure';

import type {
  GetWorkflowCheckpointOutput,
  GetWorkflowExecutionOutput,
  GetWorkflowOperationOutput,
  GetWorkflowRunOutput,
  GetWorkflowStructureOutput,
  ListWorkflowCheckpointsOutput,
  ListWorkflowCheckpointsQuery,
  ListWorkflowEventsOutput,
  ListWorkflowEventsQuery,
  ListWorkflowOperationsOutput,
  ListWorkflowOperationsQuery,
  ListWorkflowRunsOutput,
  ListWorkflowRunsQuery,
  WorkflowRunSummary,
} from '@isagi/contracts';

import { WorkflowEngineError } from '../errors.js';
import { getCheckpoint, listCheckpoints } from '../store/checkpoints.js';
import { listEvents } from '../store/events.js';
import { getOperation, listOperations } from '../store/operations.js';
import { fromJson, type Db } from '../store/rows.js';
import { getArtifact, getRun, listAttachedRuns, listRuns } from '../store/runs.js';
import { getExecution, listExecutions, listInvocations } from '../store/tree.js';
import {
  checkpointDto,
  checkpointSummaryDto,
  eventDto,
  executionDetailDto,
  executionSummaryDto,
  invocationDto,
  operationDto,
  page,
  runSummary,
} from './mappers.js';

/**
 * The read routes: plain queries plus mappers. Nothing here changes a row, imports workflow code,
 * or talks to an agent.
 */

const defaultLimit = 100;

export function listRunSummaries(db: Db, query: ListWorkflowRunsQuery): ListWorkflowRunsOutput {
  const limit = query.limit ?? defaultLimit;
  return page(listRuns(db, { ...query, limit: limit + 1 }), limit, (row) => runSummary(db, row));
}

export function listAttachedSummaries(db: Db): readonly WorkflowRunSummary[] {
  return listAttachedRuns(db).map((row) => runSummary(db, row));
}

export function getRunDetail(db: Db, runId: number): GetWorkflowRunOutput {
  const run = requireRun(db, runId);
  return {
    run: runSummary(db, run),
    inputs: fromJson<Record<string, unknown>>(run.inputsJson),
    parameters: fromJson<unknown>(run.parametersJson),
    invocations: listInvocations(db, runId).map(invocationDto),
    executions: listExecutions(db, runId).map(executionSummaryDto),
  };
}

export function getRunStructure(
  db: Db,
  runId: number,
  artifactHash: string | undefined,
): GetWorkflowStructureOutput {
  const run = requireRun(db, runId);
  const artifact = getArtifact(db, artifactHash ?? run.artifactHash);
  // Any build the run has used can be named: its current one, or one an execution ran under.
  const used =
    artifact !== null &&
    (artifact.hash === run.artifactHash ||
      listExecutions(db, runId).some((execution) => execution.artifactHash === artifact.hash));
  if (!artifact || !used) {
    throw new WorkflowEngineError({
      code: 'workflow_load_failed',
      message: `Run ${runId} has never used a build with hash ${artifactHash}.`,
      workflowRunId: runId,
      workflowKey: run.workflowKey,
    });
  }
  return {
    artifactHash: artifact.hash,
    workflowKey: artifact.workflowKey,
    sdkVersion: artifact.sdkVersion,
    verifierVersion: artifact.verifierVersion,
    contractVersion: artifact.contractVersion,
    firstSeenAt: artifact.firstSeenAt,
    descriptor: fromJson<WorkflowStructureDescriptor>(
      artifact.structureJson,
    ) as GetWorkflowStructureOutput['descriptor'],
  };
}

export function listRunEvents(
  db: Db,
  runId: number,
  query: ListWorkflowEventsQuery,
): ListWorkflowEventsOutput {
  requireRun(db, runId);
  const limit = query.limit ?? defaultLimit;
  return page(listEvents(db, { runId, cursor: query.cursor, limit: limit + 1 }), limit, eventDto);
}

export function listRunOperations(
  db: Db,
  runId: number,
  query: ListWorkflowOperationsQuery,
): ListWorkflowOperationsOutput {
  requireRun(db, runId);
  const limit = query.limit ?? defaultLimit;
  return page(
    listOperations(db, {
      runId,
      agentSessionId: query.agentSessionId,
      executionId: query.executionId,
      cursor: query.cursor,
      limit: limit + 1,
    }),
    limit,
    operationDto,
  );
}

export function getExecutionDetail(db: Db, executionId: number): GetWorkflowExecutionOutput {
  const execution = getExecution(db, executionId);
  if (!execution) {
    throw new WorkflowEngineError({
      code: 'workflow_execution_not_found',
      message: `Execution ${executionId} was not found.`,
      executionId,
    });
  }
  return {
    execution: executionDetailDto(execution, listOperations(db, { executionId })),
  };
}

export function getOperationDetail(db: Db, operationId: number): GetWorkflowOperationOutput {
  const operation = getOperation(db, operationId);
  if (!operation) {
    throw new WorkflowEngineError({
      code: 'workflow_operation_not_found',
      message: `Operation ${operationId} was not found.`,
      operationId,
    });
  }
  return { operation: operationDto(operation) };
}

export function listRunCheckpoints(
  db: Db,
  runId: number,
  query: ListWorkflowCheckpointsQuery,
): ListWorkflowCheckpointsOutput {
  requireRun(db, runId);
  const limit = query.limit ?? defaultLimit;
  return page(
    listCheckpoints(db, {
      runId,
      executionId: query.executionId,
      scope: query.scope,
      cursor: query.cursor,
      limit: limit + 1,
    }),
    limit,
    checkpointSummaryDto,
  );
}

export function getCheckpointDetail(db: Db, checkpointId: number): GetWorkflowCheckpointOutput {
  const checkpoint = getCheckpoint(db, checkpointId);
  if (!checkpoint) {
    throw new WorkflowEngineError({
      code: 'workflow_checkpoint_not_found',
      message: `Checkpoint ${checkpointId} was not found.`,
      checkpointId,
    });
  }
  return { checkpoint: checkpointDto(checkpoint) };
}

function requireRun(db: Db, runId: number) {
  const run = getRun(db, runId);
  if (!run) {
    throw new WorkflowEngineError({
      code: 'workflow_run_not_found',
      message: `Workflow run ${runId} was not found.`,
      workflowRunId: runId,
    });
  }
  return run;
}
