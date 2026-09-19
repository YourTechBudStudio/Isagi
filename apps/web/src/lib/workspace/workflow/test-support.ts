import type {
  ListRunExecutionsOutput,
  ListWorkflowEventsOutput,
  WorkflowEvidenceDto,
  WorkflowExecutionDto,
  WorkflowFrameDto,
  WorkflowOperationDto,
  WorkflowRunSummary,
  WorkflowRunTransitionDelta,
  WorkflowTransitionDto,
} from '@isagi/contracts';

/**
 * Shared v2 wire fixtures.
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
    workflowKey: 'review',
    title: 'Review',
    rootGraphKey: 'root',
    status: 'running',
    paused: false,
    revision: 1,
    artifactHash: 'sha256:pin-1',
    pinOrdinal: 1,
    outcome: null,
    position: { kind: 'graph_entry', frameId: 1 },
    activeNode: null,
    blockingWait: null,
    blockedOperation: null,
    failure: null,
    stopSummary: null,
    uiFeedback: null,
    attachment: { worktreeId: 10, surfaceId: 101 },
    origin: placement(),
    destination: placement(),
    // The common case, so tests that care about placement override it: nobody chose anything, the
    // run went where it was launched from, and preparing that allocated nothing worth a receipt.
    preparation: {
      source: 'default',
      request: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
      baseCommit: null,
      status: 'prepared',
      worktree: null,
      setup: null,
      surface: null,
      failure: null,
    },
    controls: {
      pause: true,
      resume: false,
      retry: false,
      cancel: true,
      dismiss: false,
      advance: false,
    },
    createdAt: at,
    updatedAt: at,
    endedAt: null,
    ...overrides,
  };
}

export function workflowExecutionFixture(
  overrides: Partial<WorkflowExecutionDto> = {},
): WorkflowExecutionDto {
  return {
    executionId: 1,
    frameId: 1,
    parentExecutionId: null,
    graphKey: 'root',
    depth: 0,
    nodeId: 'writer',
    nodeKind: 'operation',
    visitIndex: 0,
    status: 'running',
    displayName: null,
    labelDiagnostic: null,
    childFrameId: null,
    childFrame: null,
    startedAt: at,
    endedAt: null,
    endCertainty: 'observed',
    callbackStartedAt: at,
    callbackEndedAt: null,
    waitArmedAt: null,
    waitDeliveredAt: null,
    attemptCount: 1,
    firstArtifactHash: 'sha256:pin-1',
    latestArtifactHash: 'sha256:pin-1',
    latestAttempt: null,
    priorFailures: [],
    routing: null,
    wait: null,
    operationSummary: { count: 0, unresolved: 0, evidenceCaptured: 0, capabilities: [] },
    stateInRef: null,
    candidateRef: null,
    updateRef: null,
    stateOutRef: null,
    ...overrides,
  };
}

/**
 * One captured record.
 *
 * Defaults to the plainest thing a capture can be — a text record with no source — so a test that
 * cares about attribution, labels or a media type states only the part it is about.
 */
export function workflowEvidenceFixture(
  overrides: Partial<WorkflowEvidenceDto> = {},
): WorkflowEvidenceDto {
  return {
    evidenceKey: 'wev_1',
    frameId: 1,
    executionId: 1,
    attemptId: 1,
    operationKey: 'wop_1',
    title: 'A captured thing',
    role: 'note',
    labels: {},
    content: {
      kind: 'text',
      mediaType: 'text/markdown',
      byteSize: 120,
      contentRef: 'sha256:aaaa',
      sourcePath: null,
    },
    source: { kind: 'none' },
    artifactHash: 'sha256:pin-1',
    capturedAt: at,
    ...overrides,
  };
}

export function workflowFrameFixture(overrides: Partial<WorkflowFrameDto> = {}): WorkflowFrameDto {
  return {
    frameId: 1,
    parentExecutionId: null,
    parentFrameId: null,
    graphKey: 'root',
    entryArtifactHash: 'sha256:pin-1',
    depth: 0,
    status: 'active',
    displayName: null,
    labelDiagnostic: null,
    entry: null,
    outputEvaluation: null,
    output: null,
    enteredAt: at,
    completedAt: null,
    parametersRef: null,
    stateRef: null,
    executionCount: 1,
    ...overrides,
  };
}

