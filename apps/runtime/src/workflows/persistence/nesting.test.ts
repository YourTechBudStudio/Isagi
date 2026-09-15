import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowWriteResult } from './outcomes.js';
import type { WorkflowRunRecord } from './records.js';
import {
  makeWorkflowPersistenceFixture,
  prepareClaim,
  run,
  type WorkflowPersistenceFixture,
} from './test-support.js';

/**
 * Nesting, at the transaction level.
 *
 * A graph definition is reusable structure; a frame is one invocation of it. This file drives that
 * distinction through the repository with no interpreter present, because the invariants are the
 * repository's: a child frame is linked reciprocally to the execution that opened it, its
 * completion fact is immutable once written, and the pin recorded against that fact is the pin that
 * *produced* the value — not whichever pin happened to commit it.
 */

const PIN_A = 'a'.repeat(64);
const PIN_B = 'b'.repeat(64);
const OWNER = 'worker-1';
const INCARNATION = 'incarnation-1';

function value<A>(result: WorkflowWriteResult<A>): A {
  assert.ok(result.ok, `expected a commit, got ${JSON.stringify(result)}`);
  return result.value;
}

function rejection<A>(result: WorkflowWriteResult<A>) {
  assert.ok(!result.ok, `expected a rejection, got ${JSON.stringify(result)}`);
  return result.rejection;
}

function fence(runRecord: WorkflowRunRecord, attemptId: number) {
  return { runId: runRecord.id, attemptId, owner: OWNER, ownerIncarnation: INCARNATION };
}

const claimOf = async (fixture: WorkflowPersistenceFixture, runId: number) => {
  const current = (await run(fixture.runs.findRun(runId)))!;
  return {
    run: current,
    claimed: value(
      await run(
        fixture.runs.claimSegment({
          ...(await prepareClaim(fixture, current.id)),
          owner: OWNER,
          ownerIncarnation: INCARNATION,
        }),
      ),
    ),
  };
};

/**
 * Drives a run to the point where a child frame has published its output and the parent is parked
 * at `child_output_mapping`, which is the state every interesting assertion here is about.
 */
async function runToChildPublished(fixture: WorkflowPersistenceFixture) {
  fixture.seedArtifact(PIN_A);
  fixture.seedArtifact(PIN_B);
  const placement = fixture.seedPlacement();
  const created = value(
    await run(
      fixture.runs.createRun({
        workflowKey: 'fixture',
        title: 'Nested fixture',
        rootGraphKey: 'root',
        artifactHash: PIN_A,
        rootFrame: { graphKey: 'root' },
        origin: {
          worktreeId: placement.worktreeId,
          worktreePath: '/repo/fixture',
          surfaceId: placement.surfaceId,
          paneId: null,
          agentSessionId: null,
        },
        destination: {
          worktreeId: placement.worktreeId,
          worktreePath: '/repo/fixture',
          surfaceId: placement.surfaceId,
        },
        attachment: { worktreeId: placement.worktreeId, surfaceId: placement.surfaceId },
      }),
    ),
  );
  const runId = created.run.id;
  const rootFrameId = created.frame.id;

  // Root graph entry, dispatching into a subgraph node.
  const entry = await claimOf(fixture, runId);
  value(
    await run(
      fixture.runs.commitGraphEntry({
        ...fence(entry.run, entry.claimed.attempt.id),
        frameId: rootFrameId,
        state: { value: { rounds: 0 } },
        entryNode: { nodeId: 'review', nodeKind: 'subgraph' },
      }),
    ),
  );
  const parentExecutionId = (await run(fixture.runs.listExecutions(rootFrameId)))[0]!.id;

  // Opening the child runs no author code, so it allocates no attempt.
  const childFrameId = value(
    await run(fixture.runs.enterSubgraph({ runId, parentExecutionId, childGraphKey: 'child' })),
  ).childFrameId;

  // Child graph entry, then its one node, then routing to an outcome.
  const childEntry = await claimOf(fixture, runId);
  value(
    await run(
      fixture.runs.commitGraphEntry({
        ...fence(childEntry.run, childEntry.claimed.attempt.id),
        frameId: childFrameId,
        parameters: { value: { topic: 'draft' } },
        state: { value: { verdict: null } },
        entryNode: { nodeId: 'judge', nodeKind: 'operation' },
      }),
    ),
  );
  const childCallback = await claimOf(fixture, runId);
  value(
    await run(
      fixture.runs.commitNodeResult({
        ...fence(childCallback.run, childCallback.claimed.attempt.id),
        frameId: childFrameId,
        executionId: childCallback.claimed.attempt.executionId!,
        state: { value: { verdict: 'pass' } },
        producerOutput: { value: { update: { verdict: 'pass' } } },
        producerArtifactHash: PIN_A,
        next: { kind: 'routing', edgeId: 'judge-out' },
      }),
    ),
  );
  const childRouting = await claimOf(fixture, runId);
  value(
    await run(
      fixture.runs.commitRouting({
        ...fence(childRouting.run, childRouting.claimed.attempt.id),
        frameId: childFrameId,
        executionId: childRouting.claimed.attempt.executionId!,
        state: { value: { verdict: 'pass' } },
        producerOutput: { value: { to: 'complete' } },
        producerArtifactHash: PIN_A,
        next: { kind: 'outcome', outcomeId: 'complete' },
      }),
    ),
  );

  // The child's output, evaluated and published under pin A.
  const childOutput = await claimOf(fixture, runId);
  value(
    await run(
      fixture.runs.publishChildOutput({
        ...fence(childOutput.run, childOutput.claimed.attempt.id),
        frameId: childFrameId,
        outcomeId: 'complete',
        outcomeKind: 'success',
        outcomeReason: 'approved',
        output: { value: { verdict: 'pass' } },
        outputArtifactHash: PIN_A,
      }),
    ),
  );

  return { runId, rootFrameId, parentExecutionId, childFrameId };
}

