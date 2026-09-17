import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { WorkflowPlacementRequestDto } from '@isagi/contracts';

import type { WorkflowWriteResult } from './outcomes.js';
import type { WorkflowAttemptRecord, WorkflowRunRecord } from './records.js';
import {
  createPlacedRun,
  makeWorkflowPersistenceFixture,
  prepareClaim,
  run,
  type WorkflowPersistenceFixture,
} from './test-support.js';

const PIN_A = 'a'.repeat(64);
const PIN_B = 'b'.repeat(64);
const OWNER = 'worker-1';
const INCARNATION = 'incarnation-1';

function committedValue<A>(result: WorkflowWriteResult<A>): A {
  assert.equal(result.ok, true, `expected a commit, got ${JSON.stringify(result)}`);
  assert.ok(result.ok);
  return result.value;
}

function rejection<A>(result: WorkflowWriteResult<A>) {
  assert.equal(result.ok, false, `expected a rejection, got ${JSON.stringify(result)}`);
  assert.ok(!result.ok);
  return result.rejection;
}

/** A launched run with a real pin and a live destination, parked at its root graph entry. */
async function launch(fixture: WorkflowPersistenceFixture) {
  fixture.seedArtifact(PIN_A);
  fixture.seedArtifact(PIN_B);
  const placement = fixture.seedPlacement();
  const created = await createPlacedRun(fixture, {
    workflowKey: 'fixture',
    title: 'Fixture run',
    rootGraphKey: 'root',
    artifactHash: PIN_A,
    rootFrame: { graphKey: 'root', parameters: { value: { note: 'hello' } } },
    placement,
  });
  return { ...created, placement };
}

async function claim(fixture: WorkflowPersistenceFixture, runRecord: WorkflowRunRecord) {
  return committedValue(
    await run(
      fixture.runs.claimSegment({
        ...(await prepareClaim(fixture, runRecord.id)),
        owner: OWNER,
        ownerIncarnation: INCARNATION,
      }),
    ),
  );
}

function fenceOf(runRecord: WorkflowRunRecord, attempt: WorkflowAttemptRecord) {
  return {
    runId: runRecord.id,
    attemptId: attempt.id,
    owner: OWNER,
    ownerIncarnation: INCARNATION,
  };
}

/** Enters the root graph, leaving the run parked on its entry node's callback. */
async function enterRootGraph(fixture: WorkflowPersistenceFixture) {
  const launched = await launch(fixture);
  const claimed = await claim(fixture, launched.run);
  await run(
    fixture.runs.commitGraphEntry({
      ...fenceOf(launched.run, claimed.attempt),
      frameId: launched.frame.id,
      state: { value: { count: 0 } },
      entryNode: { nodeId: 'work', nodeKind: 'operation' },
    }),
  );
  const current = (await run(fixture.runs.findRun(launched.run.id)))!;
  return { launched, run: current };
}

test('a claim and its attempt are one transaction, and nothing else creates an attempt', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const launched = await launch(fixture);
    const claimed = await claim(fixture, launched.run);

    assert.equal(claimed.attempt.attemptIndex, 1);
    assert.equal(claimed.attempt.segmentKind, 'graph_entry');
    assert.equal(
      claimed.attempt.executionId,
      null,
      'a graph entry belongs to the frame, not a node',
    );
    assert.equal(claimed.run.activeAttemptId, claimed.attempt.id);
    assert.equal(claimed.run.status, 'running');

    // A second claim finds the run no longer `ready` and loses, leaving exactly one attempt. That
    // is the single-winner guarantee, and it holds because the guard and the allocation share a
    // transaction rather than because a caller checks first.
    const second = await run(
      fixture.runs.claimSegment({
        ...(await prepareClaim(fixture, launched.run.id)),
        owner: 'worker-2',
        ownerIncarnation: 'incarnation-2',
      }),
    );
    assert.deepEqual(rejection(second), { kind: 'not_claimable', reason: 'status' });
    const attempts = fixture.client
      .prepare('SELECT count(*) AS count FROM workflow_segment_attempts')
      .get() as { count: number };
    // Two: the preparation attempt the launch claimed and closed, and this graph entry. The losing
    // claim added none, which is the guarantee under test.
    assert.equal(attempts.count, 2);
  } finally {
    fixture.close();
  }
});

test('a claim prepared against a stale control revision is rejected', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const launched = await launch(fixture);
    // Prepared first, against the revision the caller actually read.
    const prepared = await prepareClaim(fixture, launched.run.id);
    // A Pause lands between preparing the claim and committing it.
    await run(
      fixture.runs.applyPause({
        runId: launched.run.id,
        controlRevision: launched.run.controlRevision,
      }),
    );
    const result = await run(
      fixture.runs.claimSegment({ ...prepared, owner: OWNER, ownerIncarnation: INCARNATION }),
    );
    assert.equal(rejection(result).kind, 'control_revision_changed');
    assert.equal(
      (
        fixture.client.prepare('SELECT count(*) AS count FROM workflow_segment_attempts').get() as {
          count: number;
        }
      ).count,
      1,
      'a rejected claim allocates no attempt beyond the placement it inherited',
    );
  } finally {
    fixture.close();
  }
});

test('invocation kind is derived, and an adopted Retry survives a restart', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const first = await claim(fixture, entered.run);
    assert.equal(first.attempt.invocationKind, 'initial');

    await run(
      fixture.runs.failSegment({
        ...fenceOf(entered.run, first.attempt),
        code: 'node_callback_failed',
        message: 'boom',
      }),
    );

    // Re-attempting the same segment without an adopted Retry is a resume.
    const failed = (await run(fixture.runs.findRun(entered.run.id)))!;
    await run(
      fixture.runs.applyPause({ runId: failed.id, controlRevision: failed.controlRevision }),
    );
    const paused = (await run(fixture.runs.findRun(entered.run.id)))!;
    await run(
      fixture.runs.applyResume({
        runId: paused.id,
        controlRevision: paused.controlRevision,
        expectedPosition: paused.position,
      }),
    );

    const resumable = (await run(fixture.runs.findRun(entered.run.id)))!;
    const adopted = await run(
      fixture.runs.adoptRetryPin({
        runId: resumable.id,
        controlRevision: resumable.controlRevision,
        artifactHash: PIN_B,
        expectedPosition: resumable.position,
        expectedOwner: resumable.owner,
      }),
    );
    committedValue(adopted);

    const repinned = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(repinned.artifactHash, PIN_B);
    assert.equal(repinned.status, 'ready');
    assert.equal(repinned.failureCode, null);
    assert.equal(repinned.pendingInvocationKind, 'retry');
    assert.equal(
      (
        fixture.client.prepare('SELECT count(*) AS count FROM workflow_segment_attempts').get() as {
          count: number;
        }
      ).count,
      3,
      'adoption itself creates no attempt',
    );

    // The crash case: nothing dispatched between adoption and now. The next claim must still stamp
    // `retry`, not downgrade it to `resumed` because the segment happens to have a prior attempt.
    const next = await claim(fixture, repinned);
    assert.equal(next.attempt.invocationKind, 'retry');
    assert.equal(next.attempt.attemptIndex, 2);
    assert.equal(next.attempt.artifactHash, PIN_B);
    const consumed = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(consumed.pendingInvocationKind, null);
  } finally {
    fixture.close();
  }
});

test('a producer operand survives repeated attempts and keeps its own pin', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const first = await claim(fixture, entered.run);

    // Captured before reduction is attempted — which is the whole point, because reduction is what
    // fails next.
    committedValue(
      await run(
        fixture.runs.captureProducerOutput({
          ...fenceOf(entered.run, first.attempt),
          producerOutput: { value: { update: { count: 1 } } },
          producerArtifactHash: PIN_A,
        }),
      ),
    );
    await run(
      fixture.runs.failSegment({
        ...fenceOf(entered.run, first.attempt),
        code: 'reduction_failed',
        message: 'reducer threw',
      }),
    );

    const segment = {
      frameId: entered.launched.frame.id,
      executionId:
        entered.run.position.kind === 'node_callback' ? entered.run.position.executionId : null,
      segmentKind: 'node_callback' as const,
      segmentRef: null,
    };
    const saved = await run(fixture.runs.findProducerOutput(segment));
    assert.ok(saved, 'the operand is recoverable by segment identity, not by failure code');
    assert.equal(saved.producerArtifactHash, PIN_A);
    assert.deepEqual(await run(fixture.payloads.resolve(saved.slot)), { update: { count: 1 } });

    // Retry under a different pin. The operand is still the one pin A produced.
    const failed = (await run(fixture.runs.findRun(entered.run.id)))!;
    committedValue(
      await run(
        fixture.runs.adoptRetryPin({
          runId: failed.id,
          controlRevision: failed.controlRevision,
          artifactHash: PIN_B,
          expectedPosition: failed.position,
          expectedOwner: failed.owner,
        }),
      ),
    );
    const repinned = (await run(fixture.runs.findRun(entered.run.id)))!;
    const second = await claim(fixture, repinned);
    assert.equal(second.attempt.artifactHash, PIN_B, 'the attempt records its own pin');

    const stillSaved = await run(fixture.runs.findProducerOutput(segment));
    assert.equal(
      stillSaved?.producerArtifactHash,
      PIN_A,
      'the operand keeps the pin that produced it, not the pin retrying it',
    );

    // A third failure and a third retry change nothing: a producer output is never invalidated,
    // because only a successful commit ends a segment.
    await run(
      fixture.runs.failSegment({
        ...fenceOf(repinned, second.attempt),
        code: 'unknown_state_field',
        message: 'field removed by the new pin',
      }),
    );
    const third = await run(fixture.runs.findProducerOutput(segment));
    assert.equal(third?.producerArtifactHash, PIN_A);
  } finally {
    fixture.close();
  }
});

test('the ownership fence, not the control revision, decides whether an outcome is recorded', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = await claim(fixture, entered.run);

    // A Pause lands mid-callback. It bumps the control revision and gates the *next* claim; it must
    // not be able to drop the outcome of work already in flight.
    const running = (await run(fixture.runs.findRun(entered.run.id)))!;
    committedValue(
      await run(
        fixture.runs.applyPause({ runId: running.id, controlRevision: running.controlRevision }),
      ),
    );

    const committed = await run(
      fixture.runs.commitNodeResult({
        ...fenceOf(entered.run, claimed.attempt),
        frameId: entered.launched.frame.id,
        executionId: claimed.attempt.executionId!,
        state: { value: { count: 1 } },
        producerOutput: { value: { update: { count: 1 } } },
        producerArtifactHash: PIN_A,
        next: { kind: 'routing', edgeId: 'work-out' },
      }),
    );
    assert.equal(committedValue(committed), 'advanced');

    const after = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(after.position.kind, 'routing');
    assert.equal(after.status, 'ready', 'readiness is unconditional; the pause gates the claim');
    assert.equal(after.paused, true);

    // And the gate does hold.
    assert.deepEqual(
      rejection(
        await run(
          fixture.runs.claimSegment({
            ...(await prepareClaim(fixture, after.id)),
            owner: OWNER,
            ownerIncarnation: INCARNATION,
          }),
        ),
      ),
      { kind: 'not_claimable', reason: 'paused' },
    );
  } finally {
    fixture.close();
  }
});

