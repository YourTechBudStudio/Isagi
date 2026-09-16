import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import type { WorkflowEngineError } from '../types.js';
import {
  claim,
  currentRun,
  enterRoot,
  fence,
  makeReadHarness,
  PIN_A,
  PIN_B,
  run,
  startRun,
  value,
  type ReadHarness,
} from './test-support.js';

/**
 * What the retained read model says about records the engine actually wrote.
 *
 * The distinctions asserted here are the ones the whole story rests on: a definition address is not
 * a frame and a frame is not a visit; the pin a run is on now is not the pin a visit ran under and
 * not the pin that produced an operand; an absent value, a recorded JSON `null` and an unreadable
 * one are three different answers. Every one of them is easy to collapse by accident and impossible
 * to notice afterwards.
 */

async function withHarness(body: (harness: ReadHarness) => Promise<void>) {
  const harness = makeReadHarness();
  try {
    await body(harness);
  } finally {
    harness.close();
  }
}

/** Runs a read and fails the test if it rejected. */
function read<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, never>);
}

/** Runs a read that is expected to be refused, and returns the rejection. */
async function rejection(effect: Effect.Effect<unknown, unknown>) {
  const result = await Effect.runPromise(Effect.either(effect));
  assert.ok(result._tag === 'Left', 'expected the read to be refused');
  return result.left as WorkflowEngineError;
}

test('a run summary reports where the run is, which pin it is on, and what it will accept', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });

    const { run: summary } = await read(harness.projection.getRun(runId));
    assert.equal(summary.runId, runId);
    assert.equal(summary.status, 'ready');
    assert.equal(summary.artifactHash, PIN_A);
    assert.equal(summary.pinOrdinal, 1, 'the launch adoption is the first pin');
    assert.deepEqual(summary.position, {
      kind: 'node_callback',
      frameId: rootFrameId,
      executionId: execution.id,
    });
    assert.equal(summary.activeNode?.nodeId, 'writer');
    assert.equal(summary.activeNode?.visitIndex, 0);
    assert.equal(summary.destination.available, true);
    assert.ok(summary.attachment !== null);
    assert.deepEqual(summary.controls, {
      pause: true,
      resume: false,
      retry: false,
      cancel: true,
      dismiss: false,
      advance: false,
    });
    assert.equal(
      summary.stopSummary,
      null,
      'nothing was asked to stop, which is not "all confirmed"',
    );
  });
});

test('a cancelled run stays listed and inspectable, and only Dismiss releases its surface', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId, placement } = await startRun(harness.fixture);
    await enterRoot(harness.fixture, { runId, frameId: rootFrameId, nodeId: 'writer' });
    const before = await currentRun(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.applyCancel({ runId, controlRevision: before.controlRevision }),
      ),
    );

    const cancelled = (await read(harness.projection.getRun(runId))).run;
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(cancelled.controls, {
      pause: false,
      resume: false,
      retry: false,
      cancel: false,
      dismiss: true,
      advance: false,
    });
    assert.ok(
      cancelled.attachment !== null,
      'a stopped run keeps its surface until it is dismissed',
    );

    const afterCancel = await currentRun(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.detachRun({ runId, controlRevision: afterCancel.controlRevision }),
      ),
    );

    const dismissed = (await read(harness.projection.getRun(runId))).run;
    assert.equal(dismissed.attachment, null);
    assert.equal(dismissed.controls.dismiss, false, 'there is nothing left to release');

    // Retained listings: the run is still reachable globally and by workflow key after it stopped
    // occupying anything, and an attachment filter no longer finds it.
    const all = await read(harness.projection.listRuns({}));
    assert.deepEqual(
      all.items.map((item) => item.runId),
      [runId],
    );
    const byKey = await read(harness.projection.listRuns({ workflowKey: 'fixture' }));
    assert.equal(byKey.items.length, 1);
    const attached = await read(
      harness.projection.listRuns({ attachedSurfaceId: placement.surfaceId }),
    );
    assert.deepEqual(attached.items, []);
  });
});

