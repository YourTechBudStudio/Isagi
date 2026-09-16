import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowWaitKinds } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Schema } from 'effect';

import type { ApiEndpoint } from '../api/types.js';
import { runtimeEventSchema } from '../runtime-events/types.js';
import { workflowsEndpoints } from './api.js';
import {
  workflowAttemptSchema,
  workflowExecutionSchema,
  workflowFrameSchema,
  workflowOperationSchema,
  workflowTransitionSchema,
} from './executions.js';
import {
  workflowDiagnosticDetailSchema,
  workflowPayloadSlotSchema,
  workflowWaitKindSchema,
} from './primitives.js';
import {
  advanceWorkflowInputSchema,
  listFrameExecutionsOutputSchema,
  listRunExecutionsOutputSchema,
  listWorkflowEventsOutputSchema,
  listWorkflowRunsQuerySchema,
  workflowDescriptorResultSchema,
  workflowRunControlOutputSchema,
} from './requests.js';
import {
  workflowRunPositionSchema,
  workflowRunSummarySchema,
  workflowRunTransitionDeltaSchema,
} from './runs.js';

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown): A =>
  Schema.decodeUnknownSync(schema)(value as I);

const at = '2026-01-01T00:00:00.000Z';

const placement = {
  worktreeId: 1,
  worktreePath: '/w',
  surfaceId: 2,
  paneId: null,
  agentSessionId: null,
  available: true,
};

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationKey: 'op-1',
    frameId: 1,
    executionId: 4,
    attemptId: 9,
    capability: 'run_headless_agent',
    callIndex: 0,
    state: 'dispatched',
    stage: 'started',
    requestRef: { payloadRef: 'sha256:aaa', byteSize: 2048, mediaType: 'application/json' },
    requestHash: 'sha256:bbb',
    receiptRef: null,
    resultRef: null,
    target: { agentSessionId: 7, paneId: 12, ptyProcessId: 29, turnId: 't-88' },
    stop: { state: 'not_requested', detail: null, requestedAt: null, settledAt: null },
    uncertaintyDetail: null,
    lateEvidenceRef: null,
    createdAt: at,
    dispatchedAt: at,
    settledAt: null,
    ...overrides,
  };
}

const summary = {
  runId: 1,
  workflowKey: 'reviewed-document',
  title: 'Reviewed document',
  rootGraphKey: 'Story',
  status: 'waiting',
  paused: false,
  revision: 42,
  artifactHash: 'sha256:pin4',
  pinOrdinal: 4,
  outcome: null,
  position: { kind: 'awaiting_wait', frameId: 1, executionId: 4, waitId: 9 },
  activeNode: {
    frameId: 1,
    graphKey: 'Story',
    nodeId: 'askWriter',
    nodeKind: 'operation',
    executionId: 4,
    visitIndex: 1,
    displayName: 'Ask the writer',
  },
  blockingWait: {
    waitId: 9,
    kind: 'user_input',
    label: null,
    frameId: 1,
    executionId: 4,
    questions: [{ kind: 'text', key: 'note', label: 'Note' }],
    armedAt: at,
  },
  blockedOperation: null,
  failure: null,
  stopSummary: null,
  uiFeedback: null,
  attachment: { worktreeId: 1, surfaceId: 2 },
  origin: placement,
  destination: placement,
  controls: {
    pause: true,
    resume: false,
    retry: false,
    cancel: true,
    dismiss: false,
    advance: true,
  },
  createdAt: at,
  updatedAt: at,
  endedAt: null,
};

test('a representative run summary decodes, controls and all', () => {
  const decoded = decode(workflowRunSummarySchema, summary);
  assert.equal(decoded.pinOrdinal, 4);
  assert.equal(decoded.controls.advance, true);
  assert.equal(decoded.blockingWait?.waitId, 9);
});

test('a summary carrying an uncertain operation and an honest stop report decodes', () => {
  const decoded = decode(workflowRunSummarySchema, {
    ...summary,
    status: 'blocked',
    blockedOperation: { operationKey: 'op-1', frameId: 1, executionId: 4 },
    stopSummary: { requested: 2, confirmed: 1, failed: 0, unsupported: 0, pending: 1 },
  });
  assert.equal(decoded.blockedOperation?.operationKey, 'op-1');
  // The point of the counts: one stop is still outstanding, and the DTO says so.
  assert.equal(decoded.stopSummary?.pending, 1);
});

test('a segment failure decodes with a code from the closed set, and an invented code does not', () => {
  const failing = {
    ...summary,
    status: 'failed',
    failure: {
      code: 'reduction_failed',
      message: 'unknown state field "ghost"',
      segmentKind: 'node_callback',
      attemptId: 9,
      frameId: 1,
      executionId: 4,
    },
  };
  assert.equal(decode(workflowRunSummarySchema, failing).failure?.code, 'reduction_failed');
  assert.throws(() =>
    decode(workflowRunSummarySchema, {
      ...failing,
      failure: { ...failing.failure, code: 'something_went_wrong' },
    }),
  );
});

