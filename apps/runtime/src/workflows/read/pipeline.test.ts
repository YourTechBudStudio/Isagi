import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { RuntimeEvent, WorkflowExecutionDto } from '@isagi/contracts';

import type { RuntimeEventBusService } from '../../runtime-events/event-bus.js';
import type { EngineHarness } from '../engine/test-support.js';
import { drivePipeline, publishFixture, withHarness } from '../fixtures/reviewed-document/drive.js';
import { run } from '../persistence/test-support.js';
import { makeWorkflowRunProjection } from './projection.service.js';
import { makeWorkflowDeltaPublisher } from './publisher.js';

/**
 * The story's own pipeline, read back through the API.
 *
 * The engine's suites prove the run is recorded correctly. This proves the *read model* describes
 * that same run correctly — every nested identity at every depth, each round distinguishable from
 * the last, and the live stream saying the same thing as a cold refetch. A fixture that only
 * exercised a flat run would prove none of it.
 */

function read<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, never>);
}

function inspect(harness: EngineHarness) {
  const events: RuntimeEvent[] = [];
  const bus: Pick<RuntimeEventBusService, 'publish'> = {
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
  };
  return {
    projection: makeWorkflowRunProjection(harness.fixture.database, harness.fixture.payloads),
    publisher: makeWorkflowDeltaPublisher(harness.fixture.database, bus, 0),
    events,
  };
}