test('a run whose environment was deleted is still listed, with its placement reported as gone', async () => {
  await withHarness(async (harness) => {
    const { runId, placement } = await startRun(harness.fixture);
    harness.fixture.client.prepare('DELETE FROM worktrees WHERE id = ?').run(placement.worktreeId);
    await run(
      harness.fixture.runs.applyEnvironmentAvailability({
        runIds: [runId],
        available: false,
        detail: { value: { control: 'environment_deleted' } },
      }),
    );

    const summary = (await read(harness.projection.getRun(runId))).run;
    assert.equal(summary.destination.available, false);
    assert.equal(
      summary.destination.worktreeId,
      placement.worktreeId,
      'provenance outlives the row',
    );
    assert.equal(summary.attachment, null, 'the attachment cascaded with the worktree');
    assert.equal(summary.paused, true);
    const listed = await read(harness.projection.listRuns({}));
    assert.equal(listed.items.length, 1, 'retained listing survives environment deletion');
  });
});

test('two visits to one node are two executions, and a reused graph is two frames', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const first = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });

    // writer → routing → writer again.
    const callback = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitNodeResult({
          ...fence(runId, callback.attempt.id),
          frameId: rootFrameId,
          executionId: first.id,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { type: 'complete', update: { rounds: 1 } } },
          producerArtifactHash: PIN_A,
          next: { kind: 'routing', edgeId: 'writer-out' },
        }),
      ),
    );
    const routing = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitRouting({
          ...fence(runId, routing.attempt.id),
          frameId: rootFrameId,
          executionId: first.id,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { to: 'writer', update: { rounds: 1 } } },
          producerArtifactHash: PIN_A,
          next: { kind: 'node', nodeId: 'writer', nodeKind: 'operation' },
        }),
      ),
    );

    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    const visits = executions.items.filter((item) => item.nodeId === 'writer');
    assert.deepEqual(
      visits.map((visit) => visit.visitIndex),
      [0, 1],
      'a loop back creates a second visit rather than reopening the first',
    );
    assert.equal(new Set(visits.map((visit) => visit.executionId)).size, 2);
    assert.equal(visits[0]!.status, 'completed');
    assert.equal(
      visits[1]!.attemptCount,
      0,
      'a dispatched visit has no attempt until one is claimed',
    );

    // The routing segment is its own record with its own decision, bar and identity.
    assert.deepEqual(
      {
        edgeId: visits[0]!.routing?.edgeId,
        chosen: visits[0]!.routing?.chosen,
        updateRef: visits[0]!.routing?.updateRef,
      },
      { edgeId: 'writer-out', chosen: 'writer', updateRef: { inline: { rounds: 1 } } },
    );
    assert.equal(visits[1]!.routing, null);

    // Data slots: the boundary the visit read, the candidate it produced, and the boundary it wrote.
    assert.deepEqual(visits[0]!.stateInRef, { inline: { rounds: 0 } });
    assert.deepEqual(visits[0]!.candidateRef, {
      inline: { type: 'complete', update: { rounds: 1 } },
    });
    assert.deepEqual(visits[0]!.updateRef, { inline: { rounds: 1 } });
    assert.deepEqual(visits[0]!.stateOutRef, { inline: { rounds: 1 } });
  });
});

test('a repaired visit keeps its own history: first pin, latest pin, and what fixed it', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });

    const failing = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.failSegment({
          ...fence(runId, failing.attempt.id),
          code: 'node_callback_failed',
          message: 'the writer threw',
          detail: { value: { stack: 'x' } },
        }),
      ),
    );

    const failed = (await read(harness.projection.getRun(runId))).run;
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.controls.retry, true);
    assert.equal(failed.failure?.code, 'node_callback_failed');
    assert.equal(failed.failure?.executionId, execution.id);

    // A Retry adopts a second pin, and the repaired attempt runs under it.
    const before = await currentRun(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.adoptRetryPin({
          runId,
          controlRevision: before.controlRevision,
          artifactHash: PIN_B,
          expectedPosition: before.position,
          expectedOwner: before.owner,
        }),
      ),
    );
    const repaired = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitNodeResult({
          ...fence(runId, repaired.attempt.id),
          frameId: rootFrameId,
          executionId: execution.id,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { type: 'complete', update: { rounds: 1 } } },
          producerArtifactHash: PIN_B,
          next: { kind: 'routing', edgeId: 'writer-out' },
        }),
      ),
    );

    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    const visit = executions.items.find((item) => item.executionId === execution.id)!;
    assert.equal(visit.firstArtifactHash, PIN_A);
    assert.equal(
      visit.latestArtifactHash,
      PIN_B,
      'a visit repaired under a later pin reads v1 → v2',
    );
    assert.equal(visit.latestAttempt?.status, 'succeeded');
    assert.equal(visit.latestAttempt?.invocationKind, 'retry');
    assert.equal(visit.latestAttempt?.failure, null);
    assert.equal(visit.attemptCount, 2);
    assert.deepEqual(
      visit.priorFailures.map((failure) => ({
        code: failure.failure.code,
        artifactHash: failure.artifactHash,
        repairedByAttemptIndex: failure.repairedByAttemptIndex,
        repairedByArtifactHash: failure.repairedByArtifactHash,
      })),
      [
        {
          code: 'node_callback_failed',
          artifactHash: PIN_A,
          repairedByAttemptIndex: 2,
          repairedByArtifactHash: PIN_B,
        },
      ],
      'a repaired step still explains what went wrong and what fixed it',
    );

    const summary = (await read(harness.projection.getRun(runId))).run;
    assert.equal(summary.pinOrdinal, 2);
    assert.equal(summary.artifactHash, PIN_B);

    // The old version is still readable, and reading it imports nothing.
    const versions = await read(harness.projection.listVersions(runId, {}));
    assert.deepEqual(
      versions.items.map((version) => [
        version.pinOrdinal,
        version.artifactHash,
        version.adoptedBy,
      ]),
      [
        [1, PIN_A, 'launch'],
        [2, PIN_B, 'retry'],
      ],
    );
  });
});