test('cancelling a paused run lowers the gate with the band that explained it', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);

    const running = (await run(fixture.runs.findRun(entered.run.id)))!;
    committedValue(
      await run(
        fixture.runs.applyPause({ runId: running.id, controlRevision: running.controlRevision }),
      ),
    );
    const paused = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(paused.paused, true);

    committedValue(
      await run(
        fixture.runs.applyCancel({ runId: paused.id, controlRevision: paused.controlRevision }),
      ),
    );

    const cancelled = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(cancelled.status, 'cancelled');
    // `paused` is the dispatch gate, not a memory of one. Leaving it raised on a terminal run left
    // the flag and the closed band disagreeing, and every reader downstream inherited the
    // disagreement — the bar called a cancelled run "Paused".
    assert.equal(cancelled.paused, false);
    assert.notEqual(cancelled.endedAt, null);
  } finally {
    fixture.close();
  }
});

test('a commit under Cancel records evidence and applies no graph transition', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = await claim(fixture, entered.run);
    const positionBefore = (await run(fixture.runs.findRun(entered.run.id)))!.position;

    const running = (await run(fixture.runs.findRun(entered.run.id)))!;
    committedValue(
      await run(
        fixture.runs.applyCancel({ runId: running.id, controlRevision: running.controlRevision }),
      ),
    );

    const result = await run(
      fixture.runs.commitNodeResult({
        ...fenceOf(entered.run, claimed.attempt),
        frameId: entered.launched.frame.id,
        executionId: claimed.attempt.executionId!,
        state: { value: { count: 99 } },
        producerOutput: { value: { update: { count: 99 } } },
        producerArtifactHash: PIN_A,
        next: { kind: 'routing', edgeId: 'work-out' },
      }),
    );
    assert.equal(committedValue(result), 'cancelled_evidence');

    const after = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(after.status, 'cancelled');
    assert.deepEqual(after.position, positionBefore, 'no graph transition was applied');

    const attempt = (await run(fixture.runs.findAttempt(claimed.attempt.id)))!;
    assert.equal(attempt.status, 'cancelled');
    assert.ok(
      attempt.producerOutput,
      'the candidate result is retained as cancelled-attempt evidence',
    );
    assert.deepEqual(await run(fixture.payloads.resolve(attempt.producerOutput)), {
      update: { count: 99 },
    });

    const frame = (await run(fixture.runs.findFrame(entered.launched.frame.id)))!;
    assert.deepEqual(
      await run(fixture.payloads.resolve(frame.state!)),
      { count: 0 },
      'frame state is the boundary that last committed, not the cancelled candidate',
    );

    // A diagnostic written after Cancel is still recorded: it is fenced only on the run existing.
    committedValue(
      await run(
        fixture.runs.appendDiagnostic({
          runId: after.id,
          kind: 'log',
          detail: { value: { source: 'author_log', level: 'info', message: 'after cancel' } },
        }),
      ),
    );
  } finally {
    fixture.close();
  }
});

test('an unowned or superseded attempt cannot record anything', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = await claim(fixture, entered.run);

    for (const fence of [
      { ...fenceOf(entered.run, claimed.attempt), owner: 'someone-else' },
      { ...fenceOf(entered.run, claimed.attempt), ownerIncarnation: 'a-previous-runtime' },
      { ...fenceOf(entered.run, claimed.attempt), attemptId: claimed.attempt.id + 1000 },
    ]) {
      const result = await run(
        fixture.runs.commitNodeResult({
          ...fence,
          frameId: entered.launched.frame.id,
          executionId: claimed.attempt.executionId!,
          state: { value: { count: 1 } },
          producerOutput: { value: { update: { count: 1 } } },
          producerArtifactHash: PIN_A,
          next: { kind: 'routing', edgeId: 'work-out' },
        }),
      );
      assert.deepEqual(rejection(result), { kind: 'attempt_not_owned' });
    }
  } finally {
    fixture.close();
  }
});

test('every transition takes a distinct contiguous revision, including several in one transaction', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = await claim(fixture, entered.run);
    // Suspending writes two transitions in one transaction: the reduction and the wait it armed.
    const result = await run(
      fixture.runs.commitNodeResult({
        ...fenceOf(entered.run, claimed.attempt),
        frameId: entered.launched.frame.id,
        executionId: claimed.attempt.executionId!,
        state: { value: { count: 1 } },
        producerOutput: { value: { update: { count: 1 } } },
        producerArtifactHash: PIN_A,
        next: {
          kind: 'suspend',
          waitKind: 'user_continue',
          condition: { value: { kind: 'user_continue' } },
        },
      }),
    );
    assert.ok(result.ok);
    assert.deepEqual(
      result.transitions.map((transition) => transition.kind),
      ['state_reduced', 'wait_armed'],
    );
    assert.equal(result.transitions[1]!.revision, result.transitions[0]!.revision + 1);

    const revisions = (
      fixture.client
        .prepare('SELECT revision FROM workflow_transitions WHERE run_id = ? ORDER BY revision')
        .all(entered.run.id) as { revision: number }[]
    ).map((row) => row.revision);
    // Contiguous from 1, with no gaps and no reuse: a client applies a delta only when its revision
    // is exactly one past the last it applied, so either fault desynchronizes it silently.
    assert.deepEqual(
      revisions,
      revisions.map((_, index) => index + 1),
    );

    const runAfter = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(runAfter.revision, revisions.at(-1));
    assert.equal(runAfter.status, 'waiting');
    assert.equal(runAfter.position.kind, 'awaiting_wait');
  } finally {
    fixture.close();
  }
});

test('wait delivery is idempotent and never revives a terminal run', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = await claim(fixture, entered.run);
    await run(
      fixture.runs.commitNodeResult({
        ...fenceOf(entered.run, claimed.attempt),
        frameId: entered.launched.frame.id,
        executionId: claimed.attempt.executionId!,
        state: { value: { count: 1 } },
        producerOutput: { value: { update: { count: 1 } } },
        producerArtifactHash: PIN_A,
        next: {
          kind: 'suspend',
          waitKind: 'user_continue',
          condition: { value: { kind: 'user_continue' } },
        },
      }),
    );
    const waiting = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.ok(waiting.position.kind === 'awaiting_wait');
    const waitId = waiting.position.waitId;

    const delivered = committedValue(
      await run(
        fixture.runs.deliverWait({
          waitId,
          edgeId: 'work-out',
          event: { value: { kind: 'user_continue' } },
        }),
      ),
    );
    assert.equal(delivered.outcome, 'advanced');
    const advanced = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(advanced.status, 'ready');
    assert.equal(advanced.position.kind, 'routing');

    // A duplicate delivery is a no-op, not a conflict: the same evidence can reach this from the
    // dispatcher, the resolver and startup recovery.
    assert.equal(
      rejection(
        await run(
          fixture.runs.deliverWait({
            waitId,
            edgeId: 'work-out',
            event: { value: { kind: 'user_continue' } },
          }),
        ),
      ).kind,
      'wait_already_resolved',
    );
  } finally {
    fixture.close();
  }
});

test('a wait resolving on a cancelled run is recorded as late evidence only', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = await claim(fixture, entered.run);
    await run(
      fixture.runs.commitNodeResult({
        ...fenceOf(entered.run, claimed.attempt),
        frameId: entered.launched.frame.id,
        executionId: claimed.attempt.executionId!,
        state: { value: { count: 1 } },
        producerOutput: { value: { update: { count: 1 } } },
        producerArtifactHash: PIN_A,
        next: {
          kind: 'suspend',
          waitKind: 'user_continue',
          condition: { value: { kind: 'user_continue' } },
        },
      }),
    );
    const waiting = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.ok(waiting.position.kind === 'awaiting_wait');
    const waitId = waiting.position.waitId;
    const positionBefore = waiting.position;

    committedValue(
      await run(
        fixture.runs.applyCancel({ runId: waiting.id, controlRevision: waiting.controlRevision }),
      ),
    );

    const delivered = committedValue(
      await run(
        fixture.runs.deliverWait({
          waitId,
          edgeId: 'work-out',
          event: { value: { kind: 'user_continue' } },
        }),
      ),
    );
    assert.equal(delivered.outcome, 'late_evidence');
    assert.equal(delivered.wait.status, 'delivered', 'the event is retained, not discarded');

    const after = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(after.status, 'cancelled', 'a terminal run cannot regain readiness');
    assert.deepEqual(after.position, positionBefore);
  } finally {
    fixture.close();
  }
});

test('pause intervals are idempotent and never left open past a terminal transition', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);

    let current = (await run(fixture.runs.findRun(entered.run.id)))!;
    committedValue(
      await run(
        fixture.runs.applyPause({ runId: current.id, controlRevision: current.controlRevision }),
      ),
    );
    current = (await run(fixture.runs.findRun(entered.run.id)))!;
    // A second Pause, and a restart park on top of it, must not open a second band.
    committedValue(
      await run(
        fixture.runs.applyPause({ runId: current.id, controlRevision: current.controlRevision }),
      ),
    );
    await run(fixture.runs.parkUnfinishedRuns({}));
    await run(
      fixture.runs.applyEnvironmentAvailability({ runIds: [entered.run.id], available: false }),
    );

    let intervals = await run(fixture.runs.listPauseIntervals(entered.run.id));
    assert.equal(intervals.length, 1, 'repeated parking converges on one band');
    assert.equal(intervals[0]!.resumedAt, null);

    current = (await run(fixture.runs.findRun(entered.run.id)))!;
    // Environment parking cleared the availability flag; restore it so the run can be claimed.
    await run(fixture.runs.applyEnvironmentAvailability({ runIds: [current.id], available: true }));
    committedValue(
      await run(
        fixture.runs.applyResume({
          runId: current.id,
          controlRevision: current.controlRevision,
          expectedPosition: current.position,
        }),
      ),
    );
    intervals = await run(fixture.runs.listPauseIntervals(entered.run.id));
    assert.equal(intervals.length, 1);
    assert.ok(intervals[0]!.resumedAt, 'Resume closes the band it found open');

    // Pause again and then fail: a terminal transition must not leave an indefinitely open band.
    current = (await run(fixture.runs.findRun(entered.run.id)))!;
    committedValue(
      await run(
        fixture.runs.applyPause({ runId: current.id, controlRevision: current.controlRevision }),
      ),
    );
    current = (await run(fixture.runs.findRun(entered.run.id)))!;
    const claimed = await run(
      fixture.runs.claimSegment({
        ...(await prepareClaim(fixture, current.id)),
        owner: OWNER,
        ownerIncarnation: INCARNATION,
      }),
    );
    assert.deepEqual(rejection(claimed), { kind: 'not_claimable', reason: 'paused' });

    // Drive the failure through the attempt the earlier park left behind instead.
    await run(
      fixture.runs.applyResume({
        runId: current.id,
        controlRevision: current.controlRevision,
        expectedPosition: current.position,
      }),
    );
    current = (await run(fixture.runs.findRun(entered.run.id)))!;
    const working = await claim(fixture, current);
    current = (await run(fixture.runs.findRun(entered.run.id)))!;
    committedValue(
      await run(
        fixture.runs.applyPause({ runId: current.id, controlRevision: current.controlRevision }),
      ),
    );
    await run(
      fixture.runs.failSegment({
        ...fenceOf(current, working.attempt),
        code: 'node_callback_failed',
        message: 'boom',
      }),
    );
    const closed = await run(fixture.runs.listPauseIntervals(entered.run.id));
    assert.ok(
      closed.every((interval) => interval.resumedAt !== null),
      'no band stays open across a terminal run',
    );
  } finally {
    fixture.close();
  }
});

