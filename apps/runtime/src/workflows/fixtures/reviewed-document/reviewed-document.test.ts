import assert from 'node:assert/strict';
import test from 'node:test';

import { run } from '../../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import type { WaitDeclaration } from '../../types.js';
import { drivePipeline, withHarness, World } from '../drive.js';
import { publishFixture } from './drive.js';
import { makeReviewedDocumentWorkflow } from './index.js';

/**
 * The story's own pipeline, driven end to end.
 *
 * Nothing here asserts "it finished". What is asserted is the *record*: three depths of frame, one
 * reusable graph invoked twice as two distinct frames, a repeated node visit that is a second
 * execution rather than a reopened one, an authored failure outcome crossing a graph boundary as
 * data, and a human gate the runtime never satisfies on its own.
 */

test('the reviewed-document pipeline runs multiple rounds and exposes every nested identity', async () => {
  await withHarness(async (harness) => {
    publishFixture(harness);
    const launched = await harness.launch({
      workflowKey: 'reviewed-document',
      inputs: { topic: 'graph execution' },
    });

    // The judgments, in the order the run asks for them: the draft is ready for review, the first
    // review asks for a revision, the second approves.
    const verdicts = ['ready', 'revise', 'approve this draft'];
    const finished = await drivePipeline(
      harness,
      launched.id,
      (round) => verdicts[round - 1] ?? 'approve this draft',
    );

    assert.equal(finished.status, 'done');
    assert.equal(finished.outcomeId, 'delivered');

    const frames = await run(harness.fixture.runs.listFrames(launched.id));
    // Three layers: the story, the document it produced, and each review pass inside it.
    assert.deepEqual(
      [...new Set(frames.map((frame) => frame.depth))].sort(),
      [0, 1, 2],
      'every declared layer is a real frame',
    );
    assert.deepEqual(
      frames.filter((frame) => frame.depth === 0).map((frame) => frame.graphKey),
      ['story'],
    );
    assert.deepEqual(
      frames.filter((frame) => frame.depth === 1).map((frame) => frame.graphKey),
      ['reviewed-document'],
    );

    // One reusable definition, invoked more than once: distinct frames, each with its own
    // parameters and its own captured display name.
    const reviews = frames.filter((frame) => frame.graphKey === 'review');
    assert.ok(reviews.length >= 2, `expected repeated review invocations, saw ${reviews.length}`);
    assert.equal(new Set(reviews.map((frame) => frame.id)).size, reviews.length);
    assert.deepEqual(
      reviews.map((frame) => frame.displayName),
      reviews.map((_frame, index) => `review round ${index}`),
      'a dynamic name is captured once, at the commit that created the frame',
    );

    // A repeated node visit is a second execution, never a reopened row.
    const documentFrame = frames.find((frame) => frame.graphKey === 'reviewed-document')!;
    const documentExecutions = await run(harness.fixture.runs.listExecutions(documentFrame.id));
    const reviewVisits = documentExecutions.filter((execution) => execution.nodeId === 'review');
    assert.deepEqual(
      reviewVisits.map((execution) => execution.visitIndex),
      reviewVisits.map((_visit, index) => index),
    );
    assert.equal(
      new Set(reviewVisits.map((execution) => execution.childFrameId)).size,
      reviewVisits.length,
      'each visit opened its own child frame',
    );

    // Every nested frame inherited the root's destination rather than choosing one.
    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(documentFrame.id));
    assert.ok(attempts.length > 0);
    assert.ok(
      attempts.every((attempt) => attempt.artifactHash === finished.artifactHash),
      'one composed code pin for the whole run',
    );
  });
});

