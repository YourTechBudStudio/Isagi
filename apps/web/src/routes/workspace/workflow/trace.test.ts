import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowEventFixture } from '../../../lib/workspace/workflow/test-support.js';
import { clockAt, instant, nested, rootInvocation, runViewFixture, visit } from './test-support.js';
import { buildTraceModel, type TraceExecutionRow } from './trace.js';

const noneCollapsed = new Set<number>();

function executionRows(rows: readonly { readonly kind: string }[]) {
  return rows.filter((row): row is TraceExecutionRow => row.kind === 'execution');
}

test('run time and wait time are separate bars, taken from the node’s waiting and delivery events', () => {
  const view = runViewFixture({
    executions: [
      visit({ executionId: 1, nodeId: 'ask', startedAt: instant(0), endedAt: instant(60) }),
    ],
    events: [
      workflowEventFixture({ eventId: 1, executionId: 1, kind: 'node_waiting', at: instant(2) }),
      workflowEventFixture({ eventId: 2, executionId: 1, kind: 'wait_delivered', at: instant(50) }),
    ],
  });
  const [row] = executionRows(buildTraceModel({ view, collapsed: noneCollapsed }).rows);
  assert.deepEqual(
    row!.bars.map((bar) => [bar.kind, bar.start, bar.end]),
    [
      ['run', clockAt(0), clockAt(2)],
      ['wait', clockAt(2), clockAt(50)],
    ],
  );
});

test('a wait still open has an open bar, and a node that never waited has one run bar', () => {
  const view = runViewFixture({
    executions: [
      visit({ executionId: 1, nodeId: 'plan', startedAt: instant(0), endedAt: instant(3) }),
      visit({
        executionId: 2,
        nodeId: 'ask',
        status: 'waiting',
        startedAt: instant(3),
        endedAt: null,
      }),
    ],
    events: [
      workflowEventFixture({ eventId: 1, executionId: 2, kind: 'node_waiting', at: instant(4) }),
    ],
  });
  const rows = executionRows(buildTraceModel({ view, collapsed: noneCollapsed }).rows);
  assert.deepEqual(
    rows[0]!.bars.map((bar) => bar.kind),
    ['run'],
  );
  assert.equal(rows[1]!.bars.at(-1)!.kind, 'wait');
  assert.equal(rows[1]!.bars.at(-1)!.open, true);
});

test('a retry is its own row, marked with the execution it retries', () => {
  const view = runViewFixture({
    executions: [
      visit({ executionId: 1, nodeId: 'plan', status: 'failed', startedAt: instant(0) }),
      visit({ executionId: 2, nodeId: 'plan', retryOf: 1, startedAt: instant(5) }),
    ],
  });
  const rows = executionRows(buildTraceModel({ view, collapsed: noneCollapsed }).rows);
  assert.deepEqual(
    rows.map((row) => [row.executionId, row.retryOf]),
    [
      [1, null],
      [2, 1],
    ],
  );
});

test('pause bands and code reloads come from the run’s events', () => {
  const view = runViewFixture({
    events: [
      workflowEventFixture({ eventId: 1, kind: 'run_paused', at: instant(10) }),
      workflowEventFixture({ eventId: 2, kind: 'run_resumed', at: instant(20) }),
      workflowEventFixture({
        eventId: 3,
        kind: 'code_reloaded',
        at: instant(20),
        data: { from: 'sha256:a', to: 'sha256:b' },
      }),
      workflowEventFixture({ eventId: 4, kind: 'run_paused', at: instant(30) }),
    ],
  });
  const model = buildTraceModel({ view, collapsed: noneCollapsed });
  assert.deepEqual(model.pauses, [
    { start: clockAt(10), end: clockAt(20) },
    { start: clockAt(30), end: null },
  ]);
  assert.deepEqual(model.reloads, [{ at: clockAt(20), to: 'sha256:b' }]);
});

test('the root invocation has its own row with the outcome it finished with', () => {
  const view = runViewFixture({
    invocations: [
      rootInvocation({
        status: 'completed',
        endedAt: instant(9),
        outcome: { outcomeId: 'shipped', kind: 'success', reason: null, output: null },
      }),
    ],
  });
  const [row] = buildTraceModel({ view, collapsed: noneCollapsed }).rows;
  assert.equal(row!.kind, 'invocation');
  assert.deepEqual(row!.kind === 'invocation' ? row!.outcome : null, {
    at: clockAt(9),
    label: 'shipped',
    kind: 'success',
  });
});