test('a saved producer result is reported as reusable, and names the pin that produced it', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const attempt = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.captureProducerOutput({
          ...fence(runId, attempt.attempt.id),
          producerOutput: { value: { type: 'complete', update: { rounds: 1 } } },
          producerArtifactHash: PIN_A,
        }),
      ),
    );
    value(
      await run(
        harness.fixture.runs.failSegment({
          ...fence(runId, attempt.attempt.id),
          code: 'reduction_failed',
          message: 'the reducer refused the update',
        }),
      ),
    );

    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    const visit = executions.items.find((item) => item.executionId === execution.id)!;
    assert.equal(visit.latestAttempt?.recoveryMode, 'reuse_producer_output');
    assert.equal(visit.latestAttempt?.producerArtifactHash, PIN_A);

    const attempts = await read(
      harness.projection.listAttempts(runId, { executionId: execution.id }),
    );
    assert.equal(attempts.items[0]!.recoveryMode, 'reuse_producer_output');
    assert.deepEqual(attempts.items[0]!.producerOutputRef, {
      inline: { type: 'complete', update: { rounds: 1 } },
    });
  });
});

test('frame-owned attempts have no execution, and are reachable by frame and by id', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    await enterRoot(harness.fixture, { runId, frameId: rootFrameId, nodeId: 'writer' });

    const byFrame = await read(
      harness.projection.listAttempts(runId, { frameId: rootFrameId, segmentKind: 'graph_entry' }),
    );
    assert.equal(byFrame.items.length, 1);
    const entry = byFrame.items[0]!;
    assert.equal(entry.executionId, null, 'graph entry belongs to the frame, not to a node');
    assert.equal(entry.segmentKind, 'graph_entry');

    const direct = await read(harness.projection.getAttempt(runId, entry.attemptId));
    assert.deepEqual(direct.attempt, entry);
  });
});

test('an attempt, a frame and a payload from another run are all refused', async () => {
  await withHarness(async (harness) => {
    const first = await startRun(harness.fixture, { workflowKey: 'first' });
    const second = await startRun(harness.fixture, { workflowKey: 'second' });
    await enterRoot(harness.fixture, {
      runId: first.runId,
      frameId: first.rootFrameId,
      nodeId: 'writer',
    });

    const attempts = await read(harness.projection.listAttempts(first.runId, {}));
    const foreign = await rejection(
      harness.projection.getAttempt(second.runId, attempts.items[0]!.attemptId),
    );
    assert.equal(foreign.code, 'workflow_run_not_found');

    const frames = await rejection(
      harness.projection.listFrameExecutions(second.runId, first.rootFrameId, {}),
    );
    assert.equal(frames.code, 'workflow_run_not_found');
  });
});