test('a failed display-name capture is not a segment failure code', () => {
  // It is a diagnostic; the segment still ran. Keeping it out of this set is the contract.
  assert.throws(() =>
    decode(workflowRunSummarySchema, {
      ...summary,
      status: 'failed',
      failure: {
        code: 'label_failed',
        message: 'label threw',
        segmentKind: 'node_callback',
        attemptId: 9,
        frameId: 1,
        executionId: 4,
      },
    }),
  );
});

test('a payload slot distinguishes absent, recorded null, inline, and a sized reference', () => {
  assert.equal(decode(workflowPayloadSlotSchema, null), null);
  // A step that produced JSON null is not the same as a step that produced nothing.
  assert.deepEqual(decode(workflowPayloadSlotSchema, { inline: null }), { inline: null });
  assert.deepEqual(decode(workflowPayloadSlotSchema, { inline: { note: 'hi' } }), {
    inline: { note: 'hi' },
  });
  const sized = decode(workflowPayloadSlotSchema, {
    payloadRef: 'sha256:abc',
    byteSize: 4096,
    mediaType: 'application/json',
  });
  assert.equal(sized && 'payloadRef' in sized ? sized.byteSize : null, 4096);
  // No filesystem path ever reaches a client: the reference is opaque, and nothing more than the
  // three declared fields survives decoding.
  const withPath = decode(workflowPayloadSlotSchema, {
    payloadRef: 'sha256:abc',
    byteSize: 1,
    mediaType: 'application/json',
    path: '/var/lib/isagi/payloads/abc',
  });
  assert.deepEqual(Object.keys(withPath ?? {}).sort(), ['byteSize', 'mediaType', 'payloadRef']);
});

const execution = {
  executionId: 4,
  frameId: 1,
  parentExecutionId: null,
  graphKey: 'Story',
  depth: 0,
  nodeId: 'askWriter',
  nodeKind: 'operation',
  visitIndex: 1,
  status: 'awaiting',
  displayName: 'Ask the writer',
  labelDiagnostic: null,
  childFrameId: null,
  childFrame: null,
  startedAt: at,
  endedAt: null,
  endCertainty: 'observed',
  callbackStartedAt: at,
  callbackEndedAt: at,
  waitArmedAt: at,
  waitDeliveredAt: null,
  attemptCount: 2,
  firstArtifactHash: 'sha256:pin3',
  latestArtifactHash: 'sha256:pin4',
  latestAttempt: {
    attemptId: 9,
    attemptIndex: 2,
    artifactHash: 'sha256:pin4',
    status: 'running',
    invocationKind: 'retry',
    failure: null,
    recoveryMode: 'reuse_producer_output',
    producerArtifactHash: 'sha256:pin3',
  },
  priorFailures: [
    {
      attemptId: 8,
      attemptIndex: 1,
      segmentKind: 'node_callback',
      artifactHash: 'sha256:pin3',
      failure: { code: 'reduction_failed', message: 'boom', detail: null },
      repairedByAttemptIndex: 2,
      repairedByArtifactHash: 'sha256:pin4',
    },
  ],
  routing: null,
  wait: {
    waitId: 9,
    kind: 'user_input',
    status: 'armed',
    label: null,
    questions: [{ kind: 'text', key: 'note', label: 'Note' }],
    answers: null,
    armedAt: at,
    deliveredAt: null,
  },
  operationSummary: { count: 2, unresolved: 1, capabilities: ['run_headless_agent'] },
  stateInRef: { inline: { reviewRound: 1 } },
  candidateRef: null,
  updateRef: null,
  stateOutRef: null,
};

test('an execution row carries the visit, both pins, the repair evidence, and its wait', () => {
  const decoded = decode(workflowExecutionSchema, execution);
  assert.equal(decoded.visitIndex, 1);
  // A visit that started under one pin and was repaired under another reads as v3 → v4.
  assert.notEqual(decoded.firstArtifactHash, decoded.latestArtifactHash);
  // The repair is still explained even though the latest attempt has not failed.
  assert.equal(decoded.priorFailures[0]?.repairedByAttemptIndex, 2);
  assert.deepEqual([...decoded.operationSummary.capabilities], ['run_headless_agent']);
});

test('an execution summarizes capabilities it actually called, not invented ones', () => {
  assert.throws(() =>
    decode(workflowExecutionSchema, {
      ...execution,
      operationSummary: { count: 1, unresolved: 0, capabilities: ['http.get'] },
    }),
  );
});

test('a transition delta carries several changed operations at once, not one optional row', () => {
  const delta = decode(workflowRunTransitionDeltaSchema, {
    runId: 1,
    revision: 43,
    transition: {
      revision: 43,
      recordedAt: at,
      kind: 'operation_settled',
      frameId: 1,
      executionId: 4,
      attemptId: 9,
      operationKey: 'op-1',
      waitId: null,
      artifactHash: 'sha256:pin4',
      detailRef: null,
      stateRef: null,
    },
    changes: {
      executions: [execution],
      frames: [],
      operations: [
        operation({ state: 'completed', settledAt: at }),
        operation({ operationKey: 'op-2', callIndex: 1, state: 'interrupted', settledAt: at }),
      ],
      // The summary a delta carries is the state that transition produced, so it is at the
      // delta's own revision.
      summary: { ...summary, revision: 43 },
    },
  });
  assert.equal(delta.changes.operations.length, 2);
  assert.equal(delta.changes.summary?.revision, 43);
});

