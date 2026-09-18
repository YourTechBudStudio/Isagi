import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateVisits } from './aggregate.js';
import {
  clockAt,
  descriptorFixture,
  graphFixture,
  instant,
  nested,
  rootFrame,
  runStateFixture,
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
  return runStateFixture({
    frames: [
      rootFrame(),
      nested({ frameId: 2, parentExecutionId: 10, parentFrameId: 1, graphKey: 'review', depth: 1 }),
      nested({ frameId: 3, parentExecutionId: 11, parentFrameId: 1, graphKey: 'review', depth: 1 }),
    ],
    executions: [
      visit({
        executionId: 10,
        frameId: 1,
        nodeId: 'first',
        nodeKind: 'subgraph',
        childFrameId: 2,
      }),
      visit({
        executionId: 11,
        frameId: 1,
        nodeId: 'second',
        nodeKind: 'subgraph',
        childFrameId: 3,
      }),
      visit({
        executionId: 20,
        frameId: 2,
        graphKey: 'review',
        nodeId: 'draft',
        startedAt: instant(1),
        callbackStartedAt: instant(1),
        callbackEndedAt: instant(3),
        endedAt: instant(3),
        status: 'completed',
        operationSummary: { count: 1, unresolved: 0, capabilities: ['send_agent_prompt'] },
      }),
      visit({
        executionId: 21,
        frameId: 3,
        graphKey: 'review',
        nodeId: 'draft',
        startedAt: instant(5),
        callbackStartedAt: instant(5),
        callbackEndedAt: instant(6),
        endedAt: instant(6),
        status: 'completed',
        operationSummary: { count: 2, unresolved: 0, capabilities: ['run_headless_agent'] },
      }),
    ],
  });
}

test('two registrations of one graph keep two separate histories', () => {
  const aggregation = aggregateVisits({ state: twoRegistrations(), topology, now });

  const first = aggregation.byElement.get(
    addressKey({ path: ['first'], kind: 'node', id: 'draft' }),
  );
  const second = aggregation.byElement.get(
    addressKey({ path: ['second'], kind: 'node', id: 'draft' }),
  );

  assert.deepEqual(
    first?.visits.map((row) => row.executionId),
    [20],
  );
  assert.deepEqual(
    second?.visits.map((row) => row.executionId),
    [21],
  );
  // Capabilities are recorded facts, so they do not bleed across registrations either.
  assert.deepEqual(first?.capabilities, ['send_agent_prompt']);
  assert.deepEqual(second?.capabilities, ['run_headless_agent']);
});

test('a subgraph registration counts the executions inside it, and only inside it', () => {
  const aggregation = aggregateVisits({ state: twoRegistrations(), topology, now });
  assert.equal(
    aggregation.byElement.get(addressKey({ path: [], kind: 'node', id: 'first' }))
      ?.nestedExecutionCount,
    1,
  );
});

test('an edge is taken only where a routing decision says so', () => {
  const state = runStateFixture({
    frames: [rootFrame()],
    executions: [
      visit({
        executionId: 1,
        nodeId: 'first',
        nodeKind: 'subgraph',
        status: 'completed',
        // Both endpoints of `after-second` have run, but nothing routed through it.
        routing: {
          edgeId: 'after-first',
          attemptIndex: 1,
          chosen: 'second',
          updateRef: null,
          startedAt: instant(2),
          endedAt: instant(2),
          failure: null,
        },
      }),
      visit({ executionId: 2, nodeId: 'second', nodeKind: 'subgraph', status: 'completed' }),
    ],
  });

  const aggregation = aggregateVisits({ state, topology, now });
  const firstEdge = addressKey({ path: [], kind: 'edge', id: 'after-first' });
  const secondEdge = addressKey({ path: [], kind: 'edge', id: 'after-second' });

  assert.ok(
    aggregation.takenLinks.has(
      `${addressKey({ path: [], kind: 'node', id: 'first' })}->${firstEdge}`,
    ),
  );
  assert.ok(
    aggregation.takenLinks.has(
      `${firstEdge}->${addressKey({ path: [], kind: 'node', id: 'second' })}`,
    ),
  );
  // `second` ran and `shipped` exists, but no decision reached that edge.
  assert.equal(
    aggregation.takenLinks.has(
      `${addressKey({ path: [], kind: 'node', id: 'second' })}->${secondEdge}`,
    ),
    false,
  );
  assert.equal(
    aggregation.byElement.get(secondEdge)?.status,
    'unvisited',
    'an edge nothing routed through has not been visited',
  );
});

test('an edge whose routing threw reads as failed, not as undecided', () => {
  const state = runStateFixture({
    frames: [rootFrame()],
    executions: [
      visit({
        executionId: 1,
        nodeId: 'first',
        nodeKind: 'subgraph',
        status: 'failed',
        routing: {
          edgeId: 'after-first',
          attemptIndex: 1,
          chosen: null,
          updateRef: null,
          startedAt: instant(2),
          endedAt: instant(2),
          failure: { code: 'edge_choose_failed', message: 'boom', detail: null },
        },
      }),
    ],
  });
  const aggregation = aggregateVisits({ state, topology, now });
  const edge = aggregation.byElement.get(addressKey({ path: [], kind: 'edge', id: 'after-first' }));
  assert.equal(edge?.status, 'failed');
  assert.deepEqual(edge?.chosenDestinations, []);
});