test('a child frame is linked reciprocally to the execution that opened it', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const scenario = await runToChildPublished(fixture);

    const child = (await run(fixture.runs.findFrame(scenario.childFrameId)))!;
    const parent = (await run(fixture.runs.findExecution(scenario.parentExecutionId)))!;
    assert.equal(child.parentExecutionId, parent.id);
    assert.equal(parent.childFrameId, child.id);
    assert.equal(child.depth, 1, 'a child sits one level below the frame that invoked it');
    assert.equal(child.graphKey, 'child');

    // The subgraph node's execution stays open across the child's whole lifetime — it is not
    // finished until the child's output has been mapped back through it.
    assert.equal(parent.status, 'mapping');
    assert.equal(parent.endedAt, null);

    // Parameters are the child's own, written by the child's graph-entry commit rather than by the
    // transaction that opened the frame.
    assert.deepEqual(await run(fixture.payloads.resolve(child.parameters!)), { topic: 'draft' });
  } finally {
    fixture.close();
  }
});

test('opening a child twice adopts the frame that exists rather than opening a second', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    fixture.seedArtifact(PIN_A);
    const placement = fixture.seedPlacement();
    const created = value(
      await run(
        fixture.runs.createRun({
          workflowKey: 'fixture',
          title: 'Nested fixture',
          rootGraphKey: 'root',
          artifactHash: PIN_A,
          rootFrame: { graphKey: 'root' },
          origin: {
            worktreeId: placement.worktreeId,
            worktreePath: '/repo/fixture',
            surfaceId: placement.surfaceId,
            paneId: null,
            agentSessionId: null,
          },
          destination: {
            worktreeId: placement.worktreeId,
            worktreePath: '/repo/fixture',
            surfaceId: placement.surfaceId,
          },
          attachment: { worktreeId: placement.worktreeId, surfaceId: placement.surfaceId },
        }),
      ),
    );
    const entry = await claimOf(fixture, created.run.id);
    value(
      await run(
        fixture.runs.commitGraphEntry({
          ...fence(entry.run, entry.claimed.attempt.id),
          frameId: created.frame.id,
          state: { value: {} },
          entryNode: { nodeId: 'review', nodeKind: 'subgraph' },
        }),
      ),
    );
    const parentExecutionId = (await run(fixture.runs.listExecutions(created.frame.id)))[0]!.id;

    const first = value(
      await run(
        fixture.runs.enterSubgraph({
          runId: created.run.id,
          parentExecutionId,
          childGraphKey: 'child',
        }),
      ),
    );
    const revisionAfterFirst = (await run(fixture.runs.findRun(created.run.id)))!.revision;

    // A crash between the frame insert and the position write leaves the run pointing at the
    // parent's `node_callback` with a child frame already created. Re-entry must adopt it.
    fixture.client.prepare('UPDATE workflow_runs SET position_json = ? WHERE id = ?').run(
      JSON.stringify({
        kind: 'node_callback',
        frameId: created.frame.id,
        executionId: parentExecutionId,
      }),
      created.run.id,
    );

    const second = value(
      await run(
        fixture.runs.enterSubgraph({
          runId: created.run.id,
          parentExecutionId,
          childGraphKey: 'child',
        }),
      ),
    );
    assert.equal(second.childFrameId, first.childFrameId, 'the same frame, adopted');
    assert.equal(
      (await run(fixture.runs.listFrames(created.run.id))).length,
      2,
      'a root and one child — never a duplicate child',
    );
    // Safe idempotent replay still records that the dispatch happened again; what it must not do is
    // create a second frame.
    assert.equal(
      (await run(fixture.runs.findRun(created.run.id)))!.revision,
      revisionAfterFirst + 1,
    );

    // A stale parent, on the other hand, is a rejection rather than a replay.
    const stale = await run(
      fixture.runs.enterSubgraph({
        runId: created.run.id,
        parentExecutionId: parentExecutionId + 500,
        childGraphKey: 'child',
      }),
    );
    assert.deepEqual(rejection(stale), { kind: 'position_mismatch' });
    assert.equal((await run(fixture.runs.listFrames(created.run.id))).length, 2);
  } finally {
    fixture.close();
  }
});