test('a delta cannot disagree with itself about which revision it is', () => {
  // The client applies a delta only when its revision is exactly one past the last applied, so a
  // self-contradictory delta would desynchronise that rule while decoding cleanly.
  const base = {
    runId: 1,
    revision: 43,
    transition: { ...transition, revision: 43 },
    changes: { executions: [], frames: [], operations: [] },
  };
  assert.doesNotThrow(() => decode(workflowRunTransitionDeltaSchema, base));
  assert.throws(() => decode(workflowRunTransitionDeltaSchema, { ...base, revision: 99 }));
  assert.throws(() =>
    decode(workflowRunTransitionDeltaSchema, {
      ...base,
      transition: { ...transition, revision: 42 },
    }),
  );
  // A stale summary under a newer delta is the same class of error.
  assert.throws(() =>
    decode(workflowRunTransitionDeltaSchema, {
      ...base,
      changes: { ...base.changes, summary: { ...summary, revision: 42 } },
    }),
  );
});

test('a delta cannot disagree with itself about which run changed', () => {
  // Routing uses the envelope's run id while the summary is the authoritative state, so a
  // disagreement would leave a client to invent precedence between two identities.
  const base = {
    runId: 1,
    revision: 43,
    transition: { ...transition, revision: 43 },
    changes: { executions: [], frames: [], operations: [] },
  };
  const withSummary = (runId: number) => ({
    ...base,
    changes: { ...base.changes, summary: { ...summary, runId, revision: 43 } },
  });
  assert.equal(decode(workflowRunTransitionDeltaSchema, withSummary(1)).changes.summary?.runId, 1);
  assert.throws(() => decode(workflowRunTransitionDeltaSchema, withSummary(2)));
});

test('a recovery boundary cannot acknowledge revisions it did not deliver', () => {
  const boundary = {
    highWaterRevision: 120,
    coverageRevision: 0,
    snapshotToken: 'snap-1',
    complete: false,
  };
  const page = (extra: Record<string, unknown>) => ({
    items: [],
    nextCursor: null,
    boundary: { ...boundary, ...extra },
  });
  assert.doesNotThrow(() => decode(listWorkflowEventsOutputSchema, page({})));
  assert.doesNotThrow(() =>
    decode(listWorkflowEventsOutputSchema, page({ coverageRevision: 120, complete: true })),
  );
  // Coverage beyond the frozen high-water mark claims history the client was never given.
  assert.throws(() => decode(listWorkflowEventsOutputSchema, page({ coverageRevision: 500 })));
  // A completed recovery that has not reached the high-water mark is the same false claim.
  assert.throws(() => decode(listWorkflowEventsOutputSchema, page({ complete: true })));
});

test('a blocked operation always names the execution it came from', () => {
  const blocked = { ...summary, status: 'blocked' as const };
  assert.doesNotThrow(() =>
    decode(workflowRunSummarySchema, {
      ...blocked,
      blockedOperation: { operationKey: 'wop_1', frameId: 1, executionId: 4 },
    }),
  );
  // An operation is only ever created inside a node callback, so a reference that names none
  // describes a row the durable model cannot produce.
  assert.throws(() =>
    decode(workflowRunSummarySchema, {
      ...blocked,
      blockedOperation: { operationKey: 'wop_1', frameId: 1, executionId: null },
    }),
  );
});

test('a delta may change nothing but the transition itself', () => {
  const delta = decode(workflowRunTransitionDeltaSchema, {
    runId: 1,
    revision: 44,
    transition: {
      revision: 44,
      recordedAt: at,
      kind: 'pause_opened',
      frameId: null,
      executionId: null,
      attemptId: null,
      operationKey: null,
      waitId: null,
      artifactHash: null,
      detailRef: null,
      stateRef: null,
    },
    changes: { executions: [], frames: [], operations: [] },
  });
  assert.equal(delta.changes.summary, undefined);
  assert.equal(delta.transition.kind, 'pause_opened');
});

test('pause boundaries and pin adoption are transition kinds, so history restores them', () => {
  for (const kind of ['pause_opened', 'pause_closed', 'retry_pin_adopted']) {
    const decoded = decode(workflowTransitionSchema, {
      revision: 1,
      recordedAt: at,
      kind,
      frameId: null,
      executionId: null,
      attemptId: null,
      operationKey: null,
      waitId: null,
      artifactHash: null,
      detailRef: null,
      stateRef: null,
    });
    assert.equal(decoded.kind, kind);
  }
});