test('a restart interrupts the running attempt rather than inventing an end for it', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = await claim(fixture, entered.run);

    const parked = await run(fixture.runs.parkUnfinishedRuns({}));
    assert.deepEqual(parked, { parked: [entered.run.id], preparationsFailed: [] });

    const after = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(after.status, 'ready');
    assert.equal(after.paused, true);
    assert.equal(after.owner, null);
    assert.equal(after.activeAttemptId, null);

    const attempt = (await run(fixture.runs.findAttempt(claimed.attempt.id)))!;
    assert.equal(attempt.status, 'interrupted');
    assert.equal(attempt.endCertainty, 'unknown');
    assert.equal(attempt.endedAt, null, 'an unobserved end is not a timestamp');

    const execution = (await run(fixture.runs.findExecution(claimed.attempt.executionId!)))!;
    assert.equal(execution.endCertainty, 'unknown');
  } finally {
    fixture.close();
  }
});

test('one surface holds one attached run, including a terminal one until it is dismissed', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const launched = await launch(fixture);
    // Creating a second run is always allowed — nothing is occupied until a destination is
    // committed. Occupancy is refused at the one write that makes a destination effective.
    const second = committedValue(
      await run(
        fixture.runs.createRun({
          workflowKey: 'fixture',
          title: 'Second',
          rootGraphKey: 'root',
          artifactHash: PIN_A,
          rootFrame: { graphKey: 'root' },
          origin: {
            worktreeId: launched.placement.worktreeId,
            worktreePath: '/repo/fixture',
            surfaceId: launched.placement.surfaceId,
            paneId: null,
            agentSessionId: null,
          },
          preparation: {
            source: 'default',
            request: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
            baseCommit: null,
            checkoutPath: null,
          },
          claim: { owner: OWNER, ownerIncarnation: INCARNATION, input: { value: {} } },
        }),
      ),
    );
    const refused = await run(
      fixture.runs.commitEnvironmentPreparation({
        runId: second.run.id,
        attemptId: second.attempt.id,
        owner: OWNER,
        ownerIncarnation: INCARNATION,
        destination: {
          worktreeId: launched.placement.worktreeId,
          worktreePath: '/repo/fixture',
          surfaceId: launched.placement.surfaceId,
        },
      }),
    );
    assert.deepEqual(rejection(refused), { kind: 'surface_busy', runId: launched.run.id });
    // A refused commit writes nothing at all: no destination, no attachment, no second occupant.
    const stillUnplaced = (await run(fixture.runs.findRun(second.run.id)))!;
    assert.equal(stillUnplaced.destination.surfaceId, null);
    assert.equal(await run(fixture.runs.findAttachment(second.run.id)), null);

    // Cancel makes it terminal, and it still occupies the surface.
    const current = (await run(fixture.runs.findRun(launched.run.id)))!;
    committedValue(
      await run(
        fixture.runs.applyCancel({ runId: current.id, controlRevision: current.controlRevision }),
      ),
    );
    const afterCancel = (await run(fixture.runs.findRun(launched.run.id)))!;
    assert.ok(await run(fixture.runs.findAttachment(afterCancel.id)));

    committedValue(
      await run(
        fixture.runs.detachRun({
          runId: afterCancel.id,
          controlRevision: afterCancel.controlRevision,
        }),
      ),
    );
    assert.equal(await run(fixture.runs.findAttachment(afterCancel.id)), null);
    // Dismiss releases the surface; it never touches the run's records.
    assert.ok(await run(fixture.runs.findRun(afterCancel.id)));
    assert.ok((await run(fixture.runs.listFrames(afterCancel.id))).length > 0);
  } finally {
    fixture.close();
  }
});

test('deleting the worktree removes only the attachment, never the history', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const before = {
      frames: (await run(fixture.runs.listFrames(entered.run.id))).length,
      transitions: fixture.client
        .prepare('SELECT count(*) AS count FROM workflow_transitions WHERE run_id = ?')
        .get(entered.run.id) as { count: number },
    };

    fixture.client
      .prepare('DELETE FROM worktrees WHERE id = ?')
      .run(entered.launched.placement.worktreeId);

    assert.equal(await run(fixture.runs.findAttachment(entered.run.id)), null);
    const retained = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.ok(retained, 'the run outlives the environment it ran in');
    // Retained provenance has no foreign key, which is also how environment deletion finds the run
    // afterwards — the attachment is already gone by then.
    assert.equal(retained.destination.worktreeId, entered.launched.placement.worktreeId);
    assert.equal((await run(fixture.runs.listFrames(entered.run.id))).length, before.frames);
    assert.deepEqual(
      fixture.client
        .prepare('SELECT count(*) AS count FROM workflow_transitions WHERE run_id = ?')
        .get(entered.run.id),
      before.transitions,
    );
    assert.deepEqual(fixture.client.pragma('foreign_key_check'), []);
  } finally {
    fixture.close();
  }
});

test('a claim is refused when the destination is gone, even if the cached flag says otherwise', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const launched = await launch(fixture);
    // The notification never arrived, so the cache still claims the environment is available.
    fixture.client
      .prepare('DELETE FROM worktree_surfaces WHERE id = ?')
      .run(launched.placement.surfaceId);
    const current = (await run(fixture.runs.findRun(launched.run.id)))!;
    assert.equal(current.environmentAvailable, true);

    const result = await run(
      fixture.runs.claimSegment({
        ...(await prepareClaim(fixture, current.id)),
        owner: OWNER,
        ownerIncarnation: INCARNATION,
      }),
    );
    assert.deepEqual(rejection(result), { kind: 'not_claimable', reason: 'placement_missing' });
  } finally {
    fixture.close();
  }
});

test('a saved position that cannot be decoded fails loudly instead of defaulting', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const launched = await launch(fixture);
    // A `routing` position naming no edge is exactly the shape the union exists to forbid.
    fixture.client
      .prepare('UPDATE workflow_runs SET position_json = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'routing', frameId: 1, executionId: 1 }), launched.run.id);

    await assert.rejects(
      () => run(fixture.runs.findRun(launched.run.id)),
      /unreadable saved position/,
    );
  } finally {
    fixture.close();
  }
});

test('the database refuses a row that is both inline and referenced', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    // Written directly, bypassing the repository — which is precisely the writer the constraint is
    // there to stop, because no reader could resolve such a row.
    assert.throws(
      () =>
        fixture.client
          .prepare('UPDATE workflow_graph_frames SET state_inline = ?, state_ref = ? WHERE id = ?')
          .run('{}', `sha256:${'0'.repeat(64)}`, entered.launched.frame.id),
      /CHECK constraint failed/,
    );
    // Both null remains legal: that is how an unproduced slot is encoded.
    assert.doesNotThrow(() =>
      fixture.client
        .prepare(
          'UPDATE workflow_graph_frames SET state_inline = NULL, state_ref = NULL WHERE id = ?',
        )
        .run(entered.launched.frame.id),
    );
  } finally {
    fixture.close();
  }
});

test('an unproduced slot and a recorded JSON null stay distinguishable', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const launched = await launch(fixture);
    const withoutParameters = committedValue(
      await run(
        fixture.runs.createRun({
          workflowKey: 'fixture',
          title: 'No parameters',
          rootGraphKey: 'root',
          artifactHash: PIN_A,
          rootFrame: { graphKey: 'root' },
          origin: {
            worktreeId: null,
            worktreePath: null,
            surfaceId: null,
            paneId: null,
            agentSessionId: null,
          },
          preparation: {
            source: 'default',
            request: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
            baseCommit: null,
            checkoutPath: null,
          },
          claim: { owner: OWNER, ownerIncarnation: INCARNATION, input: { value: {} } },
        }),
      ),
    );
    assert.equal(withoutParameters.frame.parameters, null, 'never produced');

    const withNull = committedValue(
      await run(
        fixture.runs.createRun({
          workflowKey: 'fixture',
          title: 'Null parameters',
          rootGraphKey: 'root',
          artifactHash: PIN_A,
          rootFrame: { graphKey: 'root', parameters: { value: null } },
          origin: {
            worktreeId: null,
            worktreePath: null,
            surfaceId: null,
            paneId: null,
            agentSessionId: null,
          },
          preparation: {
            source: 'default',
            request: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
            baseCommit: null,
            checkoutPath: null,
          },
          claim: { owner: OWNER, ownerIncarnation: INCARNATION, input: { value: {} } },
        }),
      ),
    );
    assert.deepEqual(withNull.frame.parameters, { inline: 'null', ref: null }, 'produced null');
    assert.equal(await run(fixture.payloads.resolve(withNull.frame.parameters!)), null);
    assert.ok(launched.run.id > 0);
  } finally {
    fixture.close();
  }
});

