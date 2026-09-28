import assert from 'node:assert/strict';
import test from 'node:test';

import {
  workflowExecutionDetailFixture,
  workflowSummaryFixture,
} from '../../../lib/workspace/workflow/test-support.js';
import {
  buildDockView,
  checkpointFilesTabKey,
  shortHash,
  type DockField,
  type DockRow,
} from './dock.js';
import {
  clockAt,
  descriptorFixture,
  graphFixture,
  instant,
  nested,
  rootInvocation,
  runViewFixture,
  visit,
} from './test-support.js';
import { addressKey, buildTopology } from './topology.js';

const root = graphFixture({
  key: 'root',
  entry: 'plan',
  nodes: [
    { id: 'plan', kind: 'operation' },
    { id: 'ask', kind: 'operation' },
    { id: 'phase', kind: 'subgraph', graphKey: 'phase' },
  ],
  edges: [
    { id: 'after-plan', from: 'plan', to: ['ask'] },
    { id: 'after-ask', from: 'ask', to: ['phase'] },
    { id: 'after-phase', from: 'phase', to: ['done'] },
  ],
  outcomes: [{ id: 'done', kind: 'success' }],
});
const phase = graphFixture({
  key: 'phase',
  entry: 'work',
  nodes: [{ id: 'work', kind: 'operation' }],
  edges: [{ id: 'after-work', from: 'work', to: ['ok'] }],
  outcomes: [{ id: 'ok', kind: 'success' }],
});
const topology = buildTopology(descriptorFixture([root, phase], 'root'));
const now = clockAt(100);

const fields = (rows: readonly DockRow[]): readonly DockField[] =>
  rows.filter((row): row is DockField => !('gap' in row));
const field = (rows: readonly DockRow[], label: string) =>
  fields(rows).find((row) => row.label === label);

test('a node the current build no longer declares says so, and never borrows a declaration', () => {
  const view = runViewFixture({ executions: [visit({ executionId: 1, nodeId: 'gone' })] });
  const dock = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    view,
    topology,
    detail: null,
    now,
  })!;
  assert.equal(field(dock.declared, 'declared')?.tone, 'warn');
});

test('an execution shows its recorded values once its detail is read, and only its own', () => {
  const view = runViewFixture({
    executions: [visit({ executionId: 1, nodeId: 'plan', routedTo: 'ask' })],
  });
  const detail = workflowExecutionDetailFixture({
    executionId: 1,
    nodeId: 'plan',
    result: { type: 'complete', update: { draft: 'x' } },
    decision: { to: 'ask', update: {} },
    stateAfter: { draft: 'x' },
  });
  const withDetail = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    view,
    topology,
    detail,
    now,
  })!;
  assert.deepEqual(
    withDetail.data.map((tab) => tab.name),
    ['result', 'event', 'decision', 'state_after'],
  );
  const result = withDetail.data[0]!;
  assert.deepEqual(result.kind === 'value' ? result.value : null, detail.result);
  assert.equal(field(withDetail.recorded, 'routed to')?.dataTab, 'decision');

  // Detail for a different execution — a slow read for the previous selection — is ignored.
  const stale = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    view,
    topology,
    detail: { ...detail, executionId: 9 },
    now,
  })!;
  const staleResult = stale.data[0]!;
  assert.equal(staleResult.kind === 'value' ? staleResult.value : 'x', undefined);
});

test('a retry names the execution it retries and links to it; an older build says so', () => {
  const view = runViewFixture({
    summary: workflowSummaryFixture({ artifactHash: 'sha256:new0000' }),
    executions: [
      visit({ executionId: 1, nodeId: 'plan', status: 'failed', artifactHash: 'sha256:old0000' }),
      visit({ executionId: 2, nodeId: 'plan', retryOf: 1, artifactHash: 'sha256:new0000' }),
    ],
  });
  const retry = buildDockView({
    selection: { kind: 'execution', executionId: 2 },
    view,
    topology,
    detail: null,
    now,
  })!;
  assert.deepEqual(field(retry.recorded, 'retry of')?.selection, {
    kind: 'execution',
    executionId: 1,
  });
  assert.equal(field(retry.recorded, 'build')?.value, 'new0000');
  const original = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    view,
    topology,
    detail: null,
    now,
  })!;
  assert.equal(field(original.recorded, 'build')?.tone, 'warn');
});