test('an executions page reports a coverage watermark, not a cursor over unseen revisions', () => {
  const page = decode(listRunExecutionsOutputSchema, {
    items: [execution],
    nextCursor: 'opaque-cursor',
    boundary: {
      highWaterRevision: 120,
      coverageRevision: 0,
      snapshotToken: 'snap-1',
      complete: false,
    },
    changes: { frames: [], operations: [operation()], summary },
  });
  // A partially consumed recovery must not claim coverage it has not reached.
  assert.equal(page.boundary.complete, false);
  assert.equal(page.boundary.coverageRevision, 0);
  // Operation facts travel with the gap fill, so an operation-only change is recoverable.
  assert.equal(page.changes.operations.length, 1);
});

test('an events page returns complete deltas bound to the same snapshot boundary', () => {
  const page = decode(listWorkflowEventsOutputSchema, {
    items: [],
    nextCursor: null,
    boundary: {
      highWaterRevision: 120,
      coverageRevision: 120,
      snapshotToken: 'snap-1',
      complete: true,
    },
  });
  assert.equal(page.boundary.coverageRevision, 120);
});

test('a control result stays narrow and is not an alternate snapshot', () => {
  const result = decode(workflowRunControlOutputSchema, {
    runId: 1,
    accepted: true,
    status: 'ready',
    revision: 45,
    diagnostics: [],
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'accepted',
    'diagnostics',
    'revision',
    'runId',
    'status',
  ]);
});

test('a refused control carries addressable structural diagnostics', () => {
  const result = decode(workflowRunControlOutputSchema, {
    runId: 1,
    accepted: false,
    status: 'failed',
    revision: 45,
    diagnostics: [
      {
        code: 'destination_no_longer_declared',
        message: 'the saved destination is no longer declared',
        at: { graphKey: 'Story', edgeId: 'fromAskWriter' },
      },
    ],
  });
  assert.equal(result.diagnostics[0]?.at.edgeId, 'fromAskWriter');
});