test('Resume refuses a destination that no longer exists, and changes nothing', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    let current = (await run(fixture.runs.findRun(entered.run.id)))!;
    committedValue(
      await run(
        fixture.runs.applyPause({ runId: current.id, controlRevision: current.controlRevision }),
      ),
    );
    current = (await run(fixture.runs.findRun(entered.run.id)))!;
    const before = {
      position: current.position,
      pin: current.artifactHash,
      revision: current.revision,
      controlRevision: current.controlRevision,
      intervals: await run(fixture.runs.listPauseIntervals(current.id)),
    };

    // The surface is deleted with no control applied, so nothing about the run itself changed and
    // the control revision alone cannot detect it.
    fixture.client
      .prepare('DELETE FROM worktree_surfaces WHERE id = ?')
      .run(entered.launched.placement.surfaceId);

    const refused = await run(
      fixture.runs.applyResume({
        runId: current.id,
        controlRevision: current.controlRevision,
        expectedPosition: current.position,
      }),
    );
    assert.deepEqual(rejection(refused), {
      kind: 'environment_unavailable',
      worktreeId: entered.launched.placement.worktreeId,
      surfaceId: entered.launched.placement.surfaceId,
    });

    const after = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(after.paused, true, 'a refused Resume does not lift the gate');
    assert.deepEqual(after.position, before.position);
    assert.equal(after.artifactHash, before.pin);
    assert.equal(after.revision, before.revision, 'and writes no history');
    assert.equal(after.controlRevision, before.controlRevision);
    assert.deepEqual(await run(fixture.runs.listPauseIntervals(after.id)), before.intervals);
  } finally {
    fixture.close();
  }
});

test('Resume refuses a position the run has moved past, and changes nothing', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const preparedAgainst = (await run(fixture.runs.findRun(entered.run.id)))!.position;

    // The run advances after the Resume was prepared, without any control being applied — so the
    // control revision is still the one the caller read. Only the position says it moved.
    const claimed = await claim(fixture, entered.run);
    committedValue(
      await run(
        fixture.runs.commitNodeResult({
          ...fenceOf(entered.run, claimed.attempt),
          frameId: entered.launched.frame.id,
          executionId: claimed.attempt.executionId!,
          state: { value: { count: 1 } },
          producerOutput: { value: { update: { count: 1 } } },
          producerArtifactHash: PIN_A,
          next: { kind: 'routing', edgeId: 'work-out' },
        }),
      ),
    );
    let current = (await run(fixture.runs.findRun(entered.run.id)))!;
    committedValue(
      await run(
        fixture.runs.applyPause({ runId: current.id, controlRevision: current.controlRevision }),
      ),
    );
    current = (await run(fixture.runs.findRun(entered.run.id)))!;
    const before = { position: current.position, revision: current.revision };

    const refused = await run(
      fixture.runs.applyResume({
        runId: current.id,
        controlRevision: current.controlRevision,
        expectedPosition: preparedAgainst,
      }),
    );
    assert.deepEqual(rejection(refused), { kind: 'position_mismatch' });

    const after = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(after.paused, true);
    assert.deepEqual(after.position, before.position);
    assert.equal(after.revision, before.revision);
  } finally {
    fixture.close();
  }
});

test('a producer capture is its own revision, and a repeat is inert', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = await claim(fixture, entered.run);
    const before = (await run(fixture.runs.findRun(entered.run.id)))!.revision;

    const first = await run(
      fixture.runs.captureProducerOutput({
        ...fenceOf(entered.run, claimed.attempt),
        producerOutput: { value: { update: { count: 1 } } },
        producerArtifactHash: PIN_A,
      }),
    );
    assert.equal(committedValue(first), true);
    assert.ok(first.ok);
    assert.deepEqual(
      first.transitions.map((transition) => transition.kind),
      ['producer_output_captured'],
    );
    assert.equal(first.transitions[0]!.attemptId, claimed.attempt.id);
    assert.equal(first.transitions[0]!.artifactHash, PIN_A);
    assert.equal((await run(fixture.runs.findRun(entered.run.id)))!.revision, before + 1);

    // A repeat writes nothing: not the operand, not the producing pin, not a second revision. The
    // pin is what any versioned fact derived from the value has to name, so overwriting it is the
    // corruption this guards against.
    const repeat = await run(
      fixture.runs.captureProducerOutput({
        ...fenceOf(entered.run, claimed.attempt),
        producerOutput: { value: { update: { count: 999 } } },
        producerArtifactHash: PIN_B,
      }),
    );
    assert.equal(committedValue(repeat), false);
    assert.ok(repeat.ok);
    assert.deepEqual(repeat.transitions, []);
    assert.equal((await run(fixture.runs.findRun(entered.run.id)))!.revision, before + 1);

    const attempt = (await run(fixture.runs.findAttempt(claimed.attempt.id)))!;
    assert.equal(attempt.producerArtifactHash, PIN_A);
    assert.deepEqual(await run(fixture.payloads.resolve(attempt.producerOutput!)), {
      update: { count: 1 },
    });

    // Capture is not reduction and not completion: the attempt is still running and the run has
    // not moved.
    assert.equal(attempt.status, 'running');
    assert.equal((await run(fixture.runs.findRun(entered.run.id)))!.position.kind, 'node_callback');
  } finally {
    fixture.close();
  }
});

test('only the owning worker and incarnation may capture a producer result', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = await claim(fixture, entered.run);

    for (const fence of [
      { ...fenceOf(entered.run, claimed.attempt), owner: 'another-worker' },
      { ...fenceOf(entered.run, claimed.attempt), ownerIncarnation: 'a-previous-runtime' },
    ]) {
      const refused = await run(
        fixture.runs.captureProducerOutput({
          ...fence,
          producerOutput: { value: { update: { count: 1 } } },
          producerArtifactHash: PIN_A,
        }),
      );
      assert.deepEqual(rejection(refused), { kind: 'attempt_not_owned' });
    }
    const attempt = (await run(fixture.runs.findAttempt(claimed.attempt.id)))!;
    assert.equal(attempt.producerOutput, null);
  } finally {
    fixture.close();
  }
});

test('a complete suspended result survives an interrupted attempt, wait and pin intact', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = await claim(fixture, entered.run);

    // The whole producer result, not just its update: a `reduction_failed` retry has to re-commit
    // the same wait declaration without re-entering the callback, so the wait has to be in the
    // saved operand or it is gone.
    const completeResult = {
      type: 'suspend',
      update: { count: 1 },
      wait: { kind: 'user_continue', label: 'Approve the draft' },
    };
    committedValue(
      await run(
        fixture.runs.captureProducerOutput({
          ...fenceOf(entered.run, claimed.attempt),
          producerOutput: { value: completeResult },
          producerArtifactHash: PIN_A,
        }),
      ),
    );

    // Interrupted, not failed: nobody observed how it ended, which is the case with no failure code
    // at all and the one a diagnostic-keyed recovery would get wrong.
    await run(fixture.runs.parkUnfinishedRuns({}));
    const interrupted = (await run(fixture.runs.findAttempt(claimed.attempt.id)))!;
    assert.equal(interrupted.status, 'interrupted');

    const segment = {
      frameId: entered.launched.frame.id,
      executionId: claimed.attempt.executionId,
      segmentKind: 'node_callback' as const,
      segmentRef: null,
    };
    const saved = await run(fixture.runs.findProducerOutput(segment));
    assert.ok(saved);
    assert.equal(saved.producerArtifactHash, PIN_A);
    assert.deepEqual(await run(fixture.payloads.resolve(saved.slot)), completeResult);
  } finally {
    fixture.close();
  }
});

test('an execution-less attempt is reachable by its frame and by its own id', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    // `graph_entry` is the execution-less segment the launch path produces.
    const launched = await launch(fixture);
    const entry = await claim(fixture, launched.run);
    assert.equal(entry.attempt.executionId, null);
    assert.equal(entry.attempt.segmentKind, 'graph_entry');

    const byId = await run(fixture.runs.findAttempt(entry.attempt.id));
    assert.equal(byId?.id, entry.attempt.id);

    // The preparation attempt shares the root frame and is execution-less too, so the frame lookup
    // returns both. Segment identity is what tells them apart, which the query below asserts.
    const byFrame = await run(fixture.runs.listAttemptsForFrame(launched.frame.id));
    assert.deepEqual(
      byFrame.map((attempt) => attempt.segmentKind),
      ['environment_preparation', 'graph_entry'],
    );
    assert.ok(byFrame.some((attempt) => attempt.id === entry.attempt.id));

    const bySegment = await run(
      fixture.runs.listAttemptsForSegment({
        frameId: launched.frame.id,
        executionId: null,
        segmentKind: 'graph_entry',
        segmentRef: null,
      }),
    );
    assert.deepEqual(
      bySegment.map((attempt) => attempt.id),
      [entry.attempt.id],
    );

    // And the other execution-less segment: a graph output, addressed by its outcome.
    await run(
      fixture.runs.commitGraphEntry({
        ...fenceOf(launched.run, entry.attempt),
        frameId: launched.frame.id,
        state: { value: { count: 0 } },
        entryNode: { nodeId: 'work', nodeKind: 'operation' },
      }),
    );
    let current = (await run(fixture.runs.findRun(launched.run.id)))!;
    const callback = await claim(fixture, current);
    await run(
      fixture.runs.commitNodeResult({
        ...fenceOf(current, callback.attempt),
        frameId: launched.frame.id,
        executionId: callback.attempt.executionId!,
        state: { value: { count: 1 } },
        producerOutput: { value: { update: { count: 1 } } },
        producerArtifactHash: PIN_A,
        next: { kind: 'routing', edgeId: 'work-out' },
      }),
    );
    current = (await run(fixture.runs.findRun(launched.run.id)))!;
    const routing = await claim(fixture, current);
    await run(
      fixture.runs.commitRouting({
        ...fenceOf(current, routing.attempt),
        frameId: launched.frame.id,
        executionId: routing.attempt.executionId!,
        state: { value: { count: 1 } },
        producerOutput: { value: { to: 'finished' } },
        producerArtifactHash: PIN_A,
        next: { kind: 'outcome', outcomeId: 'finished' },
      }),
    );
    current = (await run(fixture.runs.findRun(launched.run.id)))!;
    assert.equal(current.position.kind, 'graph_output');
    const output = await claim(fixture, current);
    assert.equal(output.attempt.executionId, null);
    assert.equal(output.attempt.segmentKind, 'graph_output');
    assert.equal(output.attempt.segmentRef, 'finished');

    assert.equal((await run(fixture.runs.findAttempt(output.attempt.id)))?.id, output.attempt.id);
    assert.ok(
      (await run(fixture.runs.listAttemptsForFrame(launched.frame.id)))
        .map((attempt) => attempt.id)
        .includes(output.attempt.id),
    );
  } finally {
    fixture.close();
  }
});

