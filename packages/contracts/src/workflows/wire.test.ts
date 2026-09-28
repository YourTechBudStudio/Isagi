import assert from 'node:assert/strict';
import test from 'node:test';

import { Schema } from 'effect';

import { runtimeEventSchema } from '../runtime-events/types.js';
import {
  listWorkflowCheckpointsQuerySchema,
  workflowCheckpointFileQuerySchema,
} from './checkpoints.js';
import { workflowErrorSchema, workflowExecutionDetailSchema } from './executions.js';
import {
  listWorkflowRunsOutputSchema,
  listWorkflowRunsQuerySchema,
  workflowRunSummarySchema,
} from './runs.js';

const summary = {
  runId: 3,
  projectId: 1,
  workflowKey: 'reviewed-document',
  title: 'Reviewed document',
  artifactHash: 'a'.repeat(64),
  status: 'waiting',
  origin: {
    worktreeId: 1,
    worktreePath: '/repo',
    surfaceId: 2,
    paneId: null,
    agentSessionId: null,
  },
  placement: {
    source: 'default',
    request: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
    baseCommit: null,
  },
  worktreeId: 1,
  worktreePath: '/repo',
  setupDone: true,
  surfaceId: 2,
  current: {
    executionId: 9,
    invocationId: 4,
    graphKey: 'Story',
    nodeId: 'askWriter',
    nodeKind: 'operation',
    label: null,
    wait: { kind: 'user_input', questions: [{ kind: 'text', key: 'why', label: 'Why?' }] },
  },
  uiFeedback: null,
  error: null,
  outcome: null,
  controls: { pause: true, resume: false, retry: false, cancel: true, dismiss: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
};

test('a run summary decodes from the fields the run tables hold', () => {
  const decoded = Schema.decodeUnknownSync(workflowRunSummarySchema)(summary);
  assert.equal(decoded.current?.wait?.kind, 'user_input');
});

test('a create placement keeps the commit its ref resolved to at launch', () => {
  const placement = {
    source: 'selector',
    request: {
      worktree: { kind: 'create', branch: 'feature', fromRef: 'main' },
      surface: { kind: 'create', title: 'Feature' },
    },
    baseCommit: 'c'.repeat(40),
  };
  const decoded = Schema.decodeUnknownSync(workflowRunSummarySchema)({ ...summary, placement });
  assert.equal(decoded.placement.baseCommit, 'c'.repeat(40));
  const decode = (value: unknown) =>
    Schema.decodeUnknownSync(workflowRunSummarySchema)({ ...summary, placement: value });
  const { baseCommit, ...withoutCommit } = placement;
  void baseCommit;
  assert.throws(() => decode(withoutCommit));
  // A create without its commit leaves preparation nothing to build from.
  assert.throws(() => decode({ ...placement, baseCommit: null }));
  // A reused worktree has no base commit to record.
  assert.throws(() => decode({ ...summary.placement, baseCommit: 'c'.repeat(40) }));
});

test('lists page by the last id, and the page envelope carries it back', () => {
  const page = Schema.decodeUnknownSync(listWorkflowRunsOutputSchema)({
    items: [summary],
    nextCursor: 3,
  });
  assert.equal(page.nextCursor, 3);
  // The route decoder has already turned numeric query strings into numbers.
  const query = Schema.decodeUnknownSync(listWorkflowRunsQuerySchema)({ cursor: 3, limit: 50 });
  assert.equal(query.cursor, 3);
  assert.throws(() => Schema.decodeUnknownSync(listWorkflowRunsQuerySchema)({ limit: 501 }));
});

test('free-text query values survive the route decoder turning digits into numbers', () => {
  assert.equal(
    Schema.decodeUnknownSync(workflowCheckpointFileQuerySchema)({ path: 2024 }).path,
    '2024',
  );
  assert.equal(
    Schema.decodeUnknownSync(listWorkflowCheckpointsQuerySchema)({ scope: 'plan' }).scope,
    'plan',
  );
  assert.throws(() => Schema.decodeUnknownSync(workflowCheckpointFileQuerySchema)({ path: '' }));
});

test('an execution detail carries its operations with the recorded reply', () => {
  const detail = Schema.decodeUnknownSync(workflowExecutionDetailSchema)({
    executionId: 9,
    runId: 3,
    invocationId: 4,
    nodeId: 'askWriter',
    nodeKind: 'operation',
    visitIndex: 0,
    label: null,
    artifactHash: 'a'.repeat(64),
    status: 'completed',
    retryOf: 8,
    wait: null,
    routedTo: 'review',
    childInvocationId: null,
    checkpointId: null,
    error: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    result: { type: 'suspend' },
    event: { kind: 'agent_turn', outcome: 'ended' },
    decision: { to: 'review' },
    stateAfter: { note: 'x' },
    operations: [
      {
        operationId: 12,
        runId: 3,
        executionId: 9,
        seq: 0,
        kind: 'send_prompt',
        agentSessionId: 5,
        paneId: 6,
        harness: 'claude',
        model: null,
        effort: null,
        request: { prompt: 'Write it.' },
        status: 'completed',
        responseText: 'Done.',
        result: null,
        harnessSessionId: 'abc',
        usage: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:01:00.000Z',
      },
    ],
  });
  assert.equal(detail.operations[0]?.responseText, 'Done.');
});

test('an execution error can say which graph and node or outcome threw', () => {
  const located = Schema.decodeUnknownSync(workflowErrorSchema)({
    stage: 'edge',
    message: 'boom',
    graphKey: 'Story',
    nodeId: 'review',
  });
  assert.deepEqual(located, {
    stage: 'edge',
    message: 'boom',
    graphKey: 'Story',
    nodeId: 'review',
  });
  const bare = Schema.decodeUnknownSync(workflowErrorSchema)({
    stage: 'environment',
    message: 'x',
  });
  assert.equal('graphKey' in bare, false);
});

test('each appended event is pushed as one workflow_run_event', () => {
  const event = Schema.decodeUnknownSync(runtimeEventSchema)({
    id: 'evt-1',
    type: 'workflow_run_event',
    occurredAt: '2026-01-01T00:00:00.000Z',
    payload: {
      eventId: 40,
      runId: 3,
      executionId: 9,
      at: '2026-01-01T00:00:00.000Z',
      category: 'log',
      kind: 'log',
      message: 'hello',
      data: { level: 'info', message: 'hello' },
    },
  });
  assert.equal(event.type, 'workflow_run_event');
  for (const removed of ['workflow_run_transition', 'workflow_run_detached']) {
    assert.throws(() =>
      Schema.decodeUnknownSync(runtimeEventSchema)({
        id: 'evt-2',
        type: removed,
        occurredAt: '2026-01-01T00:00:00.000Z',
        payload: {},
      }),
    );
  }
});
