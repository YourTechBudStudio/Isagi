import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowSummaryFixture } from '../../../lib/workspace/workflow/test-support.js';
import { clockAt, instant, nested, rootFrame, runStateFixture, visit } from './test-support.js';
import { buildTraceModel } from './trace.js';

/**
 * Trace is the historical half, and it answers to recorded facts alone.
 */

/** The visits, without the frame lifecycles the model interleaves with them. */
const executions = (model: ReturnType<typeof buildTraceModel>) =>
  model.rows.filter((row) => row.kind === 'execution');

const summary = workflowSummaryFixture({ createdAt: instant(0) });

test('callback time and wait time are separate bars, never one summed span', () => {
  const state = runStateFixture({
    summary,
    executions: [
      visit({
        executionId: 1,
        nodeId: 'ask',
        startedAt: instant(1),
        callbackStartedAt: instant(1),
        callbackEndedAt: instant(3),
        waitArmedAt: instant(3),
        waitDeliveredAt: instant(40),
        endedAt: instant(40),
        status: 'completed',
      }),
    ],
  });

  const model = buildTraceModel({ state, collapsed: new Set() });
  const bars = executions(model)[0]!.bars;
  assert.deepEqual(
    bars.map((bar) => bar.kind),
    ['callback', 'wait'],
  );
  // A two-second callback followed by a thirty-seven second wait is not a thirty-nine second step.
  // Absolute instants, so the model never goes stale with the clock.
  assert.equal(bars[0]!.start, clockAt(1));
  assert.equal(bars[0]!.end, clockAt(3));
  assert.equal(bars[1]!.start, clockAt(3));
  assert.equal(bars[1]!.end, clockAt(40));
});

test('an interval whose end was never observed is not drawn as though it reached now', () => {
  const state = runStateFixture({
    summary,
    executions: [
      visit({
        executionId: 1,
        nodeId: 'lost',
        startedAt: instant(1),
        callbackStartedAt: instant(1),
        callbackEndedAt: null,
        endedAt: null,
        endCertainty: 'unknown',
        status: 'running',
      }),
    ],
  });

  const model = buildTraceModel({ state, collapsed: new Set() });
  const row = executions(model)[0]!;
  assert.equal(row.endedAt, null);
  assert.equal(row.endUnknown, true, 'no honest duration exists for an unobserved end');
  assert.equal(row.bars[0]!.open, false, 'an unknown end is not an open interval');
  assert.equal(
    row.bars[0]!.end,
    row.bars[0]!.start,
    'and it is drawn as a point rather than stretched to the clock',
  );
});

test('every revisit is its own row, and a repaired execution stays one row', () => {
  const state = runStateFixture({
    summary,
    executions: [
      visit({ executionId: 1, nodeId: 'draft', visitIndex: 0, startedAt: instant(1) }),
      visit({
        executionId: 2,
        nodeId: 'draft',
        visitIndex: 1,
        startedAt: instant(5),
        attemptCount: 3,
      }),
    ],
  });

  const model = buildTraceModel({ state, collapsed: new Set() });
  const visits = executions(model);
  assert.equal(visits.length, 2, 'two visits, two rows');
  assert.deepEqual(
    visits.map((row) => row.visitIndex),
    [0, 1],
  );
  assert.ok(
    visits.every((row) => row.repeated),
    'both are marked as repeats of one node',
  );
  // Three attempts at the second visit did not become three rows.
  assert.equal(visits.filter((row) => row.executionId === 2).length, 1);
});

test('a node the current definition dropped still has a row, because Trace is the record', () => {
  const state = runStateFixture({
    summary,
    executions: [visit({ executionId: 1, nodeId: 'deleted-in-v2', startedAt: instant(1) })],
  });
  // No topology is consulted at all: this model is built from recorded facts.
  const model = buildTraceModel({ state, collapsed: new Set() });
  assert.equal(executions(model)[0]?.nodeId, 'deleted-in-v2');
});

test('collapsing one invocation of a reused graph does not fold away the other', () => {
  const state = runStateFixture({
    summary,
    frames: [
      rootFrame(),
      nested({ frameId: 2, parentExecutionId: 1, parentFrameId: 1, graphKey: 'review', depth: 1 }),
      nested({ frameId: 3, parentExecutionId: 2, parentFrameId: 1, graphKey: 'review', depth: 1 }),
    ],
    executions: [
      visit({
        executionId: 1,
        nodeId: 'first',
        nodeKind: 'subgraph',
        childFrameId: 2,
        startedAt: instant(1),
      }),
      visit({
        executionId: 2,
        nodeId: 'second',
        nodeKind: 'subgraph',
        childFrameId: 3,
        startedAt: instant(2),
      }),
      visit({ executionId: 10, frameId: 2, nodeId: 'read', startedAt: instant(3) }),
      visit({ executionId: 11, frameId: 3, nodeId: 'read', startedAt: instant(4) }),
    ],
  });

  const model = buildTraceModel({ state, collapsed: new Set([1]) });
  assert.deepEqual(
    model.visible.filter((row) => row.kind === 'execution').map((row) => row.executionId),
    [1, 2, 11],
    "the first invocation's child is hidden; the second invocation's is not",
  );
  assert.equal(executions(model).length, 4, 'and every execution is still in the model');
});