test('only the addresses a delta touched are recomputed', () => {
  const before = twoRegistrations();
  const first = aggregateVisits({ state: before, topology, now });
  assert.ok(first.recomputed.length > 1, 'the first pass computes everything');

  // One row replaced, exactly as a delta replaces it; every other row keeps its identity.
  const moved = visit({
    executionId: 21,
    frameId: 3,
    graphKey: 'review',
    nodeId: 'draft',
    startedAt: instant(5),
    callbackStartedAt: instant(5),
    callbackEndedAt: instant(9),
    endedAt: instant(9),
    status: 'completed',
    operationSummary: { count: 3, unresolved: 0, capabilities: ['run_headless_agent'] },
  });
  const executions = new Map(before.executions);
  executions.set(21, moved);
  const after = aggregateVisits({
    state: { ...before, executions },
    topology,
    now,
    previous: first,
  });

  assert.deepEqual(
    [...after.recomputed].sort(),
    [
      addressKey({ path: [], kind: 'node', id: 'second' }),
      addressKey({ path: ['second'], kind: 'node', id: 'draft' }),
    ].sort(),
    'the visit that changed and the registration that contains it, and nothing else',
  );
  assert.equal(
    after.byElement.get(addressKey({ path: ['first'], kind: 'node', id: 'draft' })),
    first.byElement.get(addressKey({ path: ['first'], kind: 'node', id: 'draft' })),
    'an untouched aggregate keeps its identity, so nothing downstream re-renders',
  );
});

test('a clock tick re-derives open aggregates and leaves finished ones alone', () => {
  const state = runStateFixture({
    frames: [rootFrame()],
    executions: [
      visit({
        executionId: 20,
        frameId: 1,
        nodeId: 'first',
        nodeKind: 'subgraph',
        startedAt: instant(1),
        callbackStartedAt: instant(1),
        callbackEndedAt: instant(2),
        endedAt: instant(2),
        status: 'completed',
      }),
      visit({
        executionId: 21,
        frameId: 1,
        nodeId: 'second',
        nodeKind: 'subgraph',
        startedAt: instant(3),
        callbackStartedAt: instant(3),
        status: 'running',
      }),
    ],
  });

  const first = aggregateVisits({ state, topology, now });
  const ticked = aggregateVisits({ state, topology, now: now + 1000, previous: first });

  assert.deepEqual(
    ticked.recomputed,
    [addressKey({ path: [], kind: 'node', id: 'second' })],
    'only the node with something still running depends on the clock',
  );
});

test('an interval whose end was never observed is not stretched into a measurement', () => {
  const state = runStateFixture({
    frames: [rootFrame()],
    executions: [
      visit({
        executionId: 20,
        frameId: 1,
        nodeId: 'first',
        nodeKind: 'subgraph',
        startedAt: instant(1),
        endedAt: null,
        endCertainty: 'unknown',
        callbackStartedAt: instant(1),
        callbackEndedAt: null,
        status: 'running',
      }),
    ],
  });
  const aggregation = aggregateVisits({ state, topology, now });
  const aggregate = aggregation.byElement.get(addressKey({ path: [], kind: 'node', id: 'first' }));
  assert.equal(aggregate?.hasUnknownEnd, true);
});

test('an interrupted callback carries no duration and is not reported as open', () => {
  const state = runStateFixture({
    frames: [rootFrame()],
    executions: [
      visit({
        executionId: 20,
        frameId: 1,
        nodeId: 'first',
        nodeKind: 'subgraph',
        startedAt: instant(1),
        callbackStartedAt: instant(1),
        callbackEndedAt: null,
        endedAt: null,
        endCertainty: 'unknown',
        status: 'running',
      }),
    ],
  });

  const aggregate = aggregateVisits({ state, topology, now }).byElement.get(
    addressKey({ path: [], kind: 'node', id: 'first' }),
  );
  // The owner that would have recorded the end is gone. Growing a number against the wall clock
  // would invent a measurement on the one run where nobody knows what happened.
  assert.equal(aggregate?.callbackMs, 0);
  assert.equal(aggregate?.callbackOpen, false);
  assert.equal(aggregate?.hasUnknownEnd, true);

  // And it stays that way as the clock moves.
  const later = aggregateVisits({ state, topology, now: now + 60_000 }).byElement.get(
    addressKey({ path: [], kind: 'node', id: 'first' }),
  );
  assert.equal(later?.callbackMs, 0);
});