test('an authored failure crosses the graph boundary as data, and the person decides', async () => {
  await withHarness(async (harness) => {
    publishFixture(harness);
    const launched = await harness.launch({
      workflowKey: 'reviewed-document',
      inputs: { topic: 'escalation' },
    });

    // Nothing ever approves, so the author's own bounded counter runs out and the document graph
    // publishes its *failure* outcome. That is a value the parent routes on — not an exception.
    const stopped = await drivePipeline(harness, launched.id, (round) =>
      round === 1 ? 'ready' : 'revise',
    );

    assert.equal(stopped.status, 'waiting', 'a human gate is never satisfied by the runtime');
    const frames = await run(harness.fixture.runs.listFrames(launched.id));
    const documentFrame = frames.find((frame) => frame.graphKey === 'reviewed-document')!;
    assert.equal(documentFrame.status, 'completed');
    assert.equal(documentFrame.outcomeId, 'needs-human');
    assert.equal(documentFrame.outcomeKind, 'failure');
    assert.equal(documentFrame.outcomeReason, 'human_decision_required');

    const root = frames.find((frame) => frame.depth === 0)!;
    const rootExecutions = await run(harness.fixture.runs.listExecutions(root.id));
    assert.deepEqual(
      rootExecutions.map((execution) => execution.nodeId),
      ['document', 'decide'],
      'the parent routed the failure to the person rather than failing itself',
    );

    const armed = (await run(harness.fixture.runs.listArmedWaits(launched.id)))[0]!;
    assert.equal(armed.waitKind, 'user_input');
    assert.equal(
      await run(harness.waits.reconcileWaits(launched.id)),
      0,
      'and no amount of reconciliation answers it',
    );

    await run(
      harness.controls.advance({
        runId: launched.id,
        waitId: armed.id,
        answers: { decision: 'abandon' },
      }),
    );
    await harness.drain();

    const abandoned = await harness.runOf(launched.id);
    assert.equal(abandoned.status, 'done');
    assert.equal(abandoned.outcomeId, 'abandoned');
    assert.equal(
      abandoned.outcomeKind,
      'failure',
      'an authored failure outcome is a terminal *result*, not a run that broke',
    );
    assert.equal(abandoned.failureCode, null, 'and it carries no segment failure code');
  });
});

test('a confirmed failed writer turn returns the run to the writer rather than failing it', async () => {
  await withHarness(async (harness) => {
    publishFixture(harness);
    const launched = await harness.launch({
      workflowKey: 'reviewed-document',
      inputs: { topic: 'retries' },
    });
    await harness.drain();

    // The first turn fails. A confirmed failure is edge data: the author loops back to the writer,
    // and the run is not failed.
    const armed = (await run(harness.fixture.runs.listArmedWaits(launched.id)))[0]!;
    const declaration = (await run(harness.fixture.payloads.resolve(armed.condition!))) as Extract<
      WaitDeclaration,
      { kind: 'agent_turn' }
    >;
    const agentSessionId = declaration.target.agentSessionId;
    harness.adapters.turnEdges.set(agentSessionId, [
      {
        type: 'turn_started',
        agentSessionId,
        harnessSessionId: 'harness-1',
        seq: 1,
        recordedAt: new Date(Date.now() + 1000).toISOString(),
      },
      {
        type: 'turn_failed',
        agentSessionId,
        harnessSessionId: 'harness-1',
        seq: 1,
        recordedAt: new Date(Date.now() + 2000).toISOString(),
        reason: 'harness_error',
      },
    ]);
    await harness.deliver(launched.id);
    await harness.drain();

    const after = await harness.runOf(launched.id);
    assert.notEqual(
      after.status,
      'failed',
      'a confirmed failed turn is data, not a segment failure',
    );
    assert.equal(after.failureCode, null);

    const documentFrame = (await run(harness.fixture.runs.listFrames(launched.id))).find(
      (frame) => frame.graphKey === 'reviewed-document',
    )!;
    const visits = (await run(harness.fixture.runs.listExecutions(documentFrame.id))).filter(
      (execution) => execution.nodeId === 'askWriter',
    );
    assert.equal(visits.length, 2, 'the run came back to the writer as a new visit');
    assert.deepEqual(
      visits.map((execution) => execution.visitIndex),
      [0, 1],
    );
    assert.deepEqual(
      visits.map((execution) => execution.displayName),
      ['writer attempt 1', 'writer attempt 2'],
      'each visit captured its own name at the moment its record was created',
    );
  });
});