test("a child's completion fact is immutable, and keeps the pin that produced it", async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const scenario = await runToChildPublished(fixture);

    const published = (await run(fixture.runs.findFrame(scenario.childFrameId)))!;
    assert.equal(published.status, 'completed');
    assert.equal(published.outcomeId, 'complete');
    assert.equal(published.outcomeKind, 'success');
    assert.equal(published.outcomeReason, 'approved');
    assert.equal(published.outputArtifactHash, PIN_A);
    assert.deepEqual(await run(fixture.payloads.resolve(published.output!)), { verdict: 'pass' });

    const current = (await run(fixture.runs.findRun(scenario.runId)))!;
    assert.equal(current.position.kind, 'child_output_mapping');
    assert.ok(current.position.kind === 'child_output_mapping');
    assert.equal(current.position.childFrameId, scenario.childFrameId);
    assert.equal(current.position.executionId, scenario.parentExecutionId);

    // The parent's mapping fails, and the run is retried under a different pin. The child is not
    // re-entered and its output is not recomputed — editing child code and retrying the parent
    // cannot change a fact the child already committed.
    const mapping = await claimOf(fixture, scenario.runId);
    value(
      await run(
        fixture.runs.failSegment({
          ...fence(mapping.run, mapping.claimed.attempt.id),
          code: 'output_mapping_failed',
          message: 'onResult threw',
        }),
      ),
    );
    const failed = (await run(fixture.runs.findRun(scenario.runId)))!;
    value(
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

    const afterRetry = (await run(fixture.runs.findFrame(scenario.childFrameId)))!;
    assert.deepEqual(afterRetry, published, 'byte-identical: nothing about the child moved');
    assert.equal(
      afterRetry.outputArtifactHash,
      PIN_A,
      'the producing pin survives a retry under a different pin',
    );
    assert.equal((await run(fixture.runs.findRun(scenario.runId)))!.artifactHash, PIN_B);
  } finally {
    fixture.close();
  }
});

test('mapping a completed child returns the parent to routing', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const scenario = await runToChildPublished(fixture);
    const mapping = await claimOf(fixture, scenario.runId);
    assert.equal(mapping.claimed.attempt.segmentKind, 'output_mapping');
    assert.equal(mapping.claimed.attempt.executionId, scenario.parentExecutionId);

    value(
      await run(
        fixture.runs.commitOutputMapping({
          ...fence(mapping.run, mapping.claimed.attempt.id),
          parentFrameId: scenario.rootFrameId,
          parentExecutionId: scenario.parentExecutionId,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { update: { rounds: 1 } } },
          producerArtifactHash: PIN_A,
          edgeId: 'review-out',
        }),
      ),
    );

    const after = (await run(fixture.runs.findRun(scenario.runId)))!;
    assert.equal(after.position.kind, 'routing');
    assert.ok(after.position.kind === 'routing');
    assert.equal(after.position.executionId, scenario.parentExecutionId);
    assert.equal(after.position.edgeId, 'review-out');

    const parentFrame = (await run(fixture.runs.findFrame(scenario.rootFrameId)))!;
    assert.deepEqual(await run(fixture.payloads.resolve(parentFrame.state!)), { rounds: 1 });
    const parent = (await run(fixture.runs.findExecution(scenario.parentExecutionId)))!;
    assert.equal(parent.status, 'routing', 'the subgraph execution is finally routable');
  } finally {
    fixture.close();
  }
});