test('a large recorded value travels as a sized reference and is fetched by the run that recorded it', async () => {
  await withHarness(async (harness) => {
    const first = await startRun(harness.fixture, { workflowKey: 'first' });
    const second = await startRun(harness.fixture, { workflowKey: 'second' });
    const execution = await enterRoot(harness.fixture, {
      runId: first.runId,
      frameId: first.rootFrameId,
      nodeId: 'writer',
    });
    const attempt = await claim(harness.fixture, first.runId);
    const document = 'x'.repeat(9000);
    value(
      await run(
        harness.fixture.runs.commitNodeResult({
          ...fence(first.runId, attempt.attempt.id),
          frameId: first.rootFrameId,
          executionId: execution.id,
          state: { value: { document } },
          producerOutput: { value: { type: 'complete', update: { document } } },
          producerArtifactHash: PIN_A,
          next: { kind: 'routing', edgeId: 'writer-out' },
        }),
      ),
    );

    const executions = await read(harness.projection.listRunExecutions(first.runId, {}));
    const visit = executions.items.find((item) => item.executionId === execution.id)!;
    const candidate = visit.candidateRef as {
      payloadRef: string;
      byteSize: number;
      mediaType: string;
    };
    assert.ok(candidate.payloadRef.startsWith('sha256:'), 'clients get an opaque reference');
    assert.ok(candidate.byteSize > 9000, 'and a size they can show before fetching');
    assert.equal(candidate.mediaType, 'application/json');
    assert.ok(
      !JSON.stringify(visit).includes(harness.fixture.root),
      'no filesystem path reaches the wire',
    );
    assert.equal(
      visit.updateRef,
      null,
      'an out-of-line operand is not taken apart: the whole candidate stays fetchable instead',
    );

    const payload = await read(harness.projection.getPayload(first.runId, candidate.payloadRef));
    assert.deepEqual(payload.value, { type: 'complete', update: { document } });
    assert.equal(payload.byteSize, candidate.byteSize);

    const foreign = await rejection(
      harness.projection.getPayload(second.runId, candidate.payloadRef),
    );
    assert.equal(foreign.code, 'workflow_payload_unavailable');
    assert.equal(foreign.payloadCause, 'missing');
  });
});

test('an unreadable payload is distinguishable from one that was never produced', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const attempt = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitNodeResult({
          ...fence(runId, attempt.attempt.id),
          frameId: rootFrameId,
          executionId: execution.id,
          // A recorded JSON `null` is a produced value, and stays one all the way to the wire.
          state: { value: null },
          producerOutput: { value: { type: 'complete', update: 'x'.repeat(9000) } },
          producerArtifactHash: PIN_A,
          next: { kind: 'routing', edgeId: 'writer-out' },
        }),
      ),
    );

    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    const visit = executions.items.find((item) => item.executionId === execution.id)!;
    assert.deepEqual(visit.stateOutRef, { inline: null }, 'a recorded null is not an absence');
    assert.equal(visit.wait, null, 'a value that was never produced is absent, not null');

    const ref = (visit.candidateRef as { payloadRef: string }).payloadRef;
    await rm(join(harness.fixture.root, 'workflow-payloads'), { recursive: true, force: true });
    const missing = await rejection(harness.projection.getPayload(runId, ref));
    assert.equal(missing.code, 'workflow_payload_unavailable');
    assert.equal(missing.payloadCause, 'missing');
  });
});