test('a captured display name is bounded, and an empty one is stored as absent', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    fixture.seedArtifact(PIN_A);
    const runaway = 'n'.repeat(5000);
    const created = await createPlacedRun(fixture, {
      workflowKey: 'fixture',
      title: 'Fixture',
      rootGraphKey: 'root',
      artifactHash: PIN_A,
      rootFrame: { graphKey: 'root', displayName: runaway },
      placement: fixture.seedPlacement(),
    });
    // Persisted, not merely returned: a runaway name must not be able to bloat the row.
    const frame = (await run(fixture.runs.findFrame(created.frame.id)))!;
    assert.equal(frame.displayName?.length, 200);

    const entry = await claim(fixture, created.run);
    await run(
      fixture.runs.commitGraphEntry({
        ...fenceOf(created.run, entry.attempt),
        frameId: created.frame.id,
        state: { value: {} },
        frameDisplayName: '',
        entryNode: { nodeId: 'work', nodeKind: 'operation', displayName: runaway },
      }),
    );
    const renamed = (await run(fixture.runs.findFrame(created.frame.id)))!;
    assert.equal(renamed.displayName, null, 'an empty name names nothing, so it is absent');

    // The execution path is bounded too, and both go through the same helper.
    const executions = await run(fixture.runs.listExecutions(created.frame.id));
    assert.equal(executions[0]!.displayName?.length, 200);
  } finally {
    fixture.close();
  }
});

test('payload storage lives outside any worktree and survives the worktree being deleted', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const slot = await run(fixture.payloads.publish({ note: 'x'.repeat(20_000) }));
    const path = fixture.payloads.pathOf(slot.ref!);

    const worktreePath = (await run(fixture.runs.findRun(entered.run.id)))!.destination
      .worktreePath!;
    assert.ok(
      !path.startsWith(worktreePath),
      `payload ${path} must not live under the worktree ${worktreePath}`,
    );
    assert.ok(path.startsWith(join(fixture.root, 'workflow-payloads')));

    // Deleting the worktree is an ordinary thing a person does. It cascades the attachment away and
    // must take no recorded value with it.
    fixture.client
      .prepare('DELETE FROM worktrees WHERE id = ?')
      .run(entered.launched.placement.worktreeId);

    assert.equal(existsSync(path), true);
    assert.deepEqual(await run(fixture.payloads.read(slot.ref!)), { note: 'x'.repeat(20_000) });
    const frame = (await run(fixture.runs.findFrame(entered.launched.frame.id)))!;
    assert.deepEqual(await run(fixture.payloads.resolve(frame.state!)), { count: 0 });
  } finally {
    fixture.close();
  }
});

test('a capture after Cancel is recorded and still advances nothing', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = await claim(fixture, entered.run);
    const running = (await run(fixture.runs.findRun(entered.run.id)))!;
    const positionBefore = running.position;
    committedValue(
      await run(
        fixture.runs.applyCancel({ runId: running.id, controlRevision: running.controlRevision }),
      ),
    );

    // Recording what already happened is always permitted — forgetting it is what would force a
    // producer to run twice — but it is evidence, not progress.
    const captured = await run(
      fixture.runs.captureProducerOutput({
        ...fenceOf(entered.run, claimed.attempt),
        producerOutput: { value: { update: { count: 1 } } },
        producerArtifactHash: PIN_A,
      }),
    );
    assert.equal(committedValue(captured), true);

    const after = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(after.status, 'cancelled', 'a terminal run is not revived by late evidence');
    assert.deepEqual(after.position, positionBefore, 'and the graph does not advance');
    assert.ok((await run(fixture.runs.findAttempt(claimed.attempt.id)))!.producerOutput);
  } finally {
    fixture.close();
  }
});

test('routing back to a node creates a new execution and leaves the old one intact', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const first = await claim(fixture, entered.run);
    const firstExecutionId = first.attempt.executionId!;
    committedValue(
      await run(
        fixture.runs.commitNodeResult({
          ...fenceOf(entered.run, first.attempt),
          frameId: entered.launched.frame.id,
          executionId: firstExecutionId,
          state: { value: { count: 1 } },
          producerOutput: { value: { update: { count: 1 } } },
          producerArtifactHash: PIN_A,
          next: { kind: 'routing', edgeId: 'work-out' },
        }),
      ),
    );

    // The loop: this node routes back to itself, which is an ordinary bounded-retry shape.
    let current = (await run(fixture.runs.findRun(entered.run.id)))!;
    const routing = await claim(fixture, current);
    committedValue(
      await run(
        fixture.runs.commitRouting({
          ...fenceOf(current, routing.attempt),
          frameId: entered.launched.frame.id,
          executionId: firstExecutionId,
          state: { value: { count: 1 } },
          producerOutput: { value: { to: 'work' } },
          producerArtifactHash: PIN_A,
          next: { kind: 'node', nodeId: 'work', nodeKind: 'operation' },
        }),
      ),
    );

    const executions = await run(fixture.runs.listExecutions(entered.launched.frame.id));
    assert.equal(executions.length, 2, 'a revisit is a new execution, not a reopened one');
    const [previous, revisit] = executions;
    assert.equal(previous!.id, firstExecutionId);
    assert.equal(previous!.visitIndex, 0);
    assert.equal(revisit!.visitIndex, 1, 'zero-based, so the second visit is 1');
    assert.equal(revisit!.nodeId, 'work');

    // The earlier visit keeps its own history: a definition node and an iteration of it are
    // different things, and conflating them is what the inspector must never do.
    assert.equal(previous!.status, 'completed');
    assert.ok(previous!.endedAt);
    assert.equal(previous!.endCertainty, 'observed');
    assert.equal(revisit!.status, 'running');
    assert.equal(revisit!.endedAt, null);

    current = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.ok(current.position.kind === 'node_callback');
    assert.equal(current.position.executionId, revisit!.id);

    // Each visit keeps its own attempts, addressed by its own execution identity.
    assert.equal(
      (
        await run(
          fixture.runs.listAttemptsForSegment({
            frameId: entered.launched.frame.id,
            executionId: firstExecutionId,
            segmentKind: 'node_callback',
            segmentRef: null,
          }),
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await run(
          fixture.runs.listAttemptsForSegment({
            frameId: entered.launched.frame.id,
            executionId: revisit!.id,
            segmentKind: 'node_callback',
            segmentRef: null,
          }),
        )
      ).length,
      0,
      'the new visit has not been claimed yet',
    );
  } finally {
    fixture.close();
  }
});

/** Drives a run to an armed human wait and hands back the identities a delivery needs. */
async function armHumanWait(fixture: WorkflowPersistenceFixture) {
  const entered = await enterRootGraph(fixture);
  const claimed = await claim(fixture, entered.run);
  committedValue(
    await run(
      fixture.runs.commitNodeResult({
        ...fenceOf(entered.run, claimed.attempt),
        frameId: entered.launched.frame.id,
        executionId: claimed.attempt.executionId!,
        state: { value: { count: 1 } },
        producerOutput: { value: { update: { count: 1 } } },
        producerArtifactHash: PIN_A,
        next: {
          kind: 'suspend',
          waitKind: 'user_input',
          condition: { value: { kind: 'user_input', questions: [] } },
        },
      }),
    ),
  );
  const waiting = (await run(fixture.runs.findRun(entered.run.id)))!;
  assert.ok(waiting.position.kind === 'awaiting_wait');
  return { entered, waitId: waiting.position.waitId };
}

test('a human wait is consumed once; a repeat and a wrong identity both write nothing', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const { entered, waitId } = await armHumanWait(fixture);

    const consumed = committedValue(
      await run(
        fixture.runs.consumeHumanWait({
          waitId,
          edgeId: 'work-out',
          event: { value: { kind: 'user_input', answers: { approve: 'yes' } } },
        }),
      ),
    );
    assert.equal(consumed.outcome, 'advanced');
    assert.equal(consumed.wait.status, 'delivered');
    const advanced = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(advanced.status, 'ready');
    assert.equal(advanced.position.kind, 'routing');
    const revisionAfterFirst = advanced.revision;

    // A person double-submitting the form. Already resolved, so nothing is written and no second
    // transition is allocated.
    const repeat = await run(
      fixture.runs.consumeHumanWait({
        waitId,
        edgeId: 'work-out',
        event: { value: { kind: 'user_input', answers: { approve: 'no' } } },
      }),
    );
    assert.deepEqual(rejection(repeat), { kind: 'wait_already_resolved', status: 'delivered' });
    assert.equal((await run(fixture.runs.findRun(entered.run.id)))!.revision, revisionAfterFirst);
    assert.deepEqual(
      await run(fixture.payloads.resolve((await run(fixture.runs.findWait(waitId)))!.event!)),
      { kind: 'user_input', answers: { approve: 'yes' } },
      'the first answer stands',
    );

    // A stale form targeting a wait that never existed cannot satisfy anything.
    const unknown = await run(
      fixture.runs.consumeHumanWait({
        waitId: waitId + 500,
        edgeId: 'work-out',
        event: { value: { kind: 'user_input', answers: {} } },
      }),
    );
    assert.deepEqual(rejection(unknown), { kind: 'run_not_found' });
    assert.equal((await run(fixture.runs.findRun(entered.run.id)))!.revision, revisionAfterFirst);
  } finally {
    fixture.close();
  }
});

test('a human answer arriving after Cancel is kept as evidence and revives nothing', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const { entered, waitId } = await armHumanWait(fixture);
    const waiting = (await run(fixture.runs.findRun(entered.run.id)))!;
    const positionBefore = waiting.position;
    committedValue(
      await run(
        fixture.runs.applyCancel({ runId: waiting.id, controlRevision: waiting.controlRevision }),
      ),
    );

    const late = committedValue(
      await run(
        fixture.runs.consumeHumanWait({
          waitId,
          edgeId: 'work-out',
          event: { value: { kind: 'user_input', answers: { approve: 'yes' } } },
        }),
      ),
    );
    assert.equal(late.outcome, 'late_evidence');
    assert.equal(late.wait.status, 'delivered', 'the answer is retained, not discarded');

    const after = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(after.status, 'cancelled');
    assert.deepEqual(after.position, positionBefore);
  } finally {
    fixture.close();
  }
});

test('a superseded wait keeps its late event and advances nothing', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const { entered, waitId } = await armHumanWait(fixture);
    const before = (await run(fixture.runs.findRun(entered.run.id)))!;

    const superseded = committedValue(
      await run(
        fixture.runs.supersedeWait({
          waitId,
          lateEvent: { value: { kind: 'agent_turn', outcome: 'ended', recordedAt: 'later' } },
        }),
      ),
    );
    assert.equal(superseded.status, 'superseded');
    assert.deepEqual(await run(fixture.payloads.resolve(superseded.event!)), {
      kind: 'agent_turn',
      outcome: 'ended',
      recordedAt: 'later',
    });

    // Superseding records what arrived; it does not resume the continuation the wait was holding.
    const after = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(after.status, 'waiting');
    assert.deepEqual(after.position, before.position);

    // And a superseded wait can no longer be delivered: the continuation it guarded is gone.
    assert.deepEqual(
      rejection(
        await run(
          fixture.runs.deliverWait({
            waitId,
            edgeId: 'work-out',
            event: { value: { kind: 'user_input', answers: {} } },
          }),
        ),
      ),
      { kind: 'wait_already_resolved', status: 'superseded' },
    );
  } finally {
    fixture.close();
  }
});