test('a root finishes only through completeRun, and a child only through publishChildOutput', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const scenario = await runToChildPublished(fixture);

    // Map the child back and route the parent to its own outcome, so the run is parked at the
    // root's `graph_output`.
    const mapping = await claimOf(fixture, scenario.runId);
    value(
      await run(
        fixture.runs.commitOutputMapping({
          ...fence(mapping.run, mapping.claimed.attempt.id),
          parentFrameId: scenario.rootFrameId,
          parentExecutionId: scenario.parentExecutionId,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { update: { rounds: 1 } } },
          producerArtifactHash: PIN_A,
          edgeId: 'review-out',
        }),
      ),
    );
    const routing = await claimOf(fixture, scenario.runId);
    value(
      await run(
        fixture.runs.commitRouting({
          ...fence(routing.run, routing.claimed.attempt.id),
          frameId: scenario.rootFrameId,
          executionId: scenario.parentExecutionId,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { to: 'delivered' } },
          producerArtifactHash: PIN_A,
          next: { kind: 'outcome', outcomeId: 'delivered' },
        }),
      ),
    );

    const output = await claimOf(fixture, scenario.runId);
    const before = {
      frame: (await run(fixture.runs.findFrame(scenario.rootFrameId)))!,
      run: (await run(fixture.runs.findRun(scenario.runId)))!,
    };

    // The root refused through the child path. Publishing it here would complete the frame and
    // leave the run still asking for an output it already has.
    const refusedRoot = await run(
      fixture.runs.publishChildOutput({
        ...fence(output.run, output.claimed.attempt.id),
        frameId: scenario.rootFrameId,
        outcomeId: 'delivered',
        outcomeKind: 'success',
        output: { value: { rounds: 1 } },
        outputArtifactHash: PIN_A,
      }),
    );
    assert.deepEqual(rejection(refusedRoot), { kind: 'frame_role_mismatch', expected: 'child' });
    assert.deepEqual(
      (await run(fixture.runs.findFrame(scenario.rootFrameId)))!,
      before.frame,
      'a refusal writes nothing to the frame',
    );
    const afterRefusal = (await run(fixture.runs.findRun(scenario.runId)))!;
    assert.equal(afterRefusal.status, before.run.status);
    assert.deepEqual(afterRefusal.position, before.run.position);
    assert.equal(afterRefusal.revision, before.run.revision, 'and no history');

    // And the mirror: a child refused through the root path, which would strand its ancestors.
    const refusedChild = await run(
      fixture.runs.completeRun({
        ...fence(output.run, output.claimed.attempt.id),
        frameId: scenario.childFrameId,
        outcomeId: 'complete',
        outcomeKind: 'success',
        output: { value: { verdict: 'pass' } },
        outputArtifactHash: PIN_A,
      }),
    );
    // The saved position names the root's outcome, so the child is refused on position before its
    // role is even considered — both guards run before anything is written.
    assert.deepEqual(rejection(refusedChild), { kind: 'position_mismatch' });

    // The root through its own transaction succeeds.
    value(
      await run(
        fixture.runs.completeRun({
          ...fence(output.run, output.claimed.attempt.id),
          frameId: scenario.rootFrameId,
          outcomeId: 'delivered',
          outcomeKind: 'success',
          output: { value: { rounds: 1 } },
          outputArtifactHash: PIN_A,
        }),
      ),
    );
    const done = (await run(fixture.runs.findRun(scenario.runId)))!;
    assert.equal(done.status, 'done');
    assert.equal(done.outcomeId, 'delivered');
    assert.equal(done.outcomeKind, 'success');
    assert.deepEqual(await run(fixture.payloads.resolve(done.output!)), { rounds: 1 });
    assert.equal(done.position.kind, 'terminal');
    assert.equal(done.activeFrameId, null);
    assert.ok(done.endedAt);
    assert.equal((await run(fixture.runs.findFrame(scenario.rootFrameId)))!.status, 'completed');
  } finally {
    fixture.close();
  }
});