test('a routing marker and a child outcome marker hang off the rows that produced them', () => {
  const view = runViewFixture({
    invocations: [
      rootInvocation(),
      nested({
        invocationId: 2,
        parentExecutionId: 1,
        graphKey: 'review',
        depth: 1,
        invocation: {
          status: 'completed',
          endedAt: instant(8),
          outcome: { outcomeId: 'ok', kind: 'success', reason: null, output: 1 },
        },
      }),
    ],
    executions: [
      visit({
        executionId: 1,
        nodeId: 'review',
        nodeKind: 'subgraph',
        childInvocationId: 2,
        routedTo: 'ship',
        startedAt: instant(0),
        endedAt: instant(9),
      }),
    ],
  });
  const [row] = executionRows(buildTraceModel({ view, collapsed: noneCollapsed }).rows);
  assert.deepEqual(row!.routing, { at: clockAt(9), chosen: 'ship' });
  assert.deepEqual(row!.outcome?.selection, { kind: 'invocation', invocationId: 2 });
});

test('collapsing one invocation of a reused graph does not fold away the other', () => {
  const view = runViewFixture({
    invocations: [
      rootInvocation(),
      nested({ invocationId: 2, parentExecutionId: 1, graphKey: 'review', depth: 1 }),
      nested({ invocationId: 3, parentExecutionId: 2, graphKey: 'review', depth: 1 }),
    ],
    executions: [
      visit({
        executionId: 1,
        nodeId: 'a',
        nodeKind: 'subgraph',
        childInvocationId: 2,
        startedAt: instant(0),
      }),
      visit({
        executionId: 2,
        nodeId: 'b',
        nodeKind: 'subgraph',
        childInvocationId: 3,
        startedAt: instant(1),
      }),
      visit({ executionId: 3, invocationId: 2, nodeId: 'draft', startedAt: instant(2) }),
      visit({ executionId: 4, invocationId: 3, nodeId: 'draft', startedAt: instant(3) }),
    ],
  });
  const visible = executionRows(buildTraceModel({ view, collapsed: new Set([1]) }).visible);
  assert.deepEqual(
    visible.map((row) => row.executionId),
    [1, 2, 4],
  );
  assert.equal(visible.find((row) => row.executionId === 4)!.depth, 1);
});

test('run and environment events get their own lane; pauses and reloads are not repeated there', () => {
  const view = runViewFixture({
    events: [
      workflowEventFixture({ eventId: 1, kind: 'run_launched', at: instant(0) }),
      workflowEventFixture({
        eventId: 2,
        category: 'environment',
        kind: 'worktree_created',
        message: 'Created worktree feat/x',
        at: instant(1),
      }),
      workflowEventFixture({
        eventId: 3,
        category: 'environment',
        kind: 'setup_failed',
        message: 'Setup failed',
        at: instant(2),
      }),
      workflowEventFixture({ eventId: 4, kind: 'run_paused', at: instant(3) }),
      workflowEventFixture({ eventId: 5, kind: 'code_reloaded', at: instant(4) }),
      // A node event belongs to its execution's row, not to the run lane.
      workflowEventFixture({ eventId: 6, executionId: 1, category: 'node', kind: 'node_started' }),
      // A Retry names the execution it is about and is still a run event.
      workflowEventFixture({
        eventId: 7,
        executionId: 2,
        kind: 'run_retried',
        message: 'Retrying plan',
        at: instant(5),
      }),
    ],
  });
  const model = buildTraceModel({ view, collapsed: noneCollapsed });
  assert.deepEqual(
    model.runEvents.map((event) => [event.kind, event.at, event.tone]),
    [
      ['run_launched', clockAt(0), 'default'],
      ['worktree_created', clockAt(1), 'default'],
      ['setup_failed', clockAt(2), 'bad'],
      ['run_retried', clockAt(5), 'default'],
    ],
  );
  assert.equal(model.runEvents[1]!.message, 'Created worktree feat/x');
});