test('a human gate keeps the operations its visit already performed', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const attempt = await claim(harness.fixture, runId);

    const spawn = value(
      await run(
        harness.fixture.operations.recordIntent({
          runId,
          frameId: rootFrameId,
          executionId: execution.id,
          originAttemptId: attempt.attempt.id,
          capability: 'spawn_agent_session',
          callIndex: 0,
          request: { value: { harness: 'claude' } },
          fingerprintOf: { value: { harness: 'claude' } },
          artifactHash: PIN_A,
        }),
      ),
    );
    value(
      await run(
        harness.fixture.operations.settle({
          operationId: spawn.id,
          state: 'completed',
          result: { value: { agentSessionId: 4 } },
        }),
      ),
    );
    const prompt = value(
      await run(
        harness.fixture.operations.recordIntent({
          runId,
          frameId: rootFrameId,
          executionId: execution.id,
          originAttemptId: attempt.attempt.id,
          capability: 'send_agent_prompt',
          callIndex: 1,
          request: { value: { prompt: 'write it' } },
          fingerprintOf: { value: { prompt: 'write it' } },
          artifactHash: PIN_A,
        }),
      ),
    );

    // The visit then suspends on a human gate.
    value(
      await run(
        harness.fixture.runs.commitNodeResult({
          ...fence(runId, attempt.attempt.id),
          frameId: rootFrameId,
          executionId: execution.id,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { type: 'suspend' } },
          producerArtifactHash: PIN_A,
          next: {
            kind: 'suspend',
            waitKind: 'user_input',
            condition: {
              value: {
                kind: 'user_input',
                label: 'Ship it?',
                questions: [{ kind: 'confirm', key: 'ship', label: 'Ship?' }],
              },
            },
          },
        }),
      ),
    );

    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    const visit = executions.items.find((item) => item.executionId === execution.id)!;
    assert.deepEqual(visit.operationSummary, {
      count: 2,
      unresolved: 1,
      capabilities: ['send_agent_prompt', 'spawn_agent_session'],
    });
    assert.equal(visit.wait?.kind, 'user_input');
    assert.equal(visit.wait?.status, 'armed');
    assert.deepEqual(visit.wait?.questions, [{ kind: 'confirm', key: 'ship', label: 'Ship?' }]);
    assert.ok(visit.waitArmedAt !== null);

    const operations = await read(
      harness.projection.listOperations(runId, { executionId: execution.id }),
    );
    assert.deepEqual(
      operations.items.map((operation) => [
        operation.callIndex,
        operation.capability,
        operation.state,
      ]),
      [
        [0, 'spawn_agent_session', 'completed'],
        [1, 'send_agent_prompt', 'intended'],
      ],
      'a waiting node does not hide what it already did',
    );
    assert.equal(operations.items[0]!.requestHash.length > 0, true);
    assert.deepEqual(operations.items[1]!.requestRef, { inline: { prompt: 'write it' } });
    assert.equal(operations.items[0]!.attemptId, attempt.attempt.id, 'provenance, not ownership');

    const summary = (await read(harness.projection.getRun(runId))).run;
    assert.equal(summary.status, 'waiting');
    assert.equal(summary.blockingWait?.waitId, visit.wait?.waitId);
    assert.deepEqual(summary.blockingWait?.questions, [
      { kind: 'confirm', key: 'ship', label: 'Ship?' },
    ]);
    assert.equal(summary.controls.advance, true);
    assert.equal(prompt.callIndex, 1);
  });
});

test('an uncertain operation blocks the run and is named, and Retry is not offered around it', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const attempt = await claim(harness.fixture, runId);
    const operation = value(
      await run(
        harness.fixture.operations.recordIntent({
          runId,
          frameId: rootFrameId,
          executionId: execution.id,
          originAttemptId: attempt.attempt.id,
          capability: 'run_headless_agent',
          callIndex: 0,
          request: { value: { prompt: 'judge it' } },
          fingerprintOf: { value: { prompt: 'judge it' } },
          artifactHash: PIN_A,
        }),
      ),
    );
    value(
      await run(
        harness.fixture.operations.settle({
          operationId: operation.id,
          state: 'uncertain',
          uncertaintyDetail: 'the capture owner is gone and no outcome was recorded',
        }),
      ),
    );
    value(await run(harness.fixture.runs.blockRun({ runId, operationId: operation.id })));

    const summary = (await read(harness.projection.getRun(runId))).run;
    assert.equal(summary.status, 'blocked');
    assert.deepEqual(summary.blockedOperation, {
      operationKey: operation.operationKey,
      frameId: rootFrameId,
      executionId: execution.id,
    });
    assert.equal(summary.controls.retry, false, 'unknown delivery is not overridable by Retry');

    const operations = await read(harness.projection.listOperations(runId, { state: 'uncertain' }));
    assert.equal(operations.items.length, 1);
    assert.equal(
      operations.items[0]!.uncertaintyDetail,
      'the capture owner is gone and no outcome was recorded',
    );
    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    assert.equal(executions.items[0]!.operationSummary.unresolved, 1);
  });
});