test('a failure names its stage, whose code threw, and that Retry is the repair', () => {
  const view = runViewFixture({
    executions: [
      visit({
        executionId: 1,
        nodeId: 'plan',
        status: 'failed',
        error: { stage: 'edge', message: 'bad route', graphKey: 'root', nodeId: 'plan' },
      }),
    ],
  });
  const dock = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    view,
    topology,
    detail: null,
    now,
  })!;
  assert.equal(field(dock.recorded, 'stage')?.value, 'edge');
  assert.equal(field(dock.recorded, 'in')?.value, 'root/plan');
  assert.equal(field(dock.recorded, 'message')?.value, 'bad route');
  assert.ok(field(dock.recorded, 'repair'));
});

test('a user wait keeps the operations beside it', () => {
  const view = runViewFixture({
    executions: [
      visit({
        executionId: 1,
        nodeId: 'ask',
        status: 'waiting',
        endedAt: null,
        wait: { kind: 'user_continue', label: 'Fix it, then Continue' },
      }),
    ],
  });
  const dock = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    view,
    topology,
    detail: null,
    now,
  })!;
  assert.equal(dock.operations.kind, 'wait_and_operations');
  if (dock.operations.kind === 'wait_and_operations') {
    assert.equal(field(dock.operations.waitFields, 'label')?.value, 'Fix it, then Continue');
    assert.equal(field(dock.operations.waitFields, 'answer in')?.tone, 'dim');
  }
});

test('a subgraph lists its child invocation’s direct executions and its outcome', () => {
  const view = runViewFixture({
    invocations: [
      rootInvocation(),
      nested({
        invocationId: 2,
        parentExecutionId: 1,
        graphKey: 'phase',
        depth: 1,
        invocation: {
          status: 'completed',
          outcome: { outcomeId: 'ok', kind: 'success', reason: null, output: { n: 1 } },
        },
      }),
    ],
    executions: [
      visit({ executionId: 1, nodeId: 'phase', nodeKind: 'subgraph', childInvocationId: 2 }),
      visit({ executionId: 2, invocationId: 2, nodeId: 'work', startedAt: instant(1) }),
    ],
  });
  const dock = buildDockView({
    selection: { kind: 'element', key: addressKey({ path: [], kind: 'node', id: 'phase' }) },
    view,
    topology,
    detail: null,
    now,
  })!;
  assert.equal(dock.operations.kind, 'none');
  assert.deepEqual(
    dock.nested?.children.map((child) => child.executionId),
    [2],
  );
  assert.equal(field(dock.recorded, 'outcome')?.value, 'ok · success');
  assert.ok(dock.data.some((tab) => tab.name === 'output'));
});

test('a graph invocation shows its parameters, state and outcome', () => {
  const view = runViewFixture({
    invocations: [rootInvocation({ parameters: { a: 1 }, state: { draft: '' } })],
  });
  const dock = buildDockView({
    selection: { kind: 'invocation', invocationId: 1 },
    view,
    topology,
    detail: null,
    now,
  })!;
  assert.deepEqual(
    dock.data.map((tab) => tab.name),
    ['parameters', 'state'],
  );
  assert.equal(dock.kindChip, 'graph');
});

test('a checkpoint execution gets the checkpoint column and a files tab', () => {
  const view = runViewFixture({
    executions: [
      visit({ executionId: 1, nodeId: 'save', nodeKind: 'checkpoint', checkpointId: 7 }),
    ],
  });
  const dock = buildDockView({
    selection: { kind: 'execution', executionId: 1 },
    view,
    topology,
    detail: null,
    now,
  })!;
  assert.deepEqual(dock.checkpoint, { checkpointId: 7, state: 'saved' });
  assert.ok(dock.data.some((tab) => tab.key === checkpointFilesTabKey));
});

test('a shortened hash drops the algorithm prefix rather than the digest', () => {
  assert.equal(shortHash('sha256:abcdef0123'), 'abcdef0');
  assert.equal(shortHash('abcdef0123'), 'abcdef0');
});