export function workflowOperationFixture(
  overrides: Partial<WorkflowOperationDto> = {},
): WorkflowOperationDto {
  return {
    operationKey: 'op-1',
    frameId: 1,
    executionId: 1,
    attemptId: 1,
    capability: 'send_agent_prompt',
    callIndex: 0,
    state: 'dispatched',
    stage: null,
    requestRef: { inline: { prompt: 'hello' } },
    requestHash: 'sha256:req-1',
    receiptRef: null,
    resultRef: null,
    target: { agentSessionId: 7, paneId: null, ptyProcessId: null, turnId: null },
    provenance: {
      harness: 'claude',
      model: null,
      effort: null,
      harnessSessionId: null,
      attribution: 'not_applicable',
      cwd: '/tmp/worktree',
      runtime: { runtimeId: 'runtime-1', incarnationId: 'incarnation-1' },
      usage: null,
      artifactHash: 'sha256:pin-1',
    },
    stop: { state: 'not_requested', detail: null, requestedAt: null, settledAt: null },
    uncertaintyDetail: null,
    lateEvidenceRef: null,
    createdAt: at,
    dispatchedAt: at,
    settledAt: null,
    ...overrides,
  };
}

export function workflowTransitionFixture(
  overrides: Partial<WorkflowTransitionDto> = {},
): WorkflowTransitionDto {
  return {
    revision: 1,
    recordedAt: at,
    kind: 'node_dispatched',
    frameId: 1,
    executionId: 1,
    attemptId: null,
    operationKey: null,
    waitId: null,
    artifactHash: null,
    detailRef: null,
    stateRef: null,
    ...overrides,
  };
}

export function workflowDeltaFixture(input: {
  readonly runId?: number;
  readonly revision: number;
  readonly transition?: Partial<WorkflowTransitionDto>;
  readonly executions?: readonly WorkflowExecutionDto[];
  readonly frames?: readonly WorkflowFrameDto[];
  readonly operations?: readonly WorkflowOperationDto[];
  readonly summary?: WorkflowRunSummary;
}): WorkflowRunTransitionDelta {
  return {
    runId: input.runId ?? 1,
    revision: input.revision,
    transition: workflowTransitionFixture({ ...input.transition, revision: input.revision }),
    changes: {
      executions: input.executions ?? [],
      frames: input.frames ?? [],
      operations: input.operations ?? [],
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    },
  };
}

export function executionsPageFixture(input: {
  readonly items?: readonly WorkflowExecutionDto[];
  readonly nextCursor?: string | null;
  readonly highWaterRevision: number;
  readonly coverageRevision?: number;
  readonly complete?: boolean;
  readonly frames?: readonly WorkflowFrameDto[];
  readonly operations?: readonly WorkflowOperationDto[];
  readonly summary?: WorkflowRunSummary;
}): ListRunExecutionsOutput {
  const coverageRevision = input.coverageRevision ?? input.highWaterRevision;
  return {
    items: input.items ?? [],
    nextCursor: input.nextCursor ?? null,
    boundary: {
      highWaterRevision: input.highWaterRevision,
      coverageRevision,
      snapshotToken: `token-${input.highWaterRevision}`,
      complete: input.complete ?? coverageRevision === input.highWaterRevision,
    },
    changes: {
      frames: input.frames ?? [],
      operations: input.operations ?? [],
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    },
  };
}

export function eventsPageFixture(input: {
  readonly items?: readonly WorkflowRunTransitionDelta[];
  readonly nextCursor?: string | null;
  readonly highWaterRevision: number;
  readonly coverageRevision?: number;
  readonly complete?: boolean;
}): ListWorkflowEventsOutput {
  const coverageRevision = input.coverageRevision ?? input.highWaterRevision;
  return {
    items: input.items ?? [],
    nextCursor: input.nextCursor ?? null,
    boundary: {
      highWaterRevision: input.highWaterRevision,
      coverageRevision,
      snapshotToken: `token-${input.highWaterRevision}`,
      complete: input.complete ?? coverageRevision === input.highWaterRevision,
    },
  };
}

function placement() {
  return {
    worktreeId: 10,
    worktreePath: '/repo/isagi',
    surfaceId: 101,
    paneId: null,
    agentSessionId: null,
    available: true,
  };
}