test('a failed descriptor result carries diagnostics, not one free-text string', () => {
  const failure = decode(workflowDescriptorResultSchema, {
    ok: false,
    workflowKey: 'broken',
    reason: 'invalid_structure',
    diagnostics: [
      { code: 'missing_outgoing_edge', message: 'node "act" has no router', at: { nodeId: 'act' } },
    ],
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.ok === false ? failure.diagnostics.length : 0, 1);
});

test('the new load failure reasons are part of the contract', () => {
  for (const reason of ['invalid_structure', 'structure_mismatch', 'unsupported_capability']) {
    assert.doesNotThrow(() =>
      decode(workflowDescriptorResultSchema, {
        ok: false,
        workflowKey: 'w',
        reason,
        diagnostics: [],
      }),
    );
  }
});

test('the wire wait kinds are exactly the SDK wait kinds', () => {
  // Bound by test because contracts declares the literal set from the SDK's exported constant.
  for (const kind of workflowWaitKinds) {
    assert.equal(decode(workflowWaitKindSchema, kind), kind);
  }
  assert.throws(() => decode(workflowWaitKindSchema, 'workflow'), /Expected/);
});

test('a committed transition reaches clients as a runtime event, with no per-run socket', () => {
  const event = decode(runtimeEventSchema, {
    id: 'evt-1',
    type: 'workflow_run_transition',
    occurredAt: at,
    payload: {
      runId: 1,
      revision: 44,
      transition: {
        revision: 44,
        recordedAt: at,
        kind: 'node_dispatched',
        frameId: 1,
        executionId: 4,
        attemptId: 9,
        operationKey: null,
        waitId: null,
        artifactHash: 'sha256:pin4',
        detailRef: null,
        stateRef: null,
      },
      changes: { executions: [execution], frames: [], operations: [] },
    },
  });
  assert.equal(event.type, 'workflow_run_transition');
});

test('a detached run keeps its identity and loses only its surface occupancy', () => {
  const event = decode(runtimeEventSchema, {
    id: 'evt-2',
    type: 'workflow_run_detached',
    occurredAt: at,
    payload: { runId: 1, surfaceId: 2 },
  });
  assert.equal(event.type, 'workflow_run_detached');
});

test('the retired destructive and per-run-socket surfaces are gone', () => {
  assert.throws(() =>
    decode(runtimeEventSchema, {
      id: 'evt-3',
      type: 'workflow_run_cleared',
      occurredAt: at,
      payload: { runId: 1, rootRunId: 1, surfaceId: 2 },
    }),
  );
  const paths: readonly string[] = Object.values(workflowsEndpoints).map(
    (endpoint) => endpoint.path,
  );
  assert.equal(paths.includes('/workflows/runs/:runId/clear'), false);
  assert.equal(paths.includes('/workflows/runs/:runId/events-stream'), false);
  assert.ok(paths.includes('/workflows/runs/:runId/cancel'));
  assert.ok(paths.includes('/workflows/runs/:runId/dismiss'));
});

test('every retained read route is declared, including the ones the web client never calls', () => {
  const ids: readonly string[] = Object.values(workflowsEndpoints).map((endpoint) => endpoint.id);
  for (const id of [
    'workflows.listRuns',
    'workflows.getStructure',
    'workflows.listVersions',
    'workflows.listFrames',
    'workflows.listFrameExecutions',
    'workflows.listExecutions',
    'workflows.listAttempts',
    'workflows.getAttempt',
    'workflows.listOperations',
    'workflows.listEvents',
    'workflows.getPayload',
  ]) {
    assert.ok(ids.includes(id), id);
  }
});

test('a wait is advanced by its own identity, so a stale submission cannot satisfy a newer wait', () => {
  assert.deepEqual(decode(advanceWorkflowInputSchema, { waitId: 9 }), { waitId: 9 });
  assert.throws(() => decode(advanceWorkflowInputSchema, { answers: { note: 'hi' } }));
  // A wait is a durable row, so an opaque string is not its identity.
  assert.throws(() => decode(advanceWorkflowInputSchema, { waitId: 'wait-9' }));
});

test('an operation records raw identifiers and reports stopping separately from settlement', () => {
  const decoded = decode(
    workflowOperationSchema,
    operation({
      state: 'interrupted',
      settledAt: at,
      stop: {
        state: 'pending',
        detail: 'tmux server unreachable',
        requestedAt: at,
        settledAt: null,
      },
    }),
  );
  assert.equal(decoded.target.ptyProcessId, 29);
  // Settled as interrupted, but the stop is not confirmed — the two facts stay separate.
  assert.equal(decoded.stop.state, 'pending');
});

test('an uncertain operation carries its evidence and is not overridable by a status', () => {
  const decoded = decode(
    workflowOperationSchema,
    operation({
      state: 'uncertain',
      stage: 'submitting',
      uncertaintyDetail: 'crashed between the PTY write and the receipt',
    }),
  );
  assert.equal(decoded.state, 'uncertain');
  assert.match(decoded.uncertaintyDetail ?? '', /between the PTY write/);
});

// ---------------------------------------------------------------------------
// The boundary must not be able to express states the engine cannot be in
// ---------------------------------------------------------------------------

test('a position names exactly the identities its kind needs', () => {
  assert.deepEqual(decode(workflowRunPositionSchema, { kind: 'graph_entry', frameId: 1 }), {
    kind: 'graph_entry',
    frameId: 1,
  });
  assert.equal(
    decode(workflowRunPositionSchema, { kind: 'routing', frameId: 1, executionId: 4, edgeId: 'e' })
      .kind,
    'routing',
  );
  assert.equal(decode(workflowRunPositionSchema, { kind: 'terminal' }).kind, 'terminal');
  assert.equal(
    decode(workflowRunPositionSchema, {
      kind: 'child_output_mapping',
      frameId: 1,
      executionId: 4,
      childFrameId: 2,
    }).kind,
    'child_output_mapping',
  );
});

test('an impossible position cannot be represented at all', () => {
  // A struct of independently nullable identities would accept every one of these. The snapshot has
  // to identify the next executable segment unambiguously, so the union is what carries that.
  assert.throws(() =>
    decode(workflowRunPositionSchema, {
      kind: 'routing',
      frameId: null,
      executionId: null,
      edgeId: null,
    }),
  );
  assert.throws(() => decode(workflowRunPositionSchema, { kind: 'routing', frameId: 1 }));
  assert.throws(() =>
    decode(workflowRunPositionSchema, { kind: 'awaiting_wait', frameId: 1, executionId: 4 }),
  );
  assert.throws(() => decode(workflowRunPositionSchema, { kind: 'graph_output', frameId: 1 }));
});

test('a root outcome payload travels through the same sized reference as every other value', () => {
  const withRef = decode(workflowRunSummarySchema, {
    ...summary,
    status: 'done',
    outcome: {
      outcomeId: 'delivered',
      kind: 'success',
      reason: null,
      producedRef: {
        payloadRef: 'sha256:out',
        byteSize: 128,
        mediaType: 'application/json',
        path: '/var/lib/isagi/payloads/out',
      },
    },
  });
  // No filesystem path reaches a client, and a size is always available before fetching.
  const produced = withRef.outcome?.producedRef;
  assert.deepEqual(Object.keys(produced ?? {}).sort(), ['byteSize', 'mediaType', 'payloadRef']);

  // An outcome that produced nothing, and one that produced JSON null, stay distinguishable.
  const absent = {
    ...summary,
    outcome: { outcomeId: 'd', kind: 'success', reason: null, producedRef: null },
  };
  assert.equal(decode(workflowRunSummarySchema, absent).outcome?.producedRef, null);
  const recordedNull = { ...absent, outcome: { ...absent.outcome, producedRef: { inline: null } } };
  assert.deepEqual(decode(workflowRunSummarySchema, recordedNull).outcome?.producedRef, {
    inline: null,
  });
});

// ---------------------------------------------------------------------------
// The durable operation model later phases have to produce
// ---------------------------------------------------------------------------

test('an operation starts as intended, which is what makes redispatch safe', () => {
  // `intended` means a position was recorded and no effect provably crossed the boundary, so
  // re-entry dispatches under the same identity. It is not the same as a dispatched operation, and
  // it still carries the request it intends to send.
  const decoded = decode(
    workflowOperationSchema,
    operation({ state: 'intended', stage: null, dispatchedAt: null }),
  );
  assert.equal(decoded.state, 'intended');
  assert.equal(decoded.requestHash, 'sha256:bbb');
});

test('an operation always records where it came from and what it intends to send', () => {
  // Intent is created inside a callback attempt and records its execution, originating attempt,
  // normalized request and fingerprint before the effect crosses the boundary. An operation missing
  // any of these could not take part in prefix matching or show what was actually sent.
  for (const missing of [
    { executionId: null },
    { attemptId: null },
    { requestRef: null },
    { requestHash: null },
  ]) {
    assert.throws(
      () => decode(workflowOperationSchema, operation(missing)),
      `an operation without ${Object.keys(missing)[0]} must not encode`,
    );
  }

  // Lifecycle facts that genuinely arrive later stay nullable.
  assert.doesNotThrow(() =>
    decode(
      workflowOperationSchema,
      operation({
        stage: null,
        receiptRef: null,
        resultRef: null,
        dispatchedAt: null,
        settledAt: null,
        uncertaintyDetail: null,
        lateEvidenceRef: null,
      }),
    ),
  );
});

test('every launch stage a recovery decision depends on is representable', () => {
  // `launch_failed` separates a preparation failure that never reached a backend from a post-spawn
  // failure where a process may be live. Every stage here has a writer: the compound spawn's
  // pane/session creation is one owner call, so `session_created` is the first stage that spawn can
  // report and there is deliberately no `pane_created` to represent a point nothing can observe.
  for (const stage of [
    'allocated',
    'starting',
    'started',
    'launch_failed',
    'session_created',
    'seed_submitting',
    'seed_submitted',
    'submitting',
    'submitted',
  ]) {
    assert.equal(decode(workflowOperationSchema, operation({ stage })).stage, stage);
  }
});

test('only capabilities that cross an external boundary are journaled operations', () => {
  for (const capability of [
    'spawn_agent_session',
    'send_agent_prompt',
    'close_pane',
    'run_headless_agent',
  ]) {
    assert.equal(decode(workflowOperationSchema, operation({ capability })).capability, capability);
  }
  // Reading conversation history is a scoped read, not a durable effect needing a receipt.
  assert.throws(() =>
    decode(workflowOperationSchema, operation({ capability: 'get_conversation_history' })),
  );
});

// ---------------------------------------------------------------------------
// Pagination is bounded by the schema, not by prose
// ---------------------------------------------------------------------------

test('a page limit is bounded at the boundary', () => {
  assert.equal(decode(listWorkflowRunsQuerySchema, { limit: 500 }).limit, 500);
  assert.throws(() => decode(listWorkflowRunsQuerySchema, { limit: 501 }));
  assert.throws(() => decode(listWorkflowRunsQuerySchema, { limit: 0 }));
});

test('every list route can actually request its second page', () => {
  // A route that returns nextCursor without accepting one strands the caller on page one. Checked
  // by decoding rather than by inspecting schema internals, which do not survive Schema.extend.
  const endpoints: readonly ApiEndpoint<any, any, any, any, any>[] =
    Object.values(workflowsEndpoints);
  const listRoutes = endpoints.filter((endpoint) => {
    const output = endpoint.output as { fields?: Record<string, unknown> };
    return output.fields !== undefined && 'nextCursor' in output.fields;
  });
  assert.ok(listRoutes.length >= 8, 'the retained list routes are present');

  for (const endpoint of listRoutes) {
    assert.ok(endpoint.query, `${endpoint.id} returns a cursor but accepts no query`);
    assert.doesNotThrow(
      () => decode(endpoint.query as Schema.Schema<unknown, never>, { cursor: 'c', limit: 10 }),
      `${endpoint.id} does not accept a cursor`,
    );
    assert.throws(
      () => decode(endpoint.query as Schema.Schema<unknown, never>, { limit: 501 }),
      `${endpoint.id} does not bound its page size`,
    );
  }
});

// ---------------------------------------------------------------------------
// The wire must be able to carry the durable model phases 2-5 actually produce
// ---------------------------------------------------------------------------

test('a freshly dispatched first visit crosses the wire', () => {
  // Graph entry publishes the execution and dispatches it before any callback attempt exists, and
  // a node's first visit is index 0. Requiring a positive visit index, a positive attempt count or
  // a non-null latest attempt made exactly this row unrepresentable.
  const fresh = decode(workflowExecutionSchema, {
    ...execution,
    visitIndex: 0,
    status: 'running',
    attemptCount: 0,
    latestAttempt: null,
    priorFailures: [],
    routing: null,
    wait: null,
    endCertainty: 'observed',
    endedAt: null,
    callbackStartedAt: null,
    callbackEndedAt: null,
    waitArmedAt: null,
    waitDeliveredAt: null,
    operationSummary: { count: 0, unresolved: 0, capabilities: [] },
    stateInRef: null,
  });
  assert.equal(fresh.visitIndex, 0);
  assert.equal(fresh.attemptCount, 0);
  assert.equal(fresh.latestAttempt, null);
});

test('a subgraph visit with no attempt at all is representable', () => {
  // Entering a subgraph creates the child frame and dispatches it without running author code, so
  // the parent's subgraph execution legitimately has no attempt.
  const mapping = decode(workflowExecutionSchema, {
    ...execution,
    nodeKind: 'subgraph',
    visitIndex: 0,
    status: 'mapping',
    attemptCount: 0,
    latestAttempt: null,
    priorFailures: [],
    wait: null,
    childFrameId: 2,
  });
  assert.equal(mapping.status, 'mapping');
  assert.equal(mapping.attemptCount, 0);
});

test('a frame-owned segment carries its own failure, and absence still means never attempted', () => {
  // A failed initialization: the frame has an entry segment and nothing else to show for itself.
  const failed = decode(workflowFrameSchema, {
    ...frame,
    status: 'initializing',
    entry: {
      ...frame.entry,
      endedAt: at,
      latestAttempt: {
        ...frame.entry.latestAttempt,
        status: 'failed',
        failure: { code: 'graph_init_failed', message: 'init threw', detail: null },
        recoveryMode: 'rerun_producer',
        producerArtifactHash: null,
      },
    },
  });
  assert.equal(failed.entry?.latestAttempt.failure?.code, 'graph_init_failed');
  assert.equal(failed.output, null);
  assert.equal(failed.outputEvaluation, null, 'never attempted stays distinguishable from failed');

  // An output evaluation that failed before any outcome exists: a segment, and still no output.
  const evaluating = decode(workflowFrameSchema, {
    ...frame,
    outputEvaluation: {
      segmentKind: 'graph_output',
      segmentRef: 'delivered',
      attemptCount: 2,
      startedAt: at,
      endedAt: null,
      endCertainty: 'unknown',
      firstArtifactHash: 'sha256:pin3',
      latestArtifactHash: 'sha256:pin4',
      latestAttempt: {
        ...frame.entry.latestAttempt,
        attemptIndex: 2,
        artifactHash: 'sha256:pin4',
        invocationKind: 'retry',
        status: 'running',
        failure: null,
      },
      priorFailures: [
        {
          attemptId: 3,
          attemptIndex: 1,
          segmentKind: 'graph_output',
          artifactHash: 'sha256:pin3',
          failure: { code: 'output_evaluation_failed', message: 'threw', detail: null },
          repairedByAttemptIndex: null,
          repairedByArtifactHash: null,
        },
      ],
    },
  });
  assert.equal(evaluating.output, null, 'a segment exists before the value it would publish does');
  assert.equal(
    evaluating.outputEvaluation?.priorFailures[0]?.failure.code,
    'output_evaluation_failed',
  );
  assert.equal(evaluating.outputEvaluation?.firstArtifactHash, 'sha256:pin3');
  assert.equal(evaluating.outputEvaluation?.latestArtifactHash, 'sha256:pin4');
});

test('the designed frame, execution, attempt and certainty vocabularies decode', () => {
  for (const status of ['initializing', 'active', 'completed']) {
    assert.equal(decode(workflowFrameSchema, { ...frame, status }).status, status);
  }
  for (const status of ['running', 'awaiting', 'routing', 'mapping', 'completed', 'failed']) {
    assert.equal(decode(workflowExecutionSchema, { ...execution, status }).status, status);
  }
  for (const status of [
    'running',
    'succeeded',
    'failed',
    'interrupted',
    'cancelled',
    'superseded',
  ]) {
    assert.equal(
      decode(workflowExecutionSchema, {
        ...execution,
        latestAttempt: { ...execution.latestAttempt, status },
      }).latestAttempt?.status,
      status,
    );
  }
  for (const certainty of ['observed', 'unknown']) {
    assert.equal(
      decode(workflowExecutionSchema, { ...execution, endCertainty: certainty }).endCertainty,
      certainty,
    );
  }
});

test('the mapping segment is named output_mapping, and the position kind stays distinct', () => {
  // Two different enums for the same boundary: attempts record `output_mapping`, positions record
  // `child_output_mapping`. Merging them would break one of the two.
  assert.equal(
    decode(workflowAttemptSchema, { ...attempt, segmentKind: 'output_mapping' }).segmentKind,
    'output_mapping',
  );
  assert.throws(() =>
    decode(workflowAttemptSchema, { ...attempt, segmentKind: 'child_output_mapping' }),
  );
  assert.equal(
    decode(workflowRunPositionSchema, {
      kind: 'child_output_mapping',
      frameId: 1,
      executionId: 4,
      childFrameId: 2,
    }).kind,
    'child_output_mapping',
  );
});

test('every designed transition kind decodes, including the amendment replacements', () => {
  for (const kind of [
    'run_started',
    'graph_entered',
    'node_dispatched',
    'wait_armed',
    'wait_delivered',
    'producer_output_captured',
    'state_reduced',
    'routed',
    'child_output_published',
    'output_mapped',
    'graph_completed',
    'run_completed',
    'segment_failed',
    'run_blocked',
    'operation_recorded',
    'operation_settled',
    'stop_recorded',
    'log',
    'ui_feedback',
    'control_applied',
    'pause_opened',
    'pause_closed',
    'retry_pin_adopted',
  ]) {
    assert.equal(decode(workflowTransitionSchema, { ...transition, kind }).kind, kind);
  }
  // Replaced by `retry_pin_adopted`, with no dual spelling left behind.
  assert.throws(() => decode(workflowTransitionSchema, { ...transition, kind: 'version_adopted' }));
});

test('a superseded wait stays representable, so late evidence is retained not lost', () => {
  for (const status of ['armed', 'delivered', 'consumed', 'superseded']) {
    assert.equal(
      decode(workflowExecutionSchema, { ...execution, wait: { ...execution.wait, status } }).wait
        ?.status,
      status,
    );
  }
});

test('the per-frame listing returns an ordinary page, not the run-wide recovery envelope', () => {
  // It has no sinceRevision to answer, so it must not imply run-wide coverage.
  assert.doesNotThrow(() =>
    decode(listFrameExecutionsOutputSchema, { items: [execution], nextCursor: null }),
  );
  assert.equal(workflowsEndpoints.listFrameExecutions.output, listFrameExecutionsOutputSchema);
  assert.notEqual(workflowsEndpoints.listFrameExecutions.output, listRunExecutionsOutputSchema);
});

test('every diagnostic detail the runtime writes decodes, and an unrecognised one does not', () => {
  const decodeDetail = Schema.decodeUnknownEither(workflowDiagnosticDetailSchema);

  // The three shapes the runtime actually writes today. These literals are the wire-side half of
  // the compile-time narrowing on the repository's `DiagnosticInput`: if a writer ever changes one,
  // one of the two halves fails rather than a client silently rendering nothing.
  assert.ok(
    decodeDetail({ source: 'author_log', level: 'info', message: 'drafting' })._tag === 'Right',
  );
  assert.ok(
    decodeDetail({
      source: 'runtime_diagnostic',
      code: 'payload_unavailable',
      level: 'error',
      message: 'The wait condition could not be read.',
      payloadRef: 'sha256:abc',
      cause: 'corrupt',
    })._tag === 'Right',
  );
  assert.ok(
    decodeDetail({ source: 'ui_feedback', kind: 'info', phase: 'writing', message: 'drafting' })
      ._tag === 'Right',
  );

  // A detail that only looks like a diagnostic is refused rather than half-read. The discriminant
  // is explicit precisely so this case is a decode failure a client shows as unavailable detail.
  assert.ok(decodeDetail({ level: 'info', message: 'legacy shape' })._tag === 'Left');
  assert.ok(decodeDetail({ source: 'author_log', message: 'no level' })._tag === 'Left');
  assert.ok(
    decodeDetail({ source: 'runtime_diagnostic', code: 'invented', level: 'error', message: 'x' })
      ._tag === 'Left',
  );
});

const frame = {
  frameId: 1,
  parentExecutionId: null,
  parentFrameId: null,
  graphKey: 'Story',
  entryArtifactHash: 'sha256:pin3',
  depth: 0,
  status: 'active',
  displayName: null,
  labelDiagnostic: null,
  entry: {
    segmentKind: 'graph_entry',
    segmentRef: null,
    attemptCount: 1,
    startedAt: at,
    endedAt: at,
    endCertainty: 'observed',
    firstArtifactHash: 'sha256:pin3',
    latestArtifactHash: 'sha256:pin3',
    latestAttempt: {
      attemptId: 3,
      attemptIndex: 1,
      artifactHash: 'sha256:pin3',
      status: 'succeeded',
      invocationKind: 'initial',
      failure: null,
      recoveryMode: 'reuse_producer_output',
      producerArtifactHash: 'sha256:pin3',
    },
    priorFailures: [],
  },
  outputEvaluation: null,
  output: null,
  enteredAt: at,
  completedAt: null,
  parametersRef: null,
  stateRef: null,
  executionCount: 1,
};

const attempt = {
  attemptId: 9,
  frameId: 1,
  executionId: 4,
  segmentKind: 'node_callback',
  segmentRef: 'askWriter',
  attemptIndex: 1,
  artifactHash: 'sha256:pin4',
  status: 'running',
  invocationKind: 'initial',
  startedAt: at,
  endedAt: null,
  endCertainty: 'observed',
  failure: null,
  inputRef: null,
  producerOutputRef: null,
  producerArtifactHash: null,
  recoveryMode: 'rerun_producer',
};

const transition = {
  revision: 1,
  recordedAt: at,
  kind: 'run_started',
  frameId: null,
  executionId: null,
  attemptId: null,
  operationKey: null,
  waitId: null,
  artifactHash: null,
  detailRef: null,
  stateRef: null,
};