test('a wait the run still records as armed is genuinely open, however its visit ended', () => {
  const state = runStateFixture({
    frames: [rootFrame()],
    executions: [
      visit({
        executionId: 20,
        frameId: 1,
        nodeId: 'first',
        nodeKind: 'subgraph',
        startedAt: instant(1),
        callbackStartedAt: instant(1),
        callbackEndedAt: instant(2),
        waitArmedAt: instant(2),
        waitDeliveredAt: null,
        endedAt: null,
        endCertainty: 'unknown',
        status: 'awaiting',
        wait: {
          waitId: 5,
          kind: 'user_input',
          status: 'armed',
          label: null,
          questions: null,
          answers: null,
          armedAt: instant(2),
          deliveredAt: null,
        },
      }),
    ],
  });
  const aggregate = aggregateVisits({ state, topology, now }).byElement.get(
    addressKey({ path: [], kind: 'node', id: 'first' }),
  );
  // A wait is durable: the record survives a restart, so "armed" is a fact rather than an
  // observation that was lost with its owner.
  assert.equal(aggregate?.waitOpen, true);
  assert.ok((aggregate?.waitMs ?? 0) > 0);
});

test('a clock tick re-derives only what is open, and re-walks no addressing at all', () => {
  const finished = runStateFixture({
    frames: [rootFrame()],
    executions: [
      visit({
        executionId: 10,
        frameId: 1,
        nodeId: 'first',
        nodeKind: 'subgraph',
        startedAt: instant(1),
        callbackStartedAt: instant(1),
        callbackEndedAt: instant(2),
        endedAt: instant(2),
        status: 'completed',
      }),
    ],
  });
  const first = aggregateVisits({ state: finished, topology, now });
  const ticked = aggregateVisits({ state: finished, topology, now: now + 1000, previous: first });

  // Nothing in this run is still running, so a tick has nothing to re-derive — and it certainly does
  // not re-walk frame ancestry for the whole of retained history to discover that.
  assert.deepEqual(ticked.recomputed, []);
  assert.equal(ticked.membership, first.membership, 'addressing is carried over, not rebuilt');
  assert.equal(ticked.takenLinks, first.takenLinks);
  assert.equal(ticked.now, now + 1000);

  // A run with something open re-derives that, and only that. The same state object, because the
  // whole point is that an unchanged projection short-circuits the walk.
  const running = twoRegistrations();
  const live = aggregateVisits({ state: running, topology, now });
  const liveTicked = aggregateVisits({ state: running, topology, now: now + 1000, previous: live });

  const open = [...live.byElement]
    .filter(([, aggregate]) => aggregate.callbackOpen || aggregate.waitOpen)
    .map(([key]) => key);
  assert.ok(open.length > 0, 'the fixture has something still running');
  assert.deepEqual([...liveTicked.recomputed].sort(), [...open].sort());
  assert.equal(liveTicked.membership, live.membership);
});

test('a pin change is not a clock tick, even when no execution row moved', () => {
  // The repair a Retry exists for: the edge chose a destination it had not declared, so the new pin
  // declares it. The recorded decision is unchanged — only the definition moved.
  const graphFor = (destinations: readonly string[]) =>
    graphFixture({
      key: 'root',
      entry: 'first',
      nodes: [
        { id: 'first', kind: 'subgraph', graphKey: 'review' },
        { id: 'second', kind: 'subgraph', graphKey: 'review' },
      ],
      edges: [{ id: 'after-first', from: 'first', to: destinations }],
      outcomes: [{ id: 'shipped', kind: 'success' }],
    });
  const before = buildTopology(descriptorFixture([graphFor(['shipped']), review], 'root'));
  const after = buildTopology(descriptorFixture([graphFor(['second', 'shipped']), review], 'root'));

  const state = runStateFixture({
    frames: [rootFrame()],
    executions: [
      visit({
        executionId: 1,
        nodeId: 'first',
        nodeKind: 'subgraph',
        status: 'completed',
        routing: {
          edgeId: 'after-first',
          attemptIndex: 2,
          chosen: 'second',
          updateRef: null,
          startedAt: instant(2),
          endedAt: instant(2),
          failure: null,
        },
      }),
    ],
  });

  const firstPass = aggregateVisits({ state, topology: before, now });
  const link = `${addressKey({ path: [], kind: 'edge', id: 'after-first' })}->${addressKey({
    path: [],
    kind: 'node',
    id: 'second',
  })}`;
  assert.equal(
    firstPass.takenLinks.has(link),
    false,
    'the old pin never declared that destination',
  );

  // The same execution map object, a different pin. A `retry_pin_adopted` delta carries no execution
  // rows, and an empty upsert preserves the map's identity, so this is the shape that actually
  // reaches the cache.
  const adopted = aggregateVisits({ state, topology: after, now, previous: firstPass });
  assert.equal(
    adopted.takenLinks.has(link),
    true,
    'taken edges are derived from the pin on screen, not from the one before it',
  );
  assert.notEqual(adopted.takenLinks, firstPass.takenLinks);
});

test('a pin change with no clock movement is still not reusable', () => {
  const state = runStateFixture({ frames: [rootFrame()], executions: [] });
  const other = buildTopology(descriptorFixture([review], 'review'));
  const firstPass = aggregateVisits({ state, topology, now });
  // Same instant, same executions, different pin: the short-circuit that returns the previous pass
  // verbatim must not fire.
  const adopted = aggregateVisits({ state, topology: other, now, previous: firstPass });
  assert.notEqual(adopted, firstPass);
  assert.equal(adopted.topology, other);
});