test('the whole pipeline survives a restart in the middle and never repeats committed work', async () => {
  await withHarness(async (harness) => {
    publishFixture(harness);
    const launched = await harness.launch({
      workflowKey: 'reviewed-document',
      inputs: { topic: 'durability' },
    });

    // Drive it as far as the first review's own agent turn, then restart the runtime under it.
    const world = new World(harness);
    await harness.drain();
    await world.endTurns(launched.id);
    await harness.drain();
    await world.completeJudgments(launched.id, () => 'ready');
    await harness.drain();

    const beforeRestart = await harness.runOf(launched.id);
    const framesBefore = await run(harness.fixture.runs.listFrames(launched.id));
    const executionsBefore = await Promise.all(
      framesBefore.map((frame) => run(harness.fixture.runs.listExecutions(frame.id))),
    );
    const spawnsBefore = harness.adapters.counters.spawnCreate;
    assert.ok(framesBefore.some((frame) => frame.graphKey === 'review'));

    await harness.restart();

    const parked = await harness.runOf(launched.id);
    assert.equal(parked.paused, true, 'every unfinished run is parked before anything dispatches');
    assert.equal(await harness.drain(), 0, 'and a parked run waits for an explicit Resume');

    // Committed work is untouched: no frame was re-entered, no execution re-created, and no session
    // was spawned a second time.
    assert.deepEqual(await run(harness.fixture.runs.listFrames(launched.id)), framesBefore);
    assert.deepEqual(
      await Promise.all(
        framesBefore.map((frame) => run(harness.fixture.runs.listExecutions(frame.id))),
      ),
      executionsBefore,
    );
    assert.equal(harness.adapters.counters.spawnCreate, spawnsBefore);

    assert.equal((await run(harness.controls.resume(launched.id))).accepted, true);
    const finished = await drivePipeline(harness, launched.id, (round) =>
      round === 1 ? 'approve this draft' : 'approve this draft',
    );
    assert.ok(
      finished.status === 'done' || finished.status === 'waiting',
      `the run continued from where it was parked (${finished.status})`,
    );
    assert.notEqual(finished.position.kind, beforeRestart.position.kind);
  });
});

test('a newer version published mid-run is not adopted by Resume, and every attempt keeps its pin', async () => {
  await withHarness(async (harness) => {
    const pinA = publishFixture(harness, 'A');
    const launched = await harness.launch({
      workflowKey: 'reviewed-document',
      inputs: { topic: 'versions' },
    });
    const world = new World(harness);
    await harness.drain();
    await world.endTurns(launched.id);
    await harness.drain();

    // Retry is the *only* control that adopts code, and its behaviour is proven against a run it can
    // actually repair in `engine/recovery-mode.test.ts`. What this asserts is the complement, on a
    // healthy run: publishing a newer version changes nothing about a run in flight, and Resume in
    // particular loads the run's own pin rather than discovering the new one.
    const running = await harness.runOf(launched.id);
    assert.equal(running.artifactHash, pinA);

    const pinB = publishFixture(harness, 'B');
    assert.notEqual(pinA, pinB);
    harness.setCurrent('reviewed-document', 'B');

    // Pause and Resume never adopt code: Resume loads the run's own pin, which is still A.
    assert.equal((await run(harness.controls.pause(launched.id))).accepted, true);
    assert.equal((await run(harness.controls.resume(launched.id))).accepted, true);
    assert.equal(
      (await harness.runOf(launched.id)).artifactHash,
      pinA,
      'Resume never discovers new code',
    );

    const finished = await drivePipeline(harness, launched.id, (round) =>
      round === 1 ? 'ready' : 'approve this draft',
    );
    const adoptions = await run(harness.fixture.runs.listVersionAdoptions(launched.id));
    assert.deepEqual(
      adoptions.map((adoption) => [adoption.reason, adoption.artifactHash]),
      [['launch', pinA]],
      'only the launch adopted a version; nothing adopted one behind the run’s back',
    );
    const attempts = (
      await Promise.all(
        (
          await run(harness.fixture.runs.listFrames(launched.id))
        ).map((frame) => run(harness.fixture.runs.listAttemptsForFrame(frame.id))),
      )
    ).flat();
    assert.ok(
      attempts.every((attempt) => attempt.artifactHash === pinA),
      'every attempt records the pin it actually ran under',
    );
    assert.ok(finished.status === 'done' || finished.status === 'waiting');
  });
});