test('a routing decision is its own marker, addressed by the execution that made it', () => {
  const state = runStateFixture({
    summary,
    executions: [
      visit({
        executionId: 1,
        nodeId: 'draft',
        startedAt: instant(1),
        endedAt: instant(4),
        status: 'completed',
        routing: {
          edgeId: 'after-draft',
          attemptIndex: 1,
          chosen: 'review',
          updateRef: null,
          startedAt: instant(3),
          endedAt: instant(4),
          failure: null,
        },
      }),
    ],
  });

  const model = buildTraceModel({ state, collapsed: new Set() });
  assert.deepEqual(executions(model)[0]!.routing?.selection, { kind: 'routing', executionId: 1 });
  assert.equal(executions(model)[0]!.routing?.chosen, 'review');
});

test('pause bands come from recorded pause intervals, not from the run status', () => {
  const state = {
    ...runStateFixture({ summary, executions: [] }),
    pauseIntervals: [
      { openedAtRevision: 4, openedAt: instant(10), closedAt: instant(20), closedAtRevision: 6 },
      { openedAtRevision: 8, openedAt: instant(30), closedAt: null, closedAtRevision: null },
    ],
  };
  const model = buildTraceModel({ state, collapsed: new Set() });
  assert.equal(model.pauses.length, 2);
  assert.equal(model.pauses[0]!.end, clockAt(20));
  // An open pause carries no close; the caller substitutes the clock when it draws it.
  assert.equal(model.pauses[1]!.end, null);
});

test('an ended run marks where it ended rather than where the clock is now', () => {
  const state = runStateFixture({
    summary: workflowSummaryFixture({
      createdAt: instant(0),
      endedAt: instant(30),
      status: 'done',
    }),
    executions: [visit({ executionId: 1, nodeId: 'draft', startedAt: instant(1) })],
  });
  const model = buildTraceModel({ state, collapsed: new Set() });
  assert.equal(model.ended, true);
  assert.equal(model.endedAt, clockAt(30));
});

/**
 * A graph's own lifecycle, which is the only representation its setup and result code ever get.
 */

const failedEntry = {
  segmentKind: 'graph_entry' as const,
  segmentRef: null,
  attemptCount: 1,
  startedAt: instant(0),
  endedAt: instant(1),
  endCertainty: 'observed' as const,
  firstArtifactHash: 'sha256:pin-1',
  latestArtifactHash: 'sha256:pin-1',
  latestAttempt: {
    attemptId: 1,
    attemptIndex: 1,
    artifactHash: 'sha256:pin-1',
    status: 'failed' as const,
    invocationKind: 'initial' as const,
    failure: { code: 'graph_init_failed' as const, message: 'init threw', detail: null },
    recoveryMode: 'rerun_producer' as const,
    producerArtifactHash: null,
  },
  priorFailures: [],
};

test('a root whose setup threw has a row, not "nothing has run yet"', () => {
  const state = runStateFixture({
    summary,
    frames: [rootFrame({ status: 'initializing', entry: failedEntry })],
    executions: [],
  });

  const model = buildTraceModel({ state, collapsed: new Set() });
  assert.equal(model.rows.length, 1, 'the run has no executions and still has something to show');

  const row = model.rows[0]!;
  assert.equal(row.kind, 'frame');
  if (row.kind !== 'frame') return;
  assert.equal(row.status, 'failed');
  // The identity is the frame's, never a node-execution id synthesized for a segment without one.
  assert.deepEqual(row.entry?.selection, { kind: 'frame_segment', frameId: 1, segment: 'entry' });
  assert.equal(row.entry?.failed, true);
});

test('the root lifecycle is always present, and its published output is selectable', () => {
  const state = runStateFixture({
    summary,
    frames: [
      rootFrame({
        status: 'completed',
        completedAt: instant(30),
        output: {
          outcomeId: 'shipped',
          outcomeKind: 'success',
          outcomeReason: null,
          producedRef: { inline: { ok: true } },
          producerArtifactHash: 'sha256:pin-1',
        },
      }),
    ],
    executions: [visit({ executionId: 1, nodeId: 'draft', startedAt: instant(1) })],
  });

  const model = buildTraceModel({ state, collapsed: new Set() });
  const frame = model.rows.find((row) => row.kind === 'frame');
  assert.ok(frame && frame.kind === 'frame');
  assert.deepEqual(frame.output?.selection, { kind: 'frame_output', frameId: 1 });
  assert.equal(frame.output?.label, 'shipped');
  // The frame was entered before anything ran inside it, and one clock keeps one order.
  assert.equal(model.rows[0], frame);
});