async function allExecutions(
  projection: ReturnType<typeof makeWorkflowRunProjection>,
  runId: number,
) {
  const items: WorkflowExecutionDto[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await read(
      projection.listRunExecutions(runId, {
        limit: 50,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    items.push(...page.items);
    if (page.nextCursor === null) {
      assert.equal(page.boundary.complete, true);
      return { items, boundary: page.boundary };
    }
    cursor = page.nextCursor;
  }
}

test('the reviewed-document run reads back with every nested identity and round intact', async () => {
  await withHarness(async (harness) => {
    publishFixture(harness);
    const launched = await harness.launch({
      workflowKey: 'reviewed-document',
      inputs: { topic: 'graph execution' },
    });
    const verdicts = ['ready', 'revise', 'approve this draft'];
    const finished = await drivePipeline(
      harness,
      launched.id,
      (round) => verdicts[round - 1] ?? 'approve this draft',
    );
    assert.equal(finished.status, 'done');

    const { projection, publisher, events } = inspect(harness);
    const executions = await allExecutions(projection, launched.id);
    const summary = (await read(projection.getRun(launched.id))).run;

    // One clock across every frame, in start order, with no visit missing from the waterfall.
    const startedAt = executions.items.map((execution) => execution.startedAt);
    assert.deepEqual(startedAt, [...startedAt].sort());
    const recorded = await run(harness.fixture.runs.listFrames(launched.id));
    const recordedExecutions = (
      await Promise.all(recorded.map((frame) => run(harness.fixture.runs.listExecutions(frame.id))))
    ).flat();
    assert.equal(
      executions.items.length,
      recordedExecutions.length,
      'the read model describes every visit the engine recorded, and invents none',
    );

    // Three depths, and one reusable graph invoked as several distinct frames.
    assert.deepEqual([...new Set(executions.items.map((item) => item.depth))].sort(), [0, 1, 2]);
    const reviewFrames = new Set(
      executions.items.filter((item) => item.graphKey === 'review').map((item) => item.frameId),
    );
    assert.ok(reviewFrames.size >= 2, 'the review graph ran as more than one frame');
    const reviewVisits = executions.items.filter((item) => item.nodeId === 'review');
    assert.deepEqual(
      reviewVisits.map((visit) => visit.visitIndex),
      reviewVisits.map((_visit, index) => index),
      'repeated visits to one node are separate rows with increasing visit indices',
    );
    for (const visit of reviewVisits) {
      assert.equal(visit.childFrame?.graphKey, 'review');
      assert.equal(visit.childFrame?.parentExecutionId, visit.executionId);
      assert.ok(
        visit.childFrame?.displayName?.startsWith('review round'),
        'each invocation keeps the name captured when its frame was created',
      );
    }
    assert.equal(
      new Set(reviewVisits.map((visit) => visit.childFrameId)).size,
      reviewVisits.length,
      'two invocations of one definition never share a frame',
    );

    // The capabilities on a node are the ones actually called, never inferred from source.
    const called = new Set(
      executions.items.flatMap((item) => [...item.operationSummary.capabilities]),
    );
    assert.ok(
      called.has('run_headless_agent'),
      `expected recorded capabilities, saw ${[...called]}`,
    );
    const root = executions.items.find((item) => item.depth === 0 && item.nodeKind === 'subgraph');
    assert.ok(
      (root?.operationSummary.count ?? 0) > 0,
      'a subgraph reports the work done beneath it',
    );

    // Terminal facts: the run's outcome, and the root frame's own output attempt on the clock.
    assert.equal(summary.status, 'done');
    assert.equal(summary.outcome?.kind, 'success');
    const frames = await read(projection.listFrames(launched.id, { limit: 100 }));
    const rootFrame = frames.items.find((frame) => frame.depth === 0)!;
    assert.equal(rootFrame.status, 'completed');
    assert.ok(rootFrame.output !== null);
    assert.ok(
      rootFrame.outputEvaluation?.startedAt,
      'the outcome has a moment on the clock, carried by the segment that evaluated it',
    );
    assert.equal(rootFrame.outputEvaluation?.latestAttempt.status, 'succeeded');
    assert.ok(rootFrame.entry?.startedAt, 'and the frame reports its own initialization segment');
    assert.equal(rootFrame.entry?.latestAttempt.failure, null);

    // And the live stream says exactly what the cold read says.
    await read(publisher.drainOnce);
    const streamed = new Map<number, WorkflowExecutionDto>();
    let applied = 0;
    for (const event of events) {
      if (event.type !== 'workflow_run_transition') continue;
      assert.equal(event.payload.revision, applied + 1, 'revisions arrive contiguous and in order');
      applied = event.payload.revision;
      for (const execution of event.payload.changes.executions) {
        streamed.set(execution.executionId, execution);
      }
    }
    assert.equal(applied, summary.revision);
    assert.deepEqual(
      [...streamed.values()].sort((left, right) => left.executionId - right.executionId),
      [...executions.items].sort((left, right) => left.executionId - right.executionId),
      'a client that only ever saw deltas holds the same rows as one that refetched',
    );
  });
});

test('an authored failure outcome reads as data, not as a broken run', async () => {
  await withHarness(async (harness) => {
    publishFixture(harness);
    const launched = await harness.launch({
      workflowKey: 'reviewed-document',
      inputs: { topic: 'graph execution' },
    });
    // Every review asks for another revision until the writer gives up, which the author models as
    // a failure *outcome* crossing the graph boundary.
    const finished = await drivePipeline(harness, launched.id, () => 'revise');

    const { projection } = inspect(harness);
    const summary = (await read(projection.getRun(launched.id))).run;
    assert.equal(summary.status, finished.status);
    assert.equal(
      summary.failure,
      null,
      'an authored failure outcome is not a segment failure, and the summary does not pretend it is',
    );
    if (summary.outcome) {
      assert.ok(['success', 'failure'].includes(summary.outcome.kind));
    }
    const frames = await read(projection.listFrames(launched.id, { limit: 100 }));
    const failing = frames.items.filter((frame) => frame.output?.outcomeKind === 'failure');
    assert.ok(
      failing.length > 0,
      'the failure the author declared is visible as a frame outcome with its own payload',
    );
    for (const frame of failing) {
      assert.ok(frame.output!.producerArtifactHash !== null, 'and names the pin that produced it');
    }
  });
});

test('every record the engine wrote has a delivered snapshot, at every depth', async () => {
  await withHarness(async (harness) => {
    publishFixture(harness);
    const launched = await harness.launch({
      workflowKey: 'reviewed-document',
      inputs: { topic: 'graph execution' },
    });
    await drivePipeline(
      harness,
      launched.id,
      (round) => ['ready', 'revise', 'approve this draft'][round - 1] ?? 'approve this draft',
    );

    // The completeness check the change-set mapping needs but cannot prove about itself: if any
    // transition failed to name a record it created or changed, that record would sit in the
    // database with nothing in history pointing at it, and no client would ever be told about it.
    const missing = harness.fixture.client
      .prepare(
        `SELECT 'frame' AS kind, f.id AS id FROM workflow_graph_frames f
           WHERE f.run_id = ?
             AND NOT EXISTS (SELECT 1 FROM workflow_transition_changes c
                             WHERE c.run_id = ? AND c.record_kind = 'frame' AND c.record_id = f.id)
         UNION ALL
         SELECT 'execution', e.id FROM workflow_node_executions e
           WHERE e.run_id = ?
             AND NOT EXISTS (SELECT 1 FROM workflow_transition_changes c
                             WHERE c.run_id = ? AND c.record_kind = 'execution' AND c.record_id = e.id)
         UNION ALL
         SELECT 'operation', o.id FROM workflow_operations o
           WHERE o.run_id = ?
             AND NOT EXISTS (SELECT 1 FROM workflow_transition_changes c
                             WHERE c.run_id = ? AND c.record_kind = 'operation' AND c.record_id = o.id)`,
      )
      .all(...(Array.from({ length: 6 }, () => launched.id) as number[]));
    assert.deepEqual(missing, [], 'no record is invisible to the read model');

    // And the last snapshot of each record is the one a reader gets, so nothing is stale either.
    const { projection } = inspect(harness);
    const executions = await allExecutions(projection, launched.id);
    const stale = executions.items.filter(
      (execution) => execution.status === 'running' && execution.endedAt !== null,
    );
    assert.deepEqual(stale, [], 'a finished visit is not still reported as running');
    for (const execution of executions.items) {
      if (execution.childFrameId === null) continue;
      const frame = (await read(projection.listFrames(launched.id, { limit: 100 }))).items.find(
        (candidate) => candidate.frameId === execution.childFrameId,
      )!;
      assert.equal(
        execution.childFrame?.status,
        frame.status,
        'the frame carried inline on a visit agrees with the frame read on its own',
      );
      assert.equal(execution.childFrame?.executionCount, frame.executionCount);
    }
  });
});
