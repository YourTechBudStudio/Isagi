import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowEventFixture } from '../../../lib/workspace/workflow/test-support.js';
import { aggregateVisits } from './aggregate.js';
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

/**
 * Aggregation, and the two claims it must never make: that a reused graph has one history, and that
 * an edge was taken because both of its ends happen to have run.
 */

const review = graphFixture({
  key: 'review',
  entry: 'draft',
  nodes: [{ id: 'draft', kind: 'operation' }],
  edges: [{ id: 'after-draft', from: 'draft', to: ['ok'] }],
  outcomes: [{ id: 'ok', kind: 'success' }],
});

const root = graphFixture({
  key: 'root',
  entry: 'first',
  nodes: [
    { id: 'first', kind: 'subgraph', graphKey: 'review' },
    { id: 'second', kind: 'subgraph', graphKey: 'review' },
  ],
  edges: [
    { id: 'after-first', from: 'first', to: ['second'] },
    { id: 'after-second', from: 'second', to: ['shipped'] },
  ],
  outcomes: [{ id: 'shipped', kind: 'success' }],
});

const topology = buildTopology(descriptorFixture([root, review], 'root'));
const now = clockAt(100);

function twoRegistrations() {
  return runViewFixture({
    invocations: [
      rootInvocation(),
      nested({ invocationId: 2, parentExecutionId: 10, graphKey: 'review', depth: 1 }),
      nested({ invocationId: 3, parentExecutionId: 11, graphKey: 'review', depth: 1 }),
    ],
    executions: [
      visit({
        executionId: 10,
        nodeId: 'first',
        nodeKind: 'subgraph',
        childInvocationId: 2,
        routedTo: 'second',
        startedAt: instant(0),
        endedAt: instant(10),
      }),
      visit({
        executionId: 20,
        invocationId: 2,
        nodeId: 'draft',
        routedTo: 'ok',
        startedAt: instant(1),
        endedAt: instant(9),
      }),
      visit({
        executionId: 11,
        nodeId: 'second',
        nodeKind: 'subgraph',
        childInvocationId: 3,
        status: 'running',
        startedAt: instant(10),
        endedAt: null,
      }),
      visit({
        executionId: 21,
        invocationId: 3,
        nodeId: 'draft',
        status: 'failed',
        startedAt: instant(11),
        endedAt: instant(12),
      }),
    ],
  });
}

const key = (path: readonly string[], kind: 'node' | 'edge' | 'outcome', id: string) =>
  addressKey({ path, kind, id });

test('two registrations of one graph keep two separate histories', () => {
  const aggregation = aggregateVisits({ view: twoRegistrations(), topology, now });
  const first = aggregation.byElement.get(key(['first'], 'node', 'draft'))!;
  const second = aggregation.byElement.get(key(['second'], 'node', 'draft'))!;
  assert.deepEqual(
    first.visits.map((row) => row.executionId),
    [20],
  );
  assert.equal(first.status, 'completed');
  assert.deepEqual(
    second.visits.map((row) => row.executionId),
    [21],
  );
  assert.equal(second.status, 'failed');
});

test('a subgraph registration counts the executions inside it, and only inside it', () => {
  const aggregation = aggregateVisits({ view: twoRegistrations(), topology, now });
  assert.equal(aggregation.byElement.get(key([], 'node', 'first'))!.nestedExecutionCount, 1);
  assert.equal(aggregation.byElement.get(key([], 'node', 'second'))!.nestedExecutionCount, 1);
});

test('an edge is taken only where a recorded routing decision says so', () => {
  const aggregation = aggregateVisits({ view: twoRegistrations(), topology, now });
  const links = topology.links.filter((link) => aggregation.takenLinks.has(link.id));
  // first → after-first → second, and inside `first`: draft → after-draft → ok.
  assert.deepEqual(
    links.map((link) => link.toKey).sort(),
    [
      key(['first'], 'edge', 'after-draft'),
      key(['first'], 'outcome', 'ok'),
      key([], 'edge', 'after-first'),
      key([], 'node', 'second'),
    ].sort(),
  );
  // `second` is running and has not routed, so its edge is not taken even though it ran.
  assert.equal(
    aggregation.byElement.get(key([], 'edge', 'after-second'))!.chosenDestinations.length,
    0,
  );
  assert.deepEqual(
    aggregation.byElement
      .get(key([], 'edge', 'after-first'))!
      .routedBy.map((row) => row.executionId),
    [10],
  );
});

test('a live node rolls up as live, and its time counts to now', () => {
  const aggregation = aggregateVisits({ view: twoRegistrations(), topology, now });
  const second = aggregation.byElement.get(key([], 'node', 'second'))!;
  assert.equal(second.status, 'running');
  assert.equal(second.open, true);
  assert.equal(second.durationMs, now - clockAt(10));
});

test('a node that failed and was retried successfully reads as completed', () => {
  const view = runViewFixture({
    executions: [
      visit({ executionId: 1, nodeId: 'first', status: 'failed', startedAt: instant(0) }),
      visit({ executionId: 2, nodeId: 'first', retryOf: 1, startedAt: instant(5) }),
    ],
  });
  const first = aggregateVisits({ view, topology, now }).byElement.get(key([], 'node', 'first'))!;
  assert.equal(first.status, 'completed');
  assert.equal(first.visits.length, 2);
});

test('operation kinds come from the operation events of the node’s executions', () => {
  const view = runViewFixture({
    executions: [visit({ executionId: 1, nodeId: 'first' })],
    events: [
      workflowEventFixture({
        eventId: 1,
        executionId: 1,
        category: 'node',
        kind: 'operation_started',
        data: { operationId: 1, kind: 'send_prompt' },
      }),
      workflowEventFixture({
        eventId: 2,
        executionId: 1,
        category: 'node',
        kind: 'operation_started',
        data: { operationId: 2, kind: 'send_prompt' },
      }),
    ],
  });
  const first = aggregateVisits({ view, topology, now }).byElement.get(key([], 'node', 'first'))!;
  assert.deepEqual(first.operationKinds, ['send_prompt']);
});