test('an output evaluation that produced no outcome is neither a success nor a failure', () => {
  const state = runStateFixture({
    summary,
    frames: [
      rootFrame({
        outputEvaluation: {
          ...failedEntry,
          segmentKind: 'graph_output',
          segmentRef: 'shipped',
          latestAttempt: { ...failedEntry.latestAttempt, status: 'running', failure: null },
        },
      }),
    ],
    executions: [],
  });
  const row = buildTraceModel({ state, collapsed: new Set() }).rows[0]!;
  assert.equal(row.kind, 'frame');
  if (row.kind !== 'frame') return;
  assert.equal(row.output?.kind, 'unresolved');
  assert.deepEqual(row.output?.selection, { kind: 'frame_segment', frameId: 1, segment: 'output' });
});

test('a child frame gets a lifecycle row only when one of its own segments recorded something', () => {
  const quiet = runStateFixture({
    summary,
    frames: [
      rootFrame(),
      nested({ frameId: 2, parentExecutionId: 1, parentFrameId: 1, graphKey: 'review', depth: 1 }),
    ],
    executions: [visit({ executionId: 1, nodeId: 'pass', nodeKind: 'subgraph', childFrameId: 2 })],
  });
  assert.equal(
    buildTraceModel({ state: quiet, collapsed: new Set() }).rows.filter(
      (row) => row.kind === 'frame',
    ).length,
    1,
    "only the root: a child's output already has a marker on the visit that invoked it",
  );

  const stuck = runStateFixture({
    summary,
    frames: [
      rootFrame(),
      nested({
        frameId: 2,
        parentExecutionId: 1,
        parentFrameId: 1,
        graphKey: 'review',
        depth: 1,
        frame: { entry: failedEntry },
      }),
    ],
    executions: [visit({ executionId: 1, nodeId: 'pass', nodeKind: 'subgraph', childFrameId: 2 })],
  });
  const frames = buildTraceModel({ state: stuck, collapsed: new Set() }).rows.filter(
    (row) => row.kind === 'frame',
  );
  assert.equal(frames.length, 2, 'a child whose setup threw has no other representation at all');
  assert.equal(frames.at(-1)?.depth, 1, 'and it is indented under the visit that opened it');
});

test("a frame's lifecycle folds away with the visit that opened it", () => {
  const state = runStateFixture({
    summary,
    frames: [
      rootFrame(),
      nested({
        frameId: 2,
        parentExecutionId: 1,
        parentFrameId: 1,
        graphKey: 'review',
        depth: 1,
        frame: { entry: failedEntry },
      }),
    ],
    executions: [visit({ executionId: 1, nodeId: 'pass', nodeKind: 'subgraph', childFrameId: 2 })],
  });
  const collapsed = buildTraceModel({ state, collapsed: new Set([1]) });
  assert.equal(
    collapsed.visible.filter((row) => row.kind === 'frame' && row.frameId === 2).length,
    0,
  );
  assert.equal(collapsed.rows.filter((row) => row.kind === 'frame').length, 2, 'still recorded');
});

test('the model carries no clock, so a tick cannot make it stale', () => {
  const state = runStateFixture({
    summary,
    executions: [visit({ executionId: 1, nodeId: 'draft', startedAt: instant(1) })],
  });
  // Built twice at different moments: identical, because nothing in it is time-dependent. This is
  // what bounds a live inspector's per-second cost to what is on screen.
  assert.deepEqual(
    buildTraceModel({ state, collapsed: new Set() }),
    buildTraceModel({ state, collapsed: new Set() }),
  );
});

test('a restart-interrupted visit is not drawn as though it were still running', () => {
  const state = runStateFixture({
    summary,
    executions: [
      visit({
        executionId: 1,
        nodeId: 'writer',
        startedAt: instant(1),
        callbackStartedAt: instant(1),
        callbackEndedAt: null,
        endedAt: null,
        endCertainty: 'unknown',
        status: 'running',
      }),
    ],
  });
  const row = executions(buildTraceModel({ state, collapsed: new Set() }))[0]!;
  const callback = row.bars.find((bar) => bar.kind === 'callback')!;
  assert.equal(callback.open, false, 'nobody observed it running; it is not open');
  assert.equal(callback.end, callback.start, 'and it is not stretched to the clock');
});