test('the database refuses a duplicate visit and a second attachment for one run', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const execution = (await run(fixture.runs.listExecutions(entered.launched.frame.id)))[0]!;

    // A successful revisit proves valid inserts work; it does not prove a duplicate is refused.
    // Written directly, because the repository derives `visit_index` from a count and would simply
    // pick the next one.
    assert.throws(
      () =>
        fixture.client
          .prepare(
            `INSERT INTO workflow_node_executions (
               run_id, frame_id, node_id, node_kind, visit_index, status, started_at, end_certainty
             ) VALUES (?, ?, ?, 'operation', ?, 'running', '2026-01-01T00:00:00.000Z', 'observed')`,
          )
          .run(entered.run.id, execution.frameId, execution.nodeId, execution.visitIndex),
      /UNIQUE constraint failed/,
    );

    assert.throws(
      () =>
        fixture.client
          .prepare(
            `INSERT INTO workflow_run_attachments (run_id, worktree_id, surface_id, attached_at)
             VALUES (?, ?, NULL, '2026-01-01T00:00:00.000Z')`,
          )
          .run(entered.run.id, entered.launched.placement.worktreeId),
      /UNIQUE constraint failed/,
    );

    assert.throws(
      () =>
        fixture.client
          .prepare(
            `INSERT INTO workflow_transitions (run_id, revision, recorded_at, kind)
             VALUES (?, 1, '2026-01-01T00:00:00.000Z', 'log')`,
          )
          .run(entered.run.id),
      /UNIQUE constraint failed/,
    );
  } finally {
    fixture.close();
  }
});

test('an attempt records the input it was given, inline or referenced', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const prepared = await prepareClaim(fixture, entered.run.id);

    const small = committedValue(
      await run(
        fixture.runs.claimSegment({
          ...prepared,
          input: { value: { state: { count: 0 }, event: null } },
          owner: OWNER,
          ownerIncarnation: INCARNATION,
        }),
      ),
    );
    assert.ok(small.attempt.input, 'the slot is produced, not left empty');
    assert.equal(small.attempt.input.ref, null, 'a small input stays inline');
    assert.deepEqual(await run(fixture.payloads.resolve(small.attempt.input)), {
      state: { count: 0 },
      event: null,
    });

    // A large state boundary is referenced rather than inlined, through the same slot.
    await run(
      fixture.runs.failSegment({
        ...fenceOf(entered.run, small.attempt),
        code: 'node_callback_failed',
        message: 'boom',
      }),
    );
    const failed = (await run(fixture.runs.findRun(entered.run.id)))!;
    committedValue(
      await run(
        fixture.runs.adoptRetryPin({
          runId: failed.id,
          controlRevision: failed.controlRevision,
          artifactHash: PIN_A,
          expectedPosition: failed.position,
          expectedOwner: failed.owner,
        }),
      ),
    );
    const large = committedValue(
      await run(
        fixture.runs.claimSegment({
          ...(await prepareClaim(fixture, entered.run.id)),
          input: { value: { notes: 'x'.repeat(20_000) } },
          owner: OWNER,
          ownerIncarnation: INCARNATION,
        }),
      ),
    );
    assert.equal(large.attempt.input?.inline, null);
    assert.match(large.attempt.input!.ref!, /^sha256:/);

    // The first attempt's input is untouched by the second: each try keeps what it was given.
    const first = (await run(fixture.runs.findAttempt(small.attempt.id)))!;
    assert.deepEqual(first.input, small.attempt.input);
    assert.deepEqual(await run(fixture.payloads.resolve(first.input!)), {
      state: { count: 0 },
      event: null,
    });
  } finally {
    fixture.close();
  }
});

test('a recorded JSON null input is distinguishable from an absent one', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const claimed = committedValue(
      await run(
        fixture.runs.claimSegment({
          ...(await prepareClaim(fixture, entered.run.id)),
          input: { value: null },
          owner: OWNER,
          ownerIncarnation: INCARNATION,
        }),
      ),
    );
    // Produced, and its value is JSON null — not the absence a null slot would mean.
    assert.deepEqual(claimed.attempt.input, { inline: 'null', ref: null });
    assert.equal(await run(fixture.payloads.resolve(claimed.attempt.input!)), null);

    // Absence is what a historical row without an input looks like, and it is still representable.
    fixture.client
      .prepare('UPDATE workflow_segment_attempts SET input_inline = NULL WHERE id = ?')
      .run(claimed.attempt.id);
    assert.equal((await run(fixture.runs.findAttempt(claimed.attempt.id)))!.input, null);
  } finally {
    fixture.close();
  }
});

test('a claim whose operands moved is rejected, allocating nothing', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);

    // Prepared against the state boundary as it stands now.
    const prepared = await prepareClaim(fixture, entered.run.id);

    // A repin between preparation and claim. The control revision moved too, so use the current one
    // to prove it is the *operand* check that refuses this, not the control fence.
    const before = (await run(fixture.runs.findRun(entered.run.id)))!;
    committedValue(
      await run(
        fixture.runs.adoptRetryPin({
          runId: before.id,
          controlRevision: before.controlRevision,
          artifactHash: PIN_B,
          expectedPosition: before.position,
          expectedOwner: before.owner,
        }),
      ),
    );
    const repinned = (await run(fixture.runs.findRun(entered.run.id)))!;
    const stalePin = await run(
      fixture.runs.claimSegment({
        ...prepared,
        controlRevision: repinned.controlRevision,
        owner: OWNER,
        ownerIncarnation: INCARNATION,
      }),
    );
    assert.deepEqual(rejection(stalePin), {
      kind: 'stale_preparation',
      source: 'artifact_hash',
    });

    // A state boundary that advanced under the caller, with the pin now agreeing.
    const current = await prepareClaim(fixture, entered.run.id);
    fixture.client
      .prepare('UPDATE workflow_graph_frames SET state_inline = ? WHERE id = ?')
      .run(JSON.stringify({ count: 99 }), entered.launched.frame.id);
    const staleState = await run(
      fixture.runs.claimSegment({ ...current, owner: OWNER, ownerIncarnation: INCARNATION }),
    );
    assert.deepEqual(rejection(staleState), {
      kind: 'stale_preparation',
      source: 'frame_state',
    });

    // Neither refusal allocated an attempt, took ownership, consumed the pending Retry kind, or
    // wrote history.
    const after = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(
      (
        fixture.client.prepare('SELECT count(*) AS count FROM workflow_segment_attempts').get() as {
          count: number;
        }
      ).count,
      2,
      'only the placement and graph-entry attempts from setup',
    );
    assert.equal(after.activeAttemptId, null);
    assert.equal(after.owner, null);
    assert.equal(after.status, 'ready');
    assert.equal(after.pendingInvocationKind, 'retry', 'still waiting to be stamped');
    assert.equal(after.revision, repinned.revision, 'and no transition was appended');
  } finally {
    fixture.close();
  }
});

test('a diagnostic between preparation and claim does not invalidate the operands', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const entered = await enterRootGraph(fixture);
    const prepared = await prepareClaim(fixture, entered.run.id);

    // Diagnostics and operation evidence bump the run's history revision while changing no operand.
    // Fencing on that revision would reject a perfectly good input for unrelated noise.
    committedValue(
      await run(
        fixture.runs.appendDiagnostic({
          runId: entered.run.id,
          kind: 'log',
          detail: { value: { source: 'author_log', level: 'info', message: 'unrelated' } },
        }),
      ),
    );
    assert.notEqual(
      (await run(fixture.runs.findRun(entered.run.id)))!.revision,
      entered.run.revision,
    );

    const claimed = await run(
      fixture.runs.claimSegment({ ...prepared, owner: OWNER, ownerIncarnation: INCARNATION }),
    );
    assert.ok(claimed.ok, 'the claim still applies');
  } finally {
    fixture.close();
  }
});

test('Dismiss requires a stopped run, and is inert once the attachment is gone', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const launched = await launch(fixture);
    const live = (await run(fixture.runs.findRun(launched.run.id)))!;

    // An active run keeps its surface. Releasing the attachment here would take the placement back
    // while the work carried on, so Cancel has to come first.
    const refused = await run(
      fixture.runs.detachRun({ runId: live.id, controlRevision: live.controlRevision }),
    );
    assert.deepEqual(rejection(refused), { kind: 'run_active', status: 'ready' });
    const unchanged = (await run(fixture.runs.findRun(live.id)))!;
    assert.ok(await run(fixture.runs.findAttachment(live.id)), 'the attachment is untouched');
    assert.equal(unchanged.controlRevision, live.controlRevision, 'no revision was consumed');
    assert.equal(unchanged.revision, live.revision, 'and no transition was appended');

    committedValue(
      await run(
        fixture.runs.applyCancel({ runId: live.id, controlRevision: live.controlRevision }),
      ),
    );
    const cancelled = (await run(fixture.runs.findRun(live.id)))!;
    const first = committedValue(
      await run(
        fixture.runs.detachRun({ runId: cancelled.id, controlRevision: cancelled.controlRevision }),
      ),
    );
    assert.deepEqual(first, { detached: true });

    // A repeat says so and writes nothing: a retried request must not fill the waterfall with
    // controls that changed nothing.
    const detached = (await run(fixture.runs.findRun(live.id)))!;
    const repeat = committedValue(
      await run(
        fixture.runs.detachRun({ runId: detached.id, controlRevision: detached.controlRevision }),
      ),
    );
    assert.deepEqual(repeat, { detached: false });
    const afterRepeat = (await run(fixture.runs.findRun(live.id)))!;
    assert.equal(afterRepeat.revision, detached.revision);
    assert.equal(afterRepeat.controlRevision, detached.controlRevision);
  } finally {
    fixture.close();
  }
});

// --- environment preparation --------------------------------------------------------------------
//
// A run exists before it is placed. These cover the three writes that make that safe: creation
// claims its own attempt so an interruption has something to attribute itself to, receipts record
// what was allocated and refuse to overwrite it, and one commit makes a destination effective.

