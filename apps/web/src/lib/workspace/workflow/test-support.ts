import type {
  GetWorkflowRunOutput,
  WorkflowCheckpointDto,
  WorkflowCheckpointSummaryDto,
  WorkflowEventDto,
  WorkflowExecutionDetailDto,
  WorkflowExecutionSummaryDto,
  WorkflowGraphInvocationDto,
  WorkflowOperationDto,
  WorkflowRunSummary,
} from '@isagi/contracts';

/**
 * Shared wire fixtures.
 *
 * Complete records rather than partials cast into shape: the point of these tests is the client's
 * behaviour against the real contract, and a fixture that quietly omits a field would let a reader
 * of a required value pass here and fail in the product.
 */

const at = '2026-09-15T10:00:00.000Z';

export function workflowSummaryFixture(
  overrides: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary {
  return {
    runId: 1,
    projectId: 1,
    workflowKey: 'review',
    title: 'Review',
    artifactHash: 'sha256:build-1',
    status: 'running',
    origin: {
      worktreeId: 10,
      worktreePath: '/work/repo',
      surfaceId: 101,
      paneId: null,
      agentSessionId: null,
    },
    placement: {
      source: 'default',
      request: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
      baseCommit: null,
    },
    worktreeId: 10,
    worktreePath: '/work/repo',
    setupDone: false,
    surfaceId: 101,
    current: null,
    uiFeedback: null,
    error: null,
    outcome: null,
    controls: { pause: true, resume: false, retry: false, cancel: true, dismiss: false },
    createdAt: at,
    updatedAt: at,
    endedAt: null,
    ...overrides,
  };
}

export function workflowInvocationFixture(
  overrides: Partial<WorkflowGraphInvocationDto> = {},
): WorkflowGraphInvocationDto {
  return {
    invocationId: 1,
    parentExecutionId: null,
    graphKey: 'root',
    depth: 0,
    label: null,
    status: 'running',
    parameters: null,
    state: {},
    outcome: null,
    startedAt: at,
    endedAt: null,
    ...overrides,
  };
}

export function workflowExecutionFixture(
  overrides: Partial<WorkflowExecutionSummaryDto> = {},
): WorkflowExecutionSummaryDto {
  return {
    executionId: 1,
    runId: 1,
    invocationId: 1,
    nodeId: 'plan',
    nodeKind: 'operation',
    visitIndex: 0,
    label: null,
    artifactHash: 'sha256:build-1',
    status: 'completed',
    retryOf: null,
    wait: null,
    routedTo: null,
    childInvocationId: null,
    checkpointId: null,
    error: null,
    startedAt: at,
    endedAt: at,
    ...overrides,
  };
}

export function workflowExecutionDetailFixture(
  overrides: Partial<WorkflowExecutionDetailDto> = {},
): WorkflowExecutionDetailDto {
  return {
    ...workflowExecutionFixture(),
    result: { type: 'complete', update: {} },
    event: null,
    decision: null,
    stateAfter: null,
    operations: [],
    ...overrides,
  };
}

export function workflowOperationFixture(
  overrides: Partial<WorkflowOperationDto> = {},
): WorkflowOperationDto {
  return {
    operationId: 1,
    runId: 1,
    executionId: 1,
    seq: 0,
    kind: 'send_prompt',
    agentSessionId: 7,
    paneId: 3,
    harness: 'claude',
    model: null,
    effort: null,
    request: { prompt: 'Write the plan.' },
    status: 'completed',
    responseText: null,
    result: null,
    harnessSessionId: null,
    usage: null,
    startedAt: at,
    endedAt: at,
    ...overrides,
  };
}

export function workflowEventFixture(overrides: Partial<WorkflowEventDto> = {}): WorkflowEventDto {
  return {
    eventId: 1,
    runId: 1,
    executionId: null,
    at,
    category: 'run',
    kind: 'run_launched',
    message: 'Launched Review',
    data: null,
    ...overrides,
  };
}

export function workflowRunDetailFixture(
  overrides: Partial<GetWorkflowRunOutput> = {},
): GetWorkflowRunOutput {
  return {
    run: workflowSummaryFixture(),
    inputs: {},
    invocations: [workflowInvocationFixture()],
    executions: [],
    ...overrides,
  };
}

export function workflowCheckpointSummaryFixture(
  overrides: Partial<WorkflowCheckpointSummaryDto> = {},
): WorkflowCheckpointSummaryDto {
  return {
    checkpointId: 1,
    runId: 1,
    executionId: 1,
    title: 'Plan saved',
    commitSha: 'a'.repeat(40),
    createdAt: at,
    scopes: [
      { scope: 'plan', kind: 'file', path: 'PLAN.md', exclude: [], missing: false, fileCount: 1 },
    ],
    ...overrides,
  };
}

export function workflowCheckpointFixture(
  overrides: Partial<WorkflowCheckpointDto> = {},
): WorkflowCheckpointDto {
  return {
    checkpointId: 1,
    runId: 1,
    executionId: 1,
    title: 'Plan saved',
    commitSha: 'a'.repeat(40),
    createdAt: at,
    scopes: [
      {
        scope: 'plan',
        kind: 'file',
        path: 'PLAN.md',
        exclude: [],
        missing: false,
        files: [{ path: 'PLAN.md', sha256: 'b'.repeat(64), sizeBytes: 12, executable: false }],
      },
    ],
    ...overrides,
  };
}