test('a subgraph visit carries its child frame inline and counts the work beneath it', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const parent = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'review',
      nodeKind: 'subgraph',
    });
    const before = await currentRun(harness.fixture, runId);
    const childFrameId = value(
      await run(
        harness.fixture.runs.enterSubgraph({
          runId,
          controlRevision: before.controlRevision,
          expectedPosition: before.position,
          artifactHash: PIN_A,
          parentExecutionId: parent.id,
          childGraphKey: 'review',
          childDisplayName: 'review round 0',
        }),
      ),
    ).childFrameId;
    const childEntry = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitGraphEntry({
          ...fence(runId, childEntry.attempt.id),
          frameId: childFrameId,
          parameters: { value: { draft: 'v1' } },
          state: { value: { verdict: null } },
          entryNode: { nodeId: 'judge', nodeKind: 'operation' },
        }),
      ),
    );
    const childExecution = (await run(harness.fixture.runs.listExecutions(childFrameId))).at(-1)!;
    const childCallback = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.operations.recordIntent({
          runId,
          frameId: childFrameId,
          executionId: childExecution.id,
          originAttemptId: childCallback.attempt.id,
          capability: 'run_headless_agent',
          callIndex: 0,
          request: { value: { prompt: 'judge' } },
          fingerprintOf: { value: { prompt: 'judge' } },
          artifactHash: PIN_A,
        }),
      ),
    );

    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    const subgraph = executions.items.find((item) => item.executionId === parent.id)!;
    assert.equal(subgraph.childFrameId, childFrameId);
    assert.equal(subgraph.childFrame?.graphKey, 'review');
    assert.equal(subgraph.childFrame?.displayName, 'review round 0');
    assert.equal(subgraph.childFrame?.depth, 1);
    assert.equal(subgraph.childFrame?.parentExecutionId, parent.id);
    assert.deepEqual(
      subgraph.operationSummary,
      { count: 1, unresolved: 1, capabilities: ['run_headless_agent'] },
      'a subgraph counts the operations beneath it without claiming it called them',
    );
    assert.equal(subgraph.attemptCount, 0, 'entering a subgraph runs no author callback');

    const child = executions.items.find((item) => item.executionId === childExecution.id)!;
    assert.equal(child.depth, 1);
    assert.equal(child.graphKey, 'review');
    assert.equal(child.parentExecutionId, parent.id);

    const frames = await read(
      harness.projection.listFrames(runId, { parentExecutionId: parent.id }),
    );
    assert.deepEqual(
      frames.items.map((frame) => frame.frameId),
      [childFrameId],
    );
    assert.equal(frames.items[0]!.executionCount, 1);
    assert.deepEqual(frames.items[0]!.parametersRef, { inline: { draft: 'v1' } });
  });
});

test('structure is served from the catalog, for the current pin and for an old one', async () => {
  await withHarness(async (harness) => {
    const { runId } = await startRun(harness.fixture);
    const current = await read(harness.projection.getStructure(runId, {}));
    assert.equal(current.artifactHash, PIN_A);
    assert.equal(current.pinOrdinal, 1);
    assert.equal(current.sdkVersion, '0.1.0');
    assert.deepEqual(current.descriptor, {} as never, 'the descriptor is the stored one, verbatim');

    const before = await currentRun(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.adoptRetryPin({
          runId,
          controlRevision: before.controlRevision,
          artifactHash: PIN_B,
          expectedPosition: before.position,
          expectedOwner: before.owner,
        }),
      ),
    );
    const now = await read(harness.projection.getStructure(runId, {}));
    assert.equal(now.artifactHash, PIN_B);
    assert.equal(now.pinOrdinal, 2);
    const old = await read(harness.projection.getStructure(runId, { artifactHash: PIN_A }));
    assert.equal(old.pinOrdinal, 1, 'an old definition stays readable at its own ordinal');

    const never = await rejection(
      harness.projection.getStructure(runId, { artifactHash: 'c'.repeat(64) }),
    );
    assert.equal(never.code, 'workflow_version_not_adopted');
  });
});

test('an unknown run is refused by every route that names one', async () => {
  await withHarness(async (harness) => {
    for (const effect of [
      harness.projection.getRun(404),
      harness.projection.getStructure(404, {}),
      harness.projection.listVersions(404, {}),
      harness.projection.listFrames(404, {}),
      harness.projection.listRunExecutions(404, {}),
      harness.projection.listAttempts(404, {}),
      harness.projection.getAttempt(404, 1),
      harness.projection.listOperations(404, {}),
      harness.projection.listEvents(404, {}),
      harness.projection.getPayload(404, 'sha256:whatever'),
      harness.projection.listFrameExecutions(404, 1, {}),
    ]) {
      const failure = await rejection(effect);
      assert.equal(failure.code, 'workflow_run_not_found');
    }
  });
});