/** A run parked mid-preparation: claimed, unplaced, with a preparation row describing the request. */
async function preparing(
  fixture: WorkflowPersistenceFixture,
  request: WorkflowPlacementRequestDto = {
    worktree: { kind: 'create', branch: 'feat/x', fromRef: 'main' },
    surface: { kind: 'create', title: 'Work' },
  },
) {
  fixture.seedArtifact(PIN_A);
  const placement = fixture.seedPlacement();
  const created = committedValue(
    await run(
      fixture.runs.createRun({
        workflowKey: 'fixture',
        title: 'Preparing run',
        rootGraphKey: 'root',
        artifactHash: PIN_A,
        rootFrame: { graphKey: 'root', parameters: { value: { note: 'hello' } } },
        origin: {
          worktreeId: placement.worktreeId,
          worktreePath: '/repo/fixture',
          surfaceId: placement.surfaceId,
          paneId: null,
          agentSessionId: null,
        },
        preparation: {
          source: 'selector',
          request,
          baseCommit: 'c'.repeat(40),
          checkoutPath: '/data/worktrees/feat-x',
        },
        claim: {
          owner: OWNER,
          ownerIncarnation: INCARNATION,
          input: { value: { segment: 'environment_preparation' } },
        },
      }),
    ),
  );
  return { ...created, placement };
}

function preparationFence(created: { run: WorkflowRunRecord; attempt: WorkflowAttemptRecord }) {
  return {
    runId: created.run.id,
    attemptId: created.attempt.id,
    owner: OWNER,
    ownerIncarnation: INCARNATION,
  };
}

const WORKTREE_RECEIPT = {
  acquisition: 'created',
  worktreeId: 1,
  worktreePath: '/data/worktrees/feat-x',
  branch: 'feat/x',
} as const;

test('a created run is claimed at its preparation segment, unplaced, with its request recorded', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const created = await preparing(fixture);

    assert.deepEqual(created.run.position, {
      kind: 'environment_preparation',
      frameId: created.frame.id,
    });
    assert.equal(created.run.status, 'running');
    assert.equal(created.run.owner, OWNER);
    assert.equal(created.run.ownerIncarnation, INCARNATION);
    assert.equal(created.run.activeAttemptId, created.attempt.id);
    assert.equal(created.run.activeFrameId, created.frame.id);

    // Unplaced: nothing is decided and nothing is occupied until the commit.
    assert.deepEqual(created.run.destination, {
      worktreeId: null,
      worktreePath: null,
      surfaceId: null,
    });
    assert.equal(await run(fixture.runs.findAttachment(created.run.id)), null);

    // The root frame is untouched by preparation — `graph_entry` still enters it.
    assert.equal(created.frame.status, 'initializing');
    assert.deepEqual(await run(fixture.payloads.resolve(created.frame.parameters!)), {
      note: 'hello',
    });

    assert.equal(created.attempt.segmentKind, 'environment_preparation');
    assert.equal(created.attempt.executionId, null);
    assert.equal(created.attempt.attemptIndex, 1);
    assert.equal(created.attempt.invocationKind, 'initial');
    assert.equal(created.attempt.status, 'running');

    const preparation = (await run(fixture.runs.findPreparation(created.run.id)))!;
    assert.equal(preparation.source, 'selector');
    assert.deepEqual(preparation.request, {
      worktree: { kind: 'create', branch: 'feat/x', fromRef: 'main' },
      surface: { kind: 'create', title: 'Work' },
    });
    assert.equal(preparation.baseCommit, 'c'.repeat(40));
    assert.equal(preparation.checkoutPath, '/data/worktrees/feat-x');
    assert.deepEqual(
      [preparation.worktree, preparation.setup, preparation.surface],
      [null, null, null],
      'nothing has been allocated yet, so there is no receipt for anything',
    );

    // The claim is atomic with the creation, so the dispatch is recorded by the same transaction.
    const history = fixture.client
      .prepare('SELECT kind FROM workflow_transitions WHERE run_id = ? ORDER BY revision')
      .all(created.run.id) as { kind: string }[];
    assert.deepEqual(
      history.map((row) => row.kind),
      ['run_started', 'node_dispatched'],
    );
  } finally {
    fixture.close();
  }
});

test('a receipt writes its column and its transition, and is never overwritten', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const created = await preparing(fixture);
    const fence = preparationFence(created);

    assert.equal(
      committedValue(
        await run(
          fixture.runs.recordEnvironmentReceipt({
            ...fence,
            step: 'worktree',
            receipt: WORKTREE_RECEIPT,
          }),
        ),
      ),
      'advanced',
    );
    const afterWorktree = (await run(fixture.runs.findPreparation(created.run.id)))!;
    assert.equal(afterWorktree.worktree?.worktreeId, 1);
    assert.equal(afterWorktree.worktree?.acquisition, 'created');
    assert.ok(afterWorktree.worktree?.recordedAt, 'the repository stamps the time, not the caller');
    assert.notEqual(afterWorktree.updatedAt, null);

    // A second worktree receipt is refused rather than replacing the only record of a real
    // allocation — the thing a retry reads to decide between reusing and creating.
    assert.deepEqual(
      rejection(
        await run(
          fixture.runs.recordEnvironmentReceipt({
            ...fence,
            step: 'worktree',
            receipt: { ...WORKTREE_RECEIPT, worktreeId: 2, worktreePath: '/elsewhere' },
          }),
        ),
      ),
      { kind: 'receipt_already_recorded', step: 'worktree' },
    );
    assert.equal(
      (await run(fixture.runs.findPreparation(created.run.id)))!.worktree?.worktreeId,
      1,
      'and the first receipt still stands',
    );

    // Setup is the one receipt a later attempt may replace, because hooks can be re-run.
    for (const status of ['failed', 'succeeded'] as const) {
      assert.equal(
        committedValue(
          await run(
            fixture.runs.recordEnvironmentReceipt({
              ...fence,
              step: 'setup',
              receipt: {
                status,
                reason: null,
                setupRunId: null,
                failure: null,
              },
            }),
          ),
        ),
        'advanced',
      );
    }
    assert.equal(
      (await run(fixture.runs.findPreparation(created.run.id)))!.setup?.status,
      'succeeded',
    );

    // The superseded receipt survives in history even though its column is gone, which is what
    // lets the trace show that hooks failed once and then succeeded.
    const recorded = fixture.client
      .prepare(
        `SELECT detail_inline FROM workflow_transitions
         WHERE run_id = ? AND kind = 'environment_step_recorded' ORDER BY revision`,
      )
      .all(created.run.id) as { detail_inline: string }[];
    assert.deepEqual(
      recorded.map((row) => {
        const detail = JSON.parse(row.detail_inline) as {
          step: string;
          receipt: { status?: string };
        };
        return [detail.step, detail.receipt.status ?? null];
      }),
      [
        ['worktree', null],
        ['setup', 'failed'],
        ['setup', 'succeeded'],
      ],
    );

    // A lost fence records nothing at all.
    assert.deepEqual(
      rejection(
        await run(
          fixture.runs.recordEnvironmentReceipt({
            ...fence,
            ownerIncarnation: 'someone-else',
            step: 'surface',
            receipt: { surfaceId: 9, requestedTitle: 'Work', title: 'Work' },
          }),
        ),
      ),
      { kind: 'attempt_not_owned' },
    );
    assert.equal((await run(fixture.runs.findPreparation(created.run.id)))!.surface, null);
  } finally {
    fixture.close();
  }
});

test('a Cancel that lands after an allocation still records the receipt that names it', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const created = await preparing(fixture);
    const fence = preparationFence(created);
    committedValue(
      await run(
        fixture.runs.applyCancel({
          runId: created.run.id,
          controlRevision: created.run.controlRevision,
        }),
      ),
    );

    // The worktree genuinely exists by now. Cancel revokes permission to advance, never permission
    // to record — a cancelled preparation that could not say what it created would leave a real
    // worktree with nothing naming it.
    assert.equal(
      committedValue(
        await run(
          fixture.runs.recordEnvironmentReceipt({
            ...fence,
            step: 'worktree',
            receipt: WORKTREE_RECEIPT,
          }),
        ),
      ),
      'cancelled_evidence',
    );

    const preparation = (await run(fixture.runs.findPreparation(created.run.id)))!;
    assert.equal(preparation.worktree?.worktreeId, 1, 'the column was still written');

    const attempt = (await run(fixture.runs.findAttempt(created.attempt.id)))!;
    assert.equal(attempt.status, 'cancelled');
    assert.ok(attempt.endedAt);

    const after = (await run(fixture.runs.findRun(created.run.id)))!;
    assert.equal(after.owner, null);
    assert.equal(after.activeAttemptId, null);
    assert.deepEqual(after.position, {
      kind: 'environment_preparation',
      frameId: created.frame.id,
    });
    assert.deepEqual(
      after.destination,
      { worktreeId: null, worktreePath: null, surfaceId: null },
      'a cancelled preparation never became placed',
    );

    // Evidence first, then the control that stopped anything further: history reads in the order
    // the facts occurred.
    const history = fixture.client
      .prepare('SELECT kind FROM workflow_transitions WHERE run_id = ? ORDER BY revision')
      .all(created.run.id) as { kind: string }[];
    assert.deepEqual(history.map((row) => row.kind).slice(-2), [
      'environment_step_recorded',
      'control_applied',
    ]);
  } finally {
    fixture.close();
  }
});

test('committing a preparation places the run, and an occupied surface refuses it outright', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const created = await preparing(fixture);
    assert.equal(
      committedValue(
        await run(
          fixture.runs.commitEnvironmentPreparation({
            ...preparationFence(created),
            destination: {
              worktreeId: created.placement.worktreeId,
              worktreePath: '/repo/fixture',
              surfaceId: created.placement.surfaceId,
            },
          }),
        ),
      ),
      'advanced',
    );

    const placed = (await run(fixture.runs.findRun(created.run.id)))!;
    assert.deepEqual(placed.destination, {
      worktreeId: created.placement.worktreeId,
      worktreePath: '/repo/fixture',
      surfaceId: created.placement.surfaceId,
    });
    assert.deepEqual(placed.position, { kind: 'graph_entry', frameId: created.frame.id });
    assert.equal(placed.status, 'ready');
    assert.equal(placed.owner, null, 'ownership is released with the commit');
    assert.equal(placed.ownerIncarnation, null);
    assert.equal(placed.activeAttemptId, null);

    const attachment = (await run(fixture.runs.findAttachment(created.run.id)))!;
    assert.equal(attachment.surfaceId, created.placement.surfaceId);
    assert.equal(attachment.worktreeId, created.placement.worktreeId);

    const attempt = (await run(fixture.runs.findAttempt(created.attempt.id)))!;
    assert.equal(attempt.status, 'succeeded');
    assert.equal(attempt.endCertainty, 'observed');

    const prepared = fixture.client
      .prepare(
        `SELECT detail_inline FROM workflow_transitions
         WHERE run_id = ? AND kind = 'environment_prepared'`,
      )
      .get(created.run.id) as { detail_inline: string };
    assert.deepEqual(JSON.parse(prepared.detail_inline), {
      destination: {
        worktreeId: created.placement.worktreeId,
        worktreePath: '/repo/fixture',
        surfaceId: created.placement.surfaceId,
      },
    });

    // The same surface cannot hold two. A second preparation is refused at the commit, and the
    // refusal writes nothing.
    const second = await preparing(fixture);
    const before = (await run(fixture.runs.findRun(second.run.id)))!.revision;
    assert.deepEqual(
      rejection(
        await run(
          fixture.runs.commitEnvironmentPreparation({
            ...preparationFence(second),
            destination: {
              worktreeId: created.placement.worktreeId,
              worktreePath: '/repo/fixture',
              surfaceId: created.placement.surfaceId,
            },
          }),
        ),
      ),
      { kind: 'surface_busy', runId: created.run.id },
    );
    const refused = (await run(fixture.runs.findRun(second.run.id)))!;
    assert.deepEqual(refused.destination, {
      worktreeId: null,
      worktreePath: null,
      surfaceId: null,
    });
    assert.equal(await run(fixture.runs.findAttachment(second.run.id)), null);
    assert.equal(refused.revision, before, 'and no history was appended');
    assert.equal(
      (await run(fixture.runs.findAttempt(second.attempt.id)))!.status,
      'running',
      'the attempt is left exactly as it was, so the caller may still act',
    );
  } finally {
    fixture.close();
  }
});