test('completing a run closes an open pause band', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const scenario = await runToChildPublished(fixture);
    const mapping = await claimOf(fixture, scenario.runId);
    value(
      await run(
        fixture.runs.commitOutputMapping({
          ...fence(mapping.run, mapping.claimed.attempt.id),
          parentFrameId: scenario.rootFrameId,
          parentExecutionId: scenario.parentExecutionId,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { update: { rounds: 1 } } },
          producerArtifactHash: PIN_A,
          edgeId: 'review-out',
        }),
      ),
    );
    const routing = await claimOf(fixture, scenario.runId);
    value(
      await run(
        fixture.runs.commitRouting({
          ...fence(routing.run, routing.claimed.attempt.id),
          frameId: scenario.rootFrameId,
          executionId: scenario.parentExecutionId,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { to: 'delivered' } },
          producerArtifactHash: PIN_A,
          next: { kind: 'outcome', outcomeId: 'delivered' },
        }),
      ),
    );
    const output = await claimOf(fixture, scenario.runId);

    // Pause lands mid-callback: it gates the next claim but cannot stop this one from committing.
    const running = (await run(fixture.runs.findRun(scenario.runId)))!;
    value(
      await run(
        fixture.runs.applyPause({ runId: running.id, controlRevision: running.controlRevision }),
      ),
    );
    assert.equal(
      (await run(fixture.runs.listPauseIntervals(scenario.runId))).filter(
        (interval) => interval.resumedAt === null,
      ).length,
      1,
    );

    value(
      await run(
        fixture.runs.completeRun({
          ...fence(output.run, output.claimed.attempt.id),
          frameId: scenario.rootFrameId,
          outcomeId: 'delivered',
          outcomeKind: 'success',
          output: { value: { rounds: 1 } },
          outputArtifactHash: PIN_A,
        }),
      ),
    );

    const intervals = await run(fixture.runs.listPauseIntervals(scenario.runId));
    assert.ok(
      intervals.every((interval) => interval.resumedAt !== null),
      'no waterfall band is left open past a finished run',
    );
  } finally {
    fixture.close();
  }
});

test('a cancelled run cannot open a child frame, and nothing about it moves', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    fixture.seedArtifact(PIN_A);
    const placement = fixture.seedPlacement();
    const created = value(
      await run(
        fixture.runs.createRun({
          workflowKey: 'fixture',
          title: 'Nested fixture',
          rootGraphKey: 'root',
          artifactHash: PIN_A,
          rootFrame: { graphKey: 'root' },
          origin: {
            worktreeId: placement.worktreeId,
            worktreePath: '/repo/fixture',
            surfaceId: placement.surfaceId,
            paneId: null,
            agentSessionId: null,
          },
          destination: {
            worktreeId: placement.worktreeId,
            worktreePath: '/repo/fixture',
            surfaceId: placement.surfaceId,
          },
          attachment: { worktreeId: placement.worktreeId, surfaceId: placement.surfaceId },
        }),
      ),
    );
    const entry = await claimOf(fixture, created.run.id);
    value(
      await run(
        fixture.runs.commitGraphEntry({
          ...fence(entry.run, entry.claimed.attempt.id),
          frameId: created.frame.id,
          state: { value: {} },
          entryNode: { nodeId: 'review', nodeKind: 'subgraph' },
        }),
      ),
    );
    const parentExecutionId = (await run(fixture.runs.listExecutions(created.frame.id)))[0]!.id;

    const running = (await run(fixture.runs.findRun(created.run.id)))!;
    value(
      await run(
        fixture.runs.applyCancel({ runId: running.id, controlRevision: running.controlRevision }),
      ),
    );
    const before = {
      run: (await run(fixture.runs.findRun(created.run.id)))!,
      frames: await run(fixture.runs.listFrames(created.run.id)),
      parent: (await run(fixture.runs.findExecution(parentExecutionId)))!,
    };

    // Opening a child frame is a graph advance, and Cancel revokes permission to advance. Nothing
    // was produced here, so unlike a callback's result there is no evidence to retain either.
    const refused = await run(
      fixture.runs.enterSubgraph({
        runId: created.run.id,
        parentExecutionId,
        childGraphKey: 'child',
      }),
    );
    assert.deepEqual(rejection(refused), { kind: 'run_terminal', status: 'cancelled' });

    const after = (await run(fixture.runs.findRun(created.run.id)))!;
    assert.deepEqual(await run(fixture.runs.listFrames(created.run.id)), before.frames);
    assert.equal(
      (await run(fixture.runs.listFrames(created.run.id))).length,
      1,
      'no child frame was created',
    );
    assert.deepEqual(await run(fixture.runs.findExecution(parentExecutionId)), before.parent);
    assert.equal(after.status, 'cancelled', 'the cancelled run is preserved');
    assert.deepEqual(after.position, before.run.position, 'and the position did not advance');
    assert.equal(after.revision, before.run.revision, 'and no transition was appended');
  } finally {
    fixture.close();
  }
});