test('a failed display name is a diagnostic on the row, never a failed segment', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    value(
      await run(
        harness.fixture.runs.appendDiagnostic({
          runId,
          kind: 'log',
          frameId: rootFrameId,
          executionId: execution.id,
          detail: {
            value: {
              source: 'runtime_diagnostic',
              code: 'label_failed',
              level: 'warning',
              message: "The display name for node 'writer' was not captured because it threw.",
            },
          },
        }),
      ),
    );

    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    const visit = executions.items.find((item) => item.executionId === execution.id)!;
    assert.equal(
      visit.labelDiagnostic,
      "The display name for node 'writer' was not captured because it threw.",
    );
    assert.equal(visit.displayName, null);
    assert.equal(visit.latestAttempt?.failure ?? null, null, 'the segment itself did not fail');
    const summary = (await read(harness.projection.getRun(runId))).run;
    assert.equal(summary.failure, null);
    assert.equal(summary.status, 'ready');
  });
});

test('a human answer is retained on the visit that asked for it', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const attempt = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitNodeResult({
          ...fence(runId, attempt.attempt.id),
          frameId: rootFrameId,
          executionId: execution.id,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { type: 'suspend' } },
          producerArtifactHash: PIN_A,
          next: {
            kind: 'suspend',
            waitKind: 'user_input',
            condition: {
              value: {
                kind: 'user_input',
                questions: [{ kind: 'confirm', key: 'ship', label: 'Ship?' }],
              },
            },
          },
        }),
      ),
    );
    const armed = (await run(harness.fixture.runs.listArmedWaits(runId)))[0]!;
    value(
      await run(
        harness.fixture.runs.consumeHumanWait({
          waitId: armed.id,
          event: { value: { kind: 'user_input', answers: { ship: true } } },
          edgeId: 'writer-out',
        }),
      ),
    );

    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    const visit = executions.items.find((item) => item.executionId === execution.id)!;
    assert.equal(
      visit.wait?.status,
      'delivered',
      'an answered gate is delivered until its router consumes it',
    );
    assert.deepEqual(visit.wait?.answers, { ship: true });
    assert.ok(visit.waitDeliveredAt !== null, 'the gate has both ends of its bar');
    assert.equal(visit.wait?.waitId, armed.id, 'the wait keeps its own identity in the record');
  });
});

test('adopting a new pin relabels nothing: old visits keep the pin they ran under', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const before = await currentRun(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.adoptRetryPin({
          runId,
          controlRevision: before.controlRevision,
          artifactHash: PIN_B,
          expectedPosition: before.position,
          expectedOwner: before.owner,
        }),
      ),
    );

    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    const visit = executions.items.find((item) => item.executionId === execution.id)!;
    assert.equal(
      visit.firstArtifactHash,
      PIN_A,
      'work already done is not re-attributed to new code',
    );
    const frames = await read(harness.projection.listFrames(runId, {}));
    assert.equal(frames.items[0]!.entryArtifactHash, PIN_A);
    const attempts = await read(harness.projection.listAttempts(runId, {}));
    assert.deepEqual(
      [...new Set(attempts.items.map((item) => item.artifactHash))],
      [PIN_A],
      'and neither are the attempts that produced it',
    );
    const summary = (await read(harness.projection.getRun(runId))).run;
    assert.equal(summary.artifactHash, PIN_B, 'only the run itself moved to the new pin');
    assert.equal(summary.pinOrdinal, 2);
  });
});

test('the listing can be narrowed to runs that still occupy a surface', async () => {
  await withHarness(async (harness) => {
    const kept = await startRun(harness.fixture, { workflowKey: 'kept' });
    const released = await startRun(harness.fixture, { workflowKey: 'released' });
    const before = await currentRun(harness.fixture, released.runId);
    value(
      await run(
        harness.fixture.runs.applyCancel({
          runId: released.runId,
          controlRevision: before.controlRevision,
        }),
      ),
    );
    const cancelled = await currentRun(harness.fixture, released.runId);
    value(
      await run(
        harness.fixture.runs.detachRun({
          runId: released.runId,
          controlRevision: cancelled.controlRevision,
        }),
      ),
    );

    const everything = await read(harness.projection.listRuns({}));
    assert.deepEqual(
      everything.items.map((item) => item.runId).sort(),
      [kept.runId, released.runId].sort(),
      'retention is the default: a dismissed run is still listed',
    );
    const occupying = await read(harness.projection.listRuns({ includeDismissed: false }));
    assert.deepEqual(
      occupying.items.map((item) => item.runId),
      [kept.runId],
    );
  });
});