test('a preparation position is claimable without a destination, but not while paused or cancelled', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    // A run that failed mid-preparation is where Retry re-enters, so the claim has to work against
    // a null destination — the live-placement re-check would otherwise reject it forever.
    const created = await preparing(fixture);

    /** Fails the currently claimed preparation attempt and repins it, as Retry does. */
    async function failAndAdopt(attemptId: number) {
      committedValue(
        await run(
          fixture.runs.failSegment({
            runId: created.run.id,
            attemptId,
            owner: OWNER,
            ownerIncarnation: INCARNATION,
            code: 'environment_preparation_failed',
            message: 'worktree creation failed',
          }),
        ),
      );
      const failed = (await run(fixture.runs.findRun(created.run.id)))!;
      committedValue(
        await run(
          fixture.runs.adoptRetryPin({
            runId: failed.id,
            controlRevision: failed.controlRevision,
            artifactHash: PIN_A,
            expectedPosition: failed.position,
            expectedOwner: failed.owner,
          }),
        ),
      );
      return (await run(fixture.runs.findRun(created.run.id)))!;
    }

    let current = await failAndAdopt(created.attempt.id);
    assert.deepEqual(current.destination, {
      worktreeId: null,
      worktreePath: null,
      surfaceId: null,
    });
    assert.deepEqual(current.position, {
      kind: 'environment_preparation',
      frameId: created.frame.id,
    });

    const retried = committedValue(
      await run(
        fixture.runs.claimSegment({
          ...(await prepareClaim(fixture, current.id)),
          owner: OWNER,
          ownerIncarnation: INCARNATION,
        }),
      ),
    );
    assert.equal(retried.attempt.segmentKind, 'environment_preparation');
    assert.equal(retried.attempt.executionId, null);
    assert.equal(retried.attempt.attemptIndex, 2);
    assert.equal(retried.attempt.invocationKind, 'retry');

    // Every other guard still applies; only the placement re-check is skipped.
    current = await failAndAdopt(retried.attempt.id);
    committedValue(
      await run(
        fixture.runs.applyPause({ runId: current.id, controlRevision: current.controlRevision }),
      ),
    );
    current = (await run(fixture.runs.findRun(created.run.id)))!;
    assert.deepEqual(
      rejection(
        await run(
          fixture.runs.claimSegment({
            ...(await prepareClaim(fixture, current.id)),
            owner: OWNER,
            ownerIncarnation: INCARNATION,
          }),
        ),
      ),
      { kind: 'not_claimable', reason: 'paused' },
    );

    // And a cancelled run is refused for the ordinary reason, not for a missing destination.
    committedValue(
      await run(
        fixture.runs.applyCancel({ runId: current.id, controlRevision: current.controlRevision }),
      ),
    );
    current = (await run(fixture.runs.findRun(created.run.id)))!;
    assert.deepEqual(
      rejection(
        await run(
          fixture.runs.claimSegment({
            ...(await prepareClaim(fixture, current.id)),
            owner: OWNER,
            ownerIncarnation: INCARNATION,
          }),
        ),
      ),
      { kind: 'not_claimable', reason: 'status' },
    );
  } finally {
    fixture.close();
  }
});

test('a restart fails a preparing run at its first outstanding allocation, and parks everything else', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    // One preparing run and one ordinary run, so the single pass is shown to handle both.
    const preparingRun = await preparing(fixture);
    const entered = await enterRootGraph(fixture);
    await claim(fixture, entered.run);

    const outcome = await run(fixture.runs.parkUnfinishedRuns({}));
    assert.deepEqual(outcome, {
      parked: [entered.run.id],
      preparationsFailed: [preparingRun.run.id],
    });

    const failed = (await run(fixture.runs.findRun(preparingRun.run.id)))!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'environment_preparation_failed');
    assert.equal(
      failed.failureMessage,
      'The runtime restarted while this run was preparing its environment.',
    );
    assert.equal(failed.failureAttemptId, preparingRun.attempt.id);
    assert.equal(failed.paused, false, 'no pause band: Retry is the single re-entry path');
    assert.ok(failed.endedAt);
    assert.equal(failed.owner, null);
    assert.equal(failed.activeAttemptId, null);
    assert.deepEqual(
      await run(fixture.runs.listPauseIntervals(preparingRun.run.id)),
      [],
      'and no interval was opened for it',
    );

    const attempt = (await run(fixture.runs.findAttempt(preparingRun.attempt.id)))!;
    assert.equal(attempt.status, 'interrupted');
    assert.equal(attempt.endCertainty, 'unknown');
    assert.equal(attempt.endedAt, null, 'an unobserved end is not a timestamp');
    assert.deepEqual(await run(fixture.payloads.resolve(attempt.failureDetail!)), {
      step: 'worktree',
      reason: 'interrupted',
    });

    const history = fixture.client
      .prepare(
        'SELECT kind, detail_inline FROM workflow_transitions WHERE run_id = ? ORDER BY revision',
      )
      .all(preparingRun.run.id) as { kind: string; detail_inline: string | null }[];
    assert.deepEqual(history.map((row) => row.kind).slice(-2), [
      'segment_failed',
      'control_applied',
    ]);
    assert.deepEqual(JSON.parse(history.at(-1)!.detail_inline!), {
      control: 'runtime_restart',
      preparationFailed: true,
    });

    // The ordinary run is parked exactly as it always was.
    const parked = (await run(fixture.runs.findRun(entered.run.id)))!;
    assert.equal(parked.status, 'ready');
    assert.equal(parked.paused, true);
    assert.ok(
      (await run(fixture.runs.listPauseIntervals(entered.run.id))).some(
        (interval) => interval.reason === 'runtime_restart' && interval.resumedAt === null,
      ),
    );
  } finally {
    fixture.close();
  }
});

test('the named step follows the receipts, and a preparation with no attempt fails without one', async () => {
  for (const scenario of [
    {
      name: 'nothing allocated yet',
      receipts: [] as const,
      step: 'worktree',
    },
    {
      name: 'worktree created, hooks not yet run',
      receipts: ['worktree'] as const,
      step: 'setup',
    },
    {
      name: 'hooks failed, so they are still outstanding',
      receipts: ['worktree', 'setup-failed'] as const,
      step: 'setup',
    },
    {
      name: 'worktree and hooks done, surface not created',
      receipts: ['worktree', 'setup-ok'] as const,
      step: 'surface',
    },
    {
      name: 'every allocation made; only the commit is left',
      receipts: ['worktree', 'setup-ok', 'surface'] as const,
      step: 'commit',
    },
  ]) {
    const fixture = makeWorkflowPersistenceFixture();
    try {
      const created = await preparing(fixture);
      const fence = preparationFence(created);
      for (const receipt of scenario.receipts) {
        if (receipt === 'worktree') {
          committedValue(
            await run(
              fixture.runs.recordEnvironmentReceipt({
                ...fence,
                step: 'worktree',
                receipt: WORKTREE_RECEIPT,
              }),
            ),
          );
        } else if (receipt === 'surface') {
          committedValue(
            await run(
              fixture.runs.recordEnvironmentReceipt({
                ...fence,
                step: 'surface',
                receipt: { surfaceId: 7, requestedTitle: 'Work', title: 'Work' },
              }),
            ),
          );
        } else {
          committedValue(
            await run(
              fixture.runs.recordEnvironmentReceipt({
                ...fence,
                step: 'setup',
                receipt: {
                  status: receipt === 'setup-ok' ? 'succeeded' : 'failed',
                  reason: null,
                  setupRunId: null,
                  failure: null,
                },
              }),
            ),
          );
        }
      }

      await run(fixture.runs.parkUnfinishedRuns({}));
      const attempt = (await run(fixture.runs.findAttempt(created.attempt.id)))!;
      assert.deepEqual(
        await run(fixture.payloads.resolve(attempt.failureDetail!)),
        { step: scenario.step, reason: 'interrupted' },
        scenario.name,
      );
    } finally {
      fixture.close();
    }
  }
});

test('a reuse-only preparation names the commit, and an attempt-less row fails with nothing to blame', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    // Reuse allocates nothing, leaves no receipt, and is re-validated on every attempt — so it is
    // never named as an outstanding step.
    const created = await preparing(fixture, {
      worktree: { kind: 'current' },
      surface: { kind: 'existing', surfaceId: 4 },
    });
    // A Retry that crashed between adopting its pin and allocating its claim: the run is
    // non-terminal and preparing, with no attempt to attribute the interruption to.
    fixture.client
      .prepare(
        `UPDATE workflow_runs
         SET status = 'ready', active_attempt_id = NULL, owner = NULL, owner_incarnation = NULL
         WHERE id = ?`,
      )
      .run(created.run.id);
    fixture.client
      .prepare(`UPDATE workflow_segment_attempts SET status = 'failed' WHERE id = ?`)
      .run(created.attempt.id);

    const outcome = await run(fixture.runs.parkUnfinishedRuns({}));
    assert.deepEqual(outcome, { parked: [], preparationsFailed: [created.run.id] });

    const failed = (await run(fixture.runs.findRun(created.run.id)))!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'environment_preparation_failed');
    assert.equal(
      failed.failureAttemptId,
      null,
      'there is genuinely no attempt to point at, and an older closed one would misattribute it',
    );
    assert.equal(
      (await run(fixture.runs.findAttempt(created.attempt.id)))!.status,
      'failed',
      'the already-closed attempt is left exactly as it was',
    );
  } finally {
    fixture.close();
  }
});