test('a mid-run version change repairs the last segment without repeating anything committed', async () => {
  await withHarness(async (harness) => {
    // Pin A carries a real authoring bug in the *last* segment: the delivered outcome reads a nested
    // summary this workflow never produces. Everything before it — the writer's turns, the nested
    // reviews, the person's answer — has already committed by the time it runs.
    const pinA = harness.publish({
      workflowKey: 'reviewed-document',
      version: 'A',
      definition: makeReviewedDocumentWorkflow({
        deliveredReadsMissingSummary: true,
      }) as unknown as AnyWorkflowDefinition,
    });
    const launched = await harness.launch({
      workflowKey: 'reviewed-document',
      inputs: { topic: 'repair' },
    });

    const world = new World(harness);
    // The first writer turn fails, which is the fixture's non-linear return to the writer.
    await harness.drain();
    await world.failNextTurn(launched.id);
    await harness.drain();

    // Then the ordinary pipeline: ready for review, and reviews that never approve, so the document
    // escalates to the person.
    const escalated = await drivePipeline(harness, launched.id, (round) =>
      round === 1 ? 'ready' : 'revise',
    );
    assert.equal(escalated.status, 'waiting');
    const gate = (await run(harness.fixture.runs.listArmedWaits(launched.id)))[0]!;
    await run(
      harness.controls.advance({
        runId: launched.id,
        waitId: gate.id,
        answers: { decision: 'deliver' },
      }),
    );
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'output_evaluation_failed');
    assert.equal(failed.artifactHash, pinA);

    // Everything committed under A, recorded before the repair.
    const framesBefore = await run(harness.fixture.runs.listFrames(launched.id));
    const documentFrame = framesBefore.find((frame) => frame.graphKey === 'reviewed-document')!;
    const reviewFramesBefore = framesBefore.filter((frame) => frame.graphKey === 'review');
    assert.ok(reviewFramesBefore.length >= 2, 'the run did perform multiple review rounds');
    const writerVisitsBefore = (
      await run(harness.fixture.runs.listExecutions(documentFrame.id))
    ).filter((execution) => execution.nodeId === 'askWriter');
    assert.equal(writerVisitsBefore.length, 2, 'including the non-linear return to the writer');
    const executionsBefore = await Promise.all(
      framesBefore.map((frame) => run(harness.fixture.runs.listExecutions(frame.id))),
    );
    const attemptsBefore = (
      await Promise.all(
        framesBefore.map((frame) => run(harness.fixture.runs.listAttemptsForFrame(frame.id))),
      )
    ).flat();
    assert.ok(
      attemptsBefore.every((attempt) => attempt.artifactHash === pinA),
      'every attempt so far ran under A',
    );
    const counters = { ...harness.adapters.counters };
    const consumedGate = (await run(harness.fixture.runs.findWait(gate.id)))!;
    assert.equal(consumedGate.status, 'consumed');

    // Pin B is the same workflow with the bug fixed, adopted through the real Retry path.
    const pinB = harness.publish({
      workflowKey: 'reviewed-document',
      version: 'B',
      definition: makeReviewedDocumentWorkflow() as unknown as AnyWorkflowDefinition,
    });
    assert.notEqual(pinA, pinB);
    harness.setCurrent('reviewed-document', 'B');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.equal(finished.outcomeId, 'delivered');
    assert.equal(finished.artifactHash, pinB);

    // Nothing committed was repeated: no new frames, no new executions, no further agent work, and
    // the person was not asked again.
    const framesAfter = await run(harness.fixture.runs.listFrames(launched.id));
    assert.deepEqual(
      framesAfter.map((frame) => frame.id),
      framesBefore.map((frame) => frame.id),
      'no frame was opened a second time',
    );
    // Every frame that had already published stays exactly as it was, pin included. The root frame
    // is excluded because completing it is the repair.
    const completedBefore = framesBefore.filter((frame) => frame.status === 'completed');
    assert.ok(completedBefore.length >= 3, 'the document and its review frames had all completed');
    assert.deepEqual(
      framesAfter
        .filter((frame) => completedBefore.some((earlier) => earlier.id === frame.id))
        .map((frame) => [frame.id, frame.outcomeId, frame.outputArtifactHash, frame.completedAt]),
      completedBefore.map((frame) => [
        frame.id,
        frame.outcomeId,
        frame.outputArtifactHash,
        frame.completedAt,
      ]),
      'completed child output keeps the pin that produced it',
    );
    assert.ok(
      completedBefore.every((frame) => frame.outputArtifactHash === pinA),
      'and that pin is A',
    );
    assert.deepEqual(
      await Promise.all(
        framesBefore.map((frame) => run(harness.fixture.runs.listExecutions(frame.id))),
      ),
      executionsBefore,
      'committed init and every node visit are untouched',
    );
    assert.deepEqual(harness.adapters.counters, counters, 'no agent or process work was redone');
    assert.deepEqual(
      await run(harness.fixture.runs.listWaitsForExecution(consumedGate.executionId)),
      [consumedGate],
      'the answered human gate was not re-armed',
    );

    // Only the failed segment was retried, and only that attempt ran under B.
    const attemptsAfter = (
      await Promise.all(
        framesAfter.map((frame) => run(harness.fixture.runs.listAttemptsForFrame(frame.id))),
      )
    ).flat();
    const underB = attemptsAfter.filter((attempt) => attempt.artifactHash === pinB);
    assert.deepEqual(
      underB.map((attempt) => [attempt.segmentKind, attempt.attemptIndex, attempt.invocationKind]),
      [['graph_output', 2, 'retry']],
      'exactly one new attempt, at the segment that failed',
    );
    assert.deepEqual(
      attemptsAfter.filter((attempt) => attempt.artifactHash === pinA).map((attempt) => attempt.id),
      attemptsBefore.map((attempt) => attempt.id),
      'and every earlier attempt still records A',
    );

    // Saved operands keep the pin that produced them. Every attempt that existed before the repair
    // still records A, unchanged — including the ones whose operands were reused.
    const byId = new Map(attemptsAfter.map((attempt) => [attempt.id, attempt]));
    for (const earlier of attemptsBefore) {
      assert.equal(
        byId.get(earlier.id)?.producerArtifactHash,
        earlier.producerArtifactHash,
        `attempt ${earlier.id} (${earlier.segmentKind}) kept its producing pin`,
      );
    }
    assert.ok(
      attemptsBefore
        .filter((attempt) => attempt.producerArtifactHash !== null)
        .every((attempt) => attempt.producerArtifactHash === pinA),
    );
    // The repair's own attempt records B as its producer, because the evaluator that threw under A
    // captured nothing — so B genuinely produced this value rather than reusing one.
    assert.equal(underB[0]!.producerArtifactHash, pinB);

    const adoptions = await run(harness.fixture.runs.listVersionAdoptions(launched.id));
    assert.deepEqual(
      adoptions.map((adoption) => [adoption.reason, adoption.artifactHash]),
      [
        ['launch', pinA],
        ['retry', pinB],
      ],
    );
  });
});