test('a failed initialization is on the frame, with no node execution invented for it', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const attempt = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.failSegment({
          ...fence(runId, attempt.attempt.id),
          code: 'graph_init_failed',
          message: 'init threw',
          detail: { value: { stack: 'x' } },
        }),
      ),
    );

    const frames = await read(harness.projection.listFrames(runId, {}));
    const frame = frames.items[0]!;
    assert.equal(frame.status, 'initializing');
    assert.equal(frame.entry?.segmentKind, 'graph_entry');
    assert.equal(frame.entry?.segmentRef, null, 'graph entry has no reference of its own');
    assert.equal(frame.entry?.attemptCount, 1);
    assert.equal(frame.entry?.latestAttempt.failure?.code, 'graph_init_failed');
    assert.equal(frame.entry?.latestAttempt.recoveryMode, 'rerun_producer');
    assert.equal(frame.entry?.firstArtifactHash, PIN_A);
    assert.deepEqual(frame.entry?.priorFailures, []);
    assert.equal(frame.outputEvaluation, null, 'never attempted, which is not the same as failed');
    assert.equal(frame.output, null);

    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    assert.deepEqual(executions.items, [], 'no node visit is fabricated for a frame-owned segment');

    // The dock can say all of this without an attempts request; the attempts route stays available.
    const summary = (await read(harness.projection.getRun(runId))).run;
    assert.equal(summary.failure?.segmentKind, 'graph_entry');
    assert.equal(summary.failure?.executionId, null);
    assert.equal(summary.failure?.frameId, rootFrameId);
  });
});

test('a repaired initialization reads first pin → latest pin, and keeps what failed', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const first = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.failSegment({
          ...fence(runId, first.attempt.id),
          code: 'graph_init_failed',
          message: 'init threw',
        }),
      ),
    );
    const before = await currentRun(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.adoptRetryPin({
          runId,
          controlRevision: before.controlRevision,
          artifactHash: PIN_B,
          expectedPosition: before.position,
          expectedOwner: before.owner,
        }),
      ),
    );
    const repaired = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitGraphEntry({
          ...fence(runId, repaired.attempt.id),
          frameId: rootFrameId,
          state: { value: { rounds: 0 } },
          entryNode: { nodeId: 'writer', nodeKind: 'operation' },
        }),
      ),
    );

    const frames = await read(harness.projection.listFrames(runId, {}));
    const entry = frames.items[0]!.entry!;
    assert.equal(entry.attemptCount, 2);
    assert.equal(entry.firstArtifactHash, PIN_A);
    assert.equal(entry.latestArtifactHash, PIN_B);
    assert.equal(entry.latestAttempt.status, 'succeeded');
    assert.equal(entry.latestAttempt.invocationKind, 'retry');
    assert.deepEqual(
      entry.priorFailures.map((failure) => [
        failure.failure.code,
        failure.artifactHash,
        failure.repairedByArtifactHash,
      ]),
      [['graph_init_failed', PIN_A, PIN_B]],
    );
    assert.equal(frames.items[0]!.status, 'active');
  });
});

test('an output evaluation that failed exists before the output it would publish does', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const execution = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const callback = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitNodeResult({
          ...fence(runId, callback.attempt.id),
          frameId: rootFrameId,
          executionId: execution.id,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { type: 'complete' } },
          producerArtifactHash: PIN_A,
          next: { kind: 'routing', edgeId: 'writer-out' },
        }),
      ),
    );
    const routing = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.commitRouting({
          ...fence(runId, routing.attempt.id),
          frameId: rootFrameId,
          executionId: execution.id,
          state: { value: { rounds: 1 } },
          producerOutput: { value: { to: 'delivered' } },
          producerArtifactHash: PIN_A,
          next: { kind: 'outcome', outcomeId: 'delivered' },
        }),
      ),
    );
    const evaluation = await claim(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.failSegment({
          ...fence(runId, evaluation.attempt.id),
          code: 'output_evaluation_failed',
          message: 'the output evaluator threw',
        }),
      ),
    );

    const frames = await read(harness.projection.listFrames(runId, {}));
    const frame = frames.items[0]!;
    assert.equal(frame.output, null, 'nothing was published, and none is invented');
    assert.equal(frame.outputEvaluation?.segmentKind, 'graph_output');
    assert.equal(frame.outputEvaluation?.segmentRef, 'delivered', 'the outcome it was evaluating');
    assert.equal(frame.outputEvaluation?.latestAttempt.failure?.code, 'output_evaluation_failed');
    assert.equal(frame.outputEvaluation?.endCertainty, 'observed');
    assert.equal(frame.entry?.latestAttempt.status, 'succeeded', 'entry succeeded; output did not');
    assert.equal(frame.completedAt, null);
  });
});
