import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import { workflowRunPreparations } from '../../persistence/schema.js';
import { contentPathFor } from '../persistence/content-store.js';
import { inlinePayloadThresholdBytes } from '../persistence/payload-store.js';
import { canonicalJson } from '../state/serializable.js';
import type { WorkflowEngineError } from '../types.js';
import {
  captureEvidence,
  claim,
  currentRun,
  enterRoot,
  fence,
  makeReadHarness,
  PIN_A,
  PIN_B,
  run,
  startPreparingRun,
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
      evidenceCaptured: 0,
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
      { count: 1, unresolved: 1, evidenceCaptured: 0, capabilities: ['run_headless_agent'] },
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

/**
 * What the summary says about where a run was sent, and what preparing it actually did.
 *
 * `preparation.status` is derived from the run's position, status and receipts and stored nowhere,
 * so these pin the derivation against real durable states rather than against a column. The rule
 * that matters most is the negative one: a terminal preparation — failed or cancelled — may be
 * holding a real worktree, and must never project as `pending`.
 */

test('a default launch records the placement nobody chose, and allocates nothing for it', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    await enterRoot(harness.fixture, { runId, frameId: rootFrameId, nodeId: 'writer' });

    const summary = (await read(harness.projection.getRun(runId))).run;
    assert.deepEqual(summary.preparation, {
      source: 'default',
      request: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
      baseCommit: null,
      status: 'prepared',
      // Reuse allocates nothing, so it leaves no receipt. This is what lets a failure name only the
      // resources a launch actually created, and a retry reuse rather than duplicate.
      worktree: null,
      setup: null,
      surface: null,
      failure: null,
    });
  });
});

test('a run that is still preparing is pending, and offers no control that would strand it', async () => {
  await withHarness(async (harness) => {
    const { runId } = await startPreparingRun(harness.fixture, {
      source: 'selector',
      request: {
        worktree: { kind: 'create', branch: 'feat/in-flight', fromRef: 'main' },
        surface: { kind: 'create', title: 'In flight' },
      },
      baseCommit: '1122334',
      checkoutPath: '/repo/worktrees/in-flight',
    });

    const summary = (await read(harness.projection.getRun(runId))).run;
    assert.equal(summary.position.kind, 'environment_preparation');
    assert.equal(summary.preparation.status, 'pending', 'it can still move, and only then');
    assert.equal(summary.preparation.request.worktree.kind, 'create');
    assert.equal(summary.destination.worktreeId, null, 'nothing is placed until the commit');
    assert.equal(summary.attachment, null);
    assert.deepEqual(summary.controls, {
      // Pause parks a run for the dispatcher to pick up again, and the dispatcher deliberately
      // never claims this segment — so a paused preparation would wait for a Resume that could
      // never deliver it. The control refuses it, and the flag has to agree.
      pause: false,
      resume: false,
      retry: false,
      // Cancel is the one way out, and it is offered: it stops the preparation and leaves the
      // receipts naming whatever was already allocated.
      cancel: true,
      dismiss: false,
      advance: false,
    });
  });
});

test('a preparation that failed half way names what it created, and offers Retry from its origin', async () => {
  await withHarness(async (harness) => {
    const { runId, attemptId, placement } = await startPreparingRun(harness.fixture, {
      source: 'selector',
      request: {
        worktree: { kind: 'create', branch: 'feat/story-44', fromRef: 'main' },
        surface: { kind: 'create', title: 'Implement story #44' },
      },
      baseCommit: '9f3e1c2',
      checkoutPath: '/repo/worktrees/story-44',
    });

    // Preparation got as far as a worktree and then its setup hooks failed: the worktree is real
    // and nothing deletes it, which is precisely why the receipt has to outlive the failure.
    value(
      await run(
        harness.fixture.runs.recordEnvironmentReceipt({
          ...fence(runId, attemptId),
          step: 'worktree',
          receipt: {
            acquisition: 'created',
            worktreeId: placement.worktreeId,
            worktreePath: '/repo/worktrees/story-44',
            branch: 'feat/story-44',
          },
        }),
      ),
    );
    value(
      await run(
        harness.fixture.runs.recordEnvironmentReceipt({
          ...fence(runId, attemptId),
          step: 'setup',
          receipt: {
            status: 'failed',
            reason: null,
            setupRunId: 7,
            failure: {
              hookIndex: 1,
              hookType: 'command',
              message: 'pnpm install exited 1',
              exitCode: 1,
              outputExcerpt: 'ERR_PNPM_FETCH_404',
            },
          },
        }),
      ),
    );
    value(
      await run(
        harness.fixture.runs.failSegment({
          ...fence(runId, attemptId),
          code: 'environment_preparation_failed',
          message: 'pnpm install exited 1',
          detail: {
            value: {
              step: 'setup',
              reason: 'setup_failed',
              worktreeId: placement.worktreeId,
              diagnostic: 'ERR_PNPM_FETCH_404',
            },
          },
        }),
      ),
    );

    const summary = (await read(harness.projection.getRun(runId))).run;
    assert.equal(summary.preparation.status, 'failed');
    assert.equal(summary.preparation.source, 'selector');
    assert.equal(summary.preparation.baseCommit, '9f3e1c2');
    assert.equal(summary.preparation.worktree?.branch, 'feat/story-44');
    assert.equal(summary.preparation.worktree?.acquisition, 'created');
    assert.equal(summary.preparation.setup?.status, 'failed');
    assert.equal(summary.preparation.surface, null, 'it never got that far');
    // The whole failure is readable from the summary: a client renders it without fetching the
    // attempt it came from.
    assert.deepEqual(summary.preparation.failure, {
      step: 'setup',
      reason: 'setup_failed',
      worktreeId: placement.worktreeId,
      diagnostic: 'ERR_PNPM_FETCH_404',
    });

    // Nothing was placed, so there is nothing to release and nothing to pause.
    assert.equal(summary.destination.worktreeId, null);
    assert.equal(summary.attachment, null);
    assert.deepEqual(summary.controls, {
      pause: false,
      resume: false,
      // Offered against the *origin* worktree: a preparing run has no destination, and Retry only
      // needs somewhere to resolve the latest verified version from.
      retry: true,
      cancel: false,
      dismiss: false,
      advance: false,
    });
  });
});

test('a cancelled preparation rests as cancelled, keeps its receipts, and never reads as pending', async () => {
  await withHarness(async (harness) => {
    const { runId, attemptId, placement } = await startPreparingRun(harness.fixture, {
      source: 'override',
      request: {
        worktree: { kind: 'create', branch: 'feat/abandoned', fromRef: 'main' },
        surface: { kind: 'create', title: 'Abandoned' },
      },
      baseCommit: 'abc1234',
      checkoutPath: '/repo/worktrees/abandoned',
    });
    value(
      await run(
        harness.fixture.runs.recordEnvironmentReceipt({
          ...fence(runId, attemptId),
          step: 'worktree',
          receipt: {
            acquisition: 'created',
            worktreeId: placement.worktreeId,
            worktreePath: '/repo/worktrees/abandoned',
            branch: 'feat/abandoned',
          },
        }),
      ),
    );
    const before = await currentRun(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.applyCancel({ runId, controlRevision: before.controlRevision }),
      ),
    );

    const summary = (await read(harness.projection.getRun(runId))).run;
    // Terminal, and terminal in a way that is not a failure: a cancelled preparation may be holding
    // a real worktree, so it must read as a resting state rather than as work still in progress.
    assert.equal(summary.preparation.status, 'cancelled');
    assert.equal(summary.preparation.failure, null, 'a cancel is not a preparation failure');
    assert.equal(
      summary.preparation.worktree?.worktreePath,
      '/repo/worktrees/abandoned',
      'the receipt is what tells a person which worktree was left behind',
    );
    assert.equal(summary.destination.worktreeId, null);
    assert.equal(
      summary.controls.retry,
      false,
      'a cancelled run is not retryable, and the control refuses it',
    );
    assert.equal(summary.controls.pause, false);
  });
});

test('a Retry interrupted before its claim is failed with nothing to blame, and is still retryable', async () => {
  await withHarness(async (harness) => {
    const { runId, attemptId } = await startPreparingRun(harness.fixture, {
      request: {
        worktree: { kind: 'create', branch: 'feat/halfretry', fromRef: 'main' },
        surface: { kind: 'create', title: 'Half' },
      },
      baseCommit: 'dd11ee2',
      checkoutPath: '/repo/worktrees/halfretry',
    });
    value(
      await run(
        harness.fixture.runs.failSegment({
          ...fence(runId, attemptId),
          code: 'environment_preparation_failed',
          message: 'git refused',
          detail: {
            value: { step: 'worktree', reason: 'branch_exists', branch: 'feat/halfretry' },
          },
        }),
      ),
    );

    /**
     * The window the run row cannot describe on its own: `adoptRetryPin` clears the failure and
     * leaves the run `ready`, and `claimSegment` is a separate transaction. A process killed
     * between the two leaves a preparing run with no attempt at all, which startup recovery then
     * fails with nothing to point at.
     */
    const failed = await currentRun(harness.fixture, runId);
    value(
      await run(
        harness.fixture.runs.adoptRetryPin({
          runId,
          controlRevision: failed.controlRevision,
          artifactHash: PIN_B,
          expectedPosition: failed.position,
          expectedOwner: null,
        }),
      ),
    );
    await run(harness.fixture.runs.parkUnfinishedRuns({}));

    const summary = (await read(harness.projection.getRun(runId))).run;
    assert.equal(summary.status, 'failed');
    assert.equal(summary.preparation.status, 'failed');
    assert.equal(summary.failure, null, 'there is no attempt to attribute the interruption to');
    assert.equal(summary.preparation.failure, null, 'and so no detail is invented for it');
    // The clause most likely to be "corrected" by somebody reading this projection in isolation:
    // retryability is a fact about the run's status, not about the presence of a failing attempt.
    assert.equal(summary.controls.retry, true, 'a failure with no attempt is still retryable');
  });
});

test('every receipt and the commit deliver a summary a client can apply', async () => {
  await withHarness(async (harness) => {
    const { runId, attemptId, placement } = await startPreparingRun(harness.fixture, {
      source: 'selector',
      request: {
        worktree: { kind: 'create', branch: 'feat/delta', fromRef: 'main' },
        surface: { kind: 'create', title: 'Delta' },
      },
      baseCommit: 'feed123',
      checkoutPath: '/repo/worktrees/delta',
    });
    const from = (await currentRun(harness.fixture, runId)).revision;

    value(
      await run(
        harness.fixture.runs.recordEnvironmentReceipt({
          ...fence(runId, attemptId),
          step: 'worktree',
          receipt: {
            acquisition: 'created',
            worktreeId: placement.worktreeId,
            worktreePath: '/repo/worktrees/delta',
            branch: 'feat/delta',
          },
        }),
      ),
    );
    value(
      await run(
        harness.fixture.runs.recordEnvironmentReceipt({
          ...fence(runId, attemptId),
          step: 'setup',
          receipt: { status: 'succeeded', reason: null, setupRunId: 9, failure: null },
        }),
      ),
    );
    value(
      await run(
        harness.fixture.runs.recordEnvironmentReceipt({
          ...fence(runId, attemptId),
          step: 'surface',
          receipt: {
            surfaceId: placement.surfaceId,
            requestedTitle: 'Delta',
            title: 'Delta',
          },
        }),
      ),
    );
    value(
      await run(
        harness.fixture.runs.commitEnvironmentPreparation({
          runId,
          attemptId,
          owner: 'worker-1',
          ownerIncarnation: 'incarnation-1',
          destination: {
            worktreeId: placement.worktreeId,
            worktreePath: '/repo/worktrees/delta',
            surfaceId: placement.surfaceId,
          },
        }),
      ),
    );

    const events = await read(harness.projection.listEvents(runId, { sinceRevision: from }));
    assert.deepEqual(
      events.items.map((delta) => delta.transition.kind),
      [
        'environment_step_recorded',
        'environment_step_recorded',
        'environment_step_recorded',
        'environment_prepared',
      ],
      'a receipt is a transition, and so is the commit',
    );
    // No publisher change was needed for any of this: `captureTransitionChanges` diffs the projected
    // summary across the transaction, so a projection that gained a field gains its deltas for free.
    // Asserting the summaries rather than their presence is what makes that non-vacuous.
    for (const delta of events.items) {
      assert.ok(delta.changes.summary, `${delta.transition.kind} carried no summary`);
      assert.equal(delta.changes.summary.revision, delta.revision);
    }
    assert.deepEqual(
      events.items.map((delta) => [
        delta.changes.summary!.preparation.worktree !== null,
        delta.changes.summary!.preparation.setup !== null,
        delta.changes.summary!.preparation.surface !== null,
        delta.changes.summary!.preparation.status,
      ]),
      [
        [true, false, false, 'pending'],
        [true, true, false, 'pending'],
        [true, true, true, 'pending'],
        [true, true, true, 'prepared'],
      ],
      'each step is visible as it lands, and only the commit says prepared',
    );
    assert.equal(events.items.at(-1)!.changes.summary!.destination.surfaceId, placement.surfaceId);
  });
});

test('a run with no preparation row fails its next write rather than inventing a placement', async () => {
  await withHarness(async (harness) => {
    const { runId } = await startRun(harness.fixture);
    // `createRun` writes the preparation row in the same transaction as the run, so its absence is
    // corruption rather than a state. Removing it by hand is the only way to reach this.
    await run(
      harness.fixture.database.use('test_delete_preparation', (db) => {
        db.delete(workflowRunPreparations).where(eq(workflowRunPreparations.runId, runId)).run();
      }),
    );

    /**
     * It surfaces on the next *write*, not on the next read.
     *
     * The summary is projected in exactly one place — `captureTransitionChanges`, inside every
     * workflow transaction — and reads serve the snapshot it captured. So a corrupt run does not
     * degrade quietly into a listing; it stops the transaction that would have recorded a
     * fabricated summary, which is the same posture `runPosition` takes for an unreadable position.
     * A guessed placement request would relocate a run, and a guessed receipt would make a retry
     * create a second worktree instead of reusing the first.
     */
    const before = await currentRun(harness.fixture, runId);
    const failed = await Effect.runPromise(
      Effect.either(
        harness.fixture.runs.applyCancel({ runId, controlRevision: before.controlRevision }),
      ),
    );
    assert.equal(failed._tag, 'Left', 'the write was not allowed to complete');
    assert.match(
      String((failed as { left: { cause: unknown } }).left.cause),
      /unreadable preparation row/,
    );

    // And the write really did not land: the run is what it was.
    const after = await currentRun(harness.fixture, runId);
    assert.equal(after.status, before.status);
    assert.equal(after.revision, before.revision);
  });
});

/**
 * What the summary can and cannot read back of a recorded failure detail.
 *
 * `preparation.failure` is decoded from the failing attempt's `failure_detail`, which goes through
 * the payload store like every other recorded value: above `inlinePayloadThresholdBytes` it is
 * offloaded to a ref, and the projection deliberately never resolves refs.
 *
 * The writer is what keeps that from mattering. `prepareEnvironment` bounds the diagnostic so the
 * encoded detail always fits inline — pinned end to end by "a hook that printed 32 KiB still leaves
 * a failure the summary can name" in `engine/environment.test.ts`, which drives a real worst-case
 * hook failure through the segment. What is pinned *here* is the read side of that contract: an
 * inline detail is projected whole, and a detail the projection cannot read degrades to null rather
 * than throwing, because this projection runs inside every workflow write.
 */
test('an inline preparation failure detail is projected whole, and an unreadable one degrades', async () => {
  await withHarness(async (harness) => {
    const readDetailFor = async (diagnostic: string) => {
      const { runId, attemptId } = await startPreparingRun(harness.fixture, {
        request: {
          worktree: { kind: 'create', branch: `feat/d${diagnostic.length}`, fromRef: 'main' },
          surface: { kind: 'create', title: 'Diagnostic' },
        },
      });
      value(
        await run(
          harness.fixture.runs.failSegment({
            ...fence(runId, attemptId),
            code: 'environment_preparation_failed',
            message: 'a setup hook failed',
            detail: { value: { step: 'setup', reason: 'setup_failed', diagnostic } },
          }),
        ),
      );
      const summary = (await read(harness.projection.getRun(runId))).run;
      // Whatever happens to the detail, the run-level failure still reports the code and message,
      // so nothing ever goes entirely unreported.
      assert.equal(summary.failure?.code, 'environment_preparation_failed');
      assert.equal(summary.preparation.status, 'failed');
      return summary.preparation.failure;
    };

    // What the bounded writer produces: the whole detail, read back from the summary alone.
    const inline = await readDetailFor('ERR_PNPM_FETCH_404\n'.repeat(16));
    assert.equal(inline?.step, 'setup');
    assert.equal(inline?.reason, 'setup_failed');

    /**
     * The defensive path, written straight past the writer's bound.
     *
     * No caller can reach this any more — `fail()` is the single construction site for a
     * preparation failure detail and it guarantees an inline encoding — so this is here to pin the
     * *degrade*, not a reachable state. It matters because the alternative is a throw, and this
     * projection runs inside every workflow write: an unreadable detail must cost a field, never
     * the transaction that was recording the failure.
     */
    assert.equal(
      await readDetailFor('x'.repeat(32 * 1024)),
      null,
      'an offloaded detail is reported as no detail, never as no failure',
    );
  });
});

/**
 * A run with a root visit that captures twice, and a subgraph visit whose nested execution captures
 * once and whose own callback captures once. Enough shape to catch every counting mistake the
 * subtree rule can make.
 */
async function seedCaptures(harness: ReadHarness) {
  const { runId, rootFrameId } = await startRun(harness.fixture);
  const writer = await enterRoot(harness.fixture, {
    runId,
    frameId: rootFrameId,
    nodeId: 'writer',
  });
  const writerCallback = await claim(harness.fixture, runId);
  const first = await captureEvidence(harness.fixture, {
    runId,
    frameId: rootFrameId,
    executionId: writer.id,
    attemptId: writerCallback.attempt.id,
    callIndex: 0,
    title: 'Round one review',
    role: 'review',
    labels: { round: 1, phase: 'draft', approved: false },
  });
  const second = await captureEvidence(harness.fixture, {
    runId,
    frameId: rootFrameId,
    executionId: writer.id,
    attemptId: writerCallback.attempt.id,
    callIndex: 1,
    title: 'Round two review',
    role: 'review',
    labels: { round: 2, phase: 'draft', approved: true },
    mediaType: 'application/json',
    bytes: Buffer.from('{"verdict":"ship"}'),
  });

  value(
    await run(
      harness.fixture.runs.commitNodeResult({
        ...fence(runId, writerCallback.attempt.id),
        frameId: rootFrameId,
        executionId: writer.id,
        state: { value: { rounds: 1 } },
        producerOutput: { value: { type: 'route' } },
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
        executionId: writer.id,
        state: { value: { rounds: 1 } },
        producerOutput: { value: { to: 'review' } },
        producerArtifactHash: PIN_A,
        next: { kind: 'node', nodeId: 'review', nodeKind: 'subgraph' },
      }),
    ),
  );
  const subgraph = (await run(harness.fixture.runs.listExecutions(rootFrameId))).at(-1)!;
  const before = await currentRun(harness.fixture, runId);
  const childFrameId = value(
    await run(
      harness.fixture.runs.enterSubgraph({
        runId,
        controlRevision: before.controlRevision,
        expectedPosition: before.position,
        artifactHash: PIN_A,
        parentExecutionId: subgraph.id,
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
  const nested = (await run(harness.fixture.runs.listExecutions(childFrameId))).at(-1)!;
  const nestedCallback = await claim(harness.fixture, runId);
  const third = await captureEvidence(harness.fixture, {
    runId,
    frameId: childFrameId,
    executionId: nested.id,
    attemptId: nestedCallback.attempt.id,
    callIndex: 0,
    title: 'Judge verdict',
    role: 'verdict',
    // `signed` is the *string* "true", not a boolean. An author writing
    // `labels: { signed: String(flag) }` produces exactly this, and it is the value a partial
    // representation collapse would make unreachable by any spelling.
    labels: { round: 1, signed: 'true' },
    bytes: Buffer.from('the judge said ship it'),
  });

  return {
    runId,
    rootFrameId,
    childFrameId,
    writer,
    subgraph,
    nested,
    subgraphAttemptId: nestedCallback.attempt.id,
    keys: {
      first: first.evidence!.evidenceKey,
      second: second.evidence!.evidenceKey,
      third: third.evidence!.evidenceKey,
    },
  };
}

test('an evidence listing answers by run, by frame, by execution and by subtree', async () => {
  await withHarness(async (harness) => {
    const seeded = await seedCaptures(harness);

    const all = await read(harness.projection.listEvidence(seeded.runId, {}));
    assert.deepEqual(
      all.items.map((item) => item.evidenceKey),
      [seeded.keys.first, seeded.keys.second, seeded.keys.third],
      'the run listing is every record in capture order',
    );
    assert.equal(all.nextCursor, null);

    const byFrame = await read(
      harness.projection.listEvidence(seeded.runId, { frameId: seeded.childFrameId }),
    );
    assert.deepEqual(
      byFrame.items.map((item) => item.evidenceKey),
      [seeded.keys.third],
    );

    const byExecution = await read(
      harness.projection.listEvidence(seeded.runId, { executionId: seeded.writer.id }),
    );
    assert.deepEqual(
      byExecution.items.map((item) => item.evidenceKey),
      [seeded.keys.first, seeded.keys.second],
    );

    const ownCallback = await read(
      harness.projection.listEvidence(seeded.runId, { executionId: seeded.subgraph.id }),
    );
    assert.deepEqual(
      ownCallback.items.map((item) => item.evidenceKey),
      [],
      'a subgraph visit captured nothing itself',
    );

    const subtree = await read(
      harness.projection.listEvidence(seeded.runId, {
        executionId: seeded.subgraph.id,
        subtree: 'true',
      }),
    );
    assert.deepEqual(
      subtree.items.map((item) => item.evidenceKey),
      [seeded.keys.third],
      'the subtree of a subgraph visit reaches the executions inside its child frame',
    );
  });
});

test('an evidence listing filters by role and by label, comparing label values as text', async () => {
  await withHarness(async (harness) => {
    const seeded = await seedCaptures(harness);

    const reviews = await read(harness.projection.listEvidence(seeded.runId, { role: 'review' }));
    assert.deepEqual(
      reviews.items.map((item) => item.evidenceKey),
      [seeded.keys.first, seeded.keys.second],
    );

    const roundTwo = await read(
      harness.projection.listEvidence(seeded.runId, { label: ['round:2'] }),
    );
    assert.deepEqual(
      roundTwo.items.map((item) => item.evidenceKey),
      [seeded.keys.second],
      'a numeric label matches the text a person typed',
    );

    const both = await read(
      harness.projection.listEvidence(seeded.runId, { label: ['round:1', 'phase:draft'] }),
    );
    assert.deepEqual(
      both.items.map((item) => item.evidenceKey),
      [seeded.keys.first],
      'repeated label filters intersect rather than union',
    );

    const approved = await read(
      harness.projection.listEvidence(seeded.runId, { label: ['approved:true'] }),
    );
    assert.deepEqual(
      approved.items.map((item) => item.evidenceKey),
      [seeded.keys.second],
      'a boolean label is reachable by the spelling an author wrote',
    );

    // SQLite extracts a JSON `true` as the integer 1, so this is the same record under the other
    // spelling. Both must reach it, or one of them is a dead end nothing announces.
    const approvedAsOne = await read(
      harness.projection.listEvidence(seeded.runId, { label: ['approved:1'] }),
    );
    assert.deepEqual(
      approvedAsOne.items.map((item) => item.evidenceKey),
      [seeded.keys.second],
      'and by the spelling the storage engine actually holds',
    );

    // The case the collapse has to be *total* for: a label whose value is the string "true" is
    // stored as the text `true`, which the boolean rewrite alone would look straight past — matched
    // by neither `signed:true` (rewritten to 1) nor `signed:1` (never equal to it).
    const signed = await read(
      harness.projection.listEvidence(seeded.runId, { label: ['signed:true'] }),
    );
    assert.deepEqual(
      signed.items.map((item) => item.evidenceKey),
      [seeded.keys.third],
      'a string label spelling a boolean is reachable, not stranded',
    );

    const absent = await read(
      harness.projection.listEvidence(seeded.runId, { label: ['nothing:here'] }),
    );
    assert.deepEqual(absent.items, [], 'a label no record carries matches nothing');
  });
});

test('an evidence listing carries metadata and never content', async () => {
  await withHarness(async (harness) => {
    const seeded = await seedCaptures(harness);
    const listing = await read(harness.projection.listEvidence(seeded.runId, {}));

    const record = listing.items[0]!;
    assert.equal(record.title, 'Round one review');
    assert.equal(record.role, 'review');
    assert.deepEqual(record.labels, { round: 1, phase: 'draft', approved: false });
    assert.equal(record.executionId, seeded.writer.id);
    assert.equal(record.frameId, seeded.rootFrameId);
    assert.equal(record.artifactHash, PIN_A);
    assert.ok(record.operationKey.length > 0, 'a record names the call position that made it');
    assert.deepEqual(record.source, { kind: 'none' });
    assert.ok(record.content.contentRef.startsWith('sha256:'));
    assert.equal(record.content.mediaType, 'text/plain');
    assert.equal(record.content.byteSize, Buffer.from('Round one review').byteLength);

    // Asserted over the serialized body, not by reading fields: the guarantee is that no listing can
    // ever carry bytes, and an inspection of the shape would miss a field added later.
    const serialized = JSON.stringify(listing);
    assert.ok(
      !serialized.includes('Round one review'.split('').reverse().join('')),
      'a sanity check that this assertion can fail',
    );
    for (const captured of ['{"verdict":"ship"}', 'the judge said ship it']) {
      assert.ok(
        !serialized.includes(captured),
        `the listing body must not contain captured content (${captured})`,
      );
    }
    assert.ok(
      !serialized.includes('"value"') && !serialized.includes('"inline"'),
      'the listing carries no inline value of any kind',
    );
  });
});

test('an evidence listing pages every row, and refuses a cursor from another listing', async () => {
  await withHarness(async (harness) => {
    const seeded = await seedCaptures(harness);

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof harness.projection.listEvidence>> extends never
        ? never
        : { items: readonly { evidenceKey: string }[]; nextCursor: string | null } = await read(
        harness.projection.listEvidence(seeded.runId, {
          limit: 2,
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      pages += 1;
      walked.push(...page.items.map((item) => item.evidenceKey));
      cursor = page.nextCursor;
    } while (cursor !== null);

    assert.equal(pages, 2);
    assert.deepEqual(walked, [seeded.keys.first, seeded.keys.second, seeded.keys.third]);

    const first = await read(harness.projection.listEvidence(seeded.runId, { limit: 2 }));
    const refused = await rejection(
      harness.projection.listEvidence(seeded.runId, {
        limit: 2,
        cursor: first.nextCursor!,
        role: 'review',
      }),
    );
    assert.equal(
      refused.code,
      'workflow_cursor_invalid',
      'a continuation taken under one filter set is not a continuation of another',
    );
  });
});

test('one record is fetched by key, and another run cannot fetch it', async () => {
  await withHarness(async (harness) => {
    const seeded = await seedCaptures(harness);
    const { evidence } = await read(
      harness.projection.getEvidence(seeded.runId, seeded.keys.second),
    );
    assert.equal(evidence.title, 'Round two review');
    assert.equal(evidence.content.mediaType, 'application/json');

    const other = await startRun(harness.fixture, { workflowKey: 'other' });
    const refused = await rejection(
      harness.projection.getEvidence(other.runId, seeded.keys.second),
    );
    assert.equal(refused.code, 'workflow_evidence_not_found');
    assert.equal(refused.evidenceKey, seeded.keys.second);
  });
});

test('evidence content streams, and reports honestly once its bytes are gone', async () => {
  await withHarness(async (harness) => {
    const seeded = await seedCaptures(harness);
    const opened = await read(
      harness.projection.openEvidenceContent(seeded.runId, seeded.keys.first),
    );
    assert.equal(opened.mediaType, 'text/plain');
    assert.equal(opened.byteSize, Buffer.from('Round one review').byteLength);
    assert.equal(
      opened.filename,
      'round-one-review-review.txt',
      'the download name is derived from the recorded identity, not from the bytes',
    );
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'Round one review');

    const { evidence } = await read(
      harness.projection.getEvidence(seeded.runId, seeded.keys.first),
    );
    await rm(contentPathFor(harness.fixture.contentRoot, evidence.content.contentRef));
    const refused = await rejection(
      harness.projection.openEvidenceContent(seeded.runId, seeded.keys.first),
    );
    assert.equal(refused.code, 'workflow_evidence_content_unavailable');
    assert.equal(refused.payloadCause, 'missing');
    assert.equal(refused.evidenceKey, seeded.keys.first);

    // The metadata is still readable, which is the whole point of the metadata-first split.
    const still = await read(harness.projection.getEvidence(seeded.runId, seeded.keys.first));
    assert.equal(still.evidence.title, 'Round one review');
  });
});

test('a capture counts toward the summary only once its evidence row exists', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const writer = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const callback = await claim(harness.fixture, runId);

    const summaryOf = async (executionId: number) => {
      const executions = await read(harness.projection.listRunExecutions(runId, {}));
      return executions.items.find((item) => item.executionId === executionId)!.operationSummary;
    };

    const { operation } = await captureEvidence(harness.fixture, {
      runId,
      frameId: rootFrameId,
      executionId: writer.id,
      attemptId: callback.attempt.id,
      callIndex: 0,
      title: 'Draft',
      role: 'draft',
      settle: false,
    });
    assert.equal(
      (await summaryOf(writer.id)).evidenceCaptured,
      0,
      'an intended capture has produced nothing to count',
    );

    value(
      await run(
        harness.fixture.operations.settle({
          operationId: operation.id,
          state: 'abandoned',
          result: { value: null },
        }),
      ),
    );
    const abandoned = await summaryOf(writer.id);
    assert.equal(
      abandoned.evidenceCaptured,
      0,
      'an abandoned capture is not a capture, though `unresolved` cannot tell them apart',
    );
    assert.equal(abandoned.unresolved, 0);
    assert.equal(abandoned.count, 1);

    const published = await run(
      harness.fixture.content.put({ source: Buffer.from('Draft'), mediaTypeHint: 'text/plain' }),
    );
    value(
      await run(
        harness.fixture.evidence.commitCapture({
          operation,
          attemptId: callback.attempt.id,
          title: 'Draft',
          role: 'draft',
          labels: null,
          contentKind: 'text',
          mediaType: 'text/plain',
          byteSize: published.byteSize,
          contentRef: published.contentRef,
          sourcePath: null,
          source: { kind: 'none', agentSessionId: null, operationId: null, attribution: 'none' },
          now: new Date().toISOString(),
        }),
      ),
    );
    const settled = await summaryOf(writer.id);
    assert.equal(settled.evidenceCaptured, 1, 'the reopening commit is what moves the count');
    assert.equal(settled.count, 1, 'and it is the only count that moved');
    assert.equal(settled.unresolved, 0);
  });
});

test('the captured count is subtree-inclusive at every level, and counts each capture once', async () => {
  await withHarness(async (harness) => {
    const seeded = await seedCaptures(harness);
    // The subgraph visit's own capture, so the parent has both a direct record and a nested one and
    // the difference between "mine" and "mine and below" is actually observable.
    await captureEvidence(harness.fixture, {
      runId: seeded.runId,
      frameId: seeded.rootFrameId,
      executionId: seeded.subgraph.id,
      attemptId: seeded.subgraphAttemptId,
      callIndex: 0,
      title: 'Mapped output',
      role: 'output',
    });

    // A *second* execution inside the same child frame, also capturing. One nested execution would
    // let an accumulation that folded in only the first of them pass unnoticed.
    value(
      await run(
        harness.fixture.runs.commitNodeResult({
          ...fence(seeded.runId, seeded.subgraphAttemptId),
          frameId: seeded.childFrameId,
          executionId: seeded.nested.id,
          state: { value: { verdict: 'ship' } },
          producerOutput: { value: { type: 'route' } },
          producerArtifactHash: PIN_A,
          next: { kind: 'routing', edgeId: 'judge-out' },
        }),
      ),
    );
    const nestedRouting = await claim(harness.fixture, seeded.runId);
    value(
      await run(
        harness.fixture.runs.commitRouting({
          ...fence(seeded.runId, nestedRouting.attempt.id),
          frameId: seeded.childFrameId,
          executionId: seeded.nested.id,
          state: { value: { verdict: 'ship' } },
          producerOutput: { value: { to: 'scribe' } },
          producerArtifactHash: PIN_A,
          next: { kind: 'node', nodeId: 'scribe', nodeKind: 'operation' },
        }),
      ),
    );
    const sibling = (await run(harness.fixture.runs.listExecutions(seeded.childFrameId))).at(-1)!;
    const siblingCallback = await claim(harness.fixture, seeded.runId);
    await captureEvidence(harness.fixture, {
      runId: seeded.runId,
      frameId: seeded.childFrameId,
      executionId: sibling.id,
      attemptId: siblingCallback.attempt.id,
      callIndex: 0,
      title: 'Scribe notes',
      role: 'notes',
    });

    const executions = await read(harness.projection.listRunExecutions(seeded.runId, {}));
    const summaryOf = (executionId: number) =>
      executions.items.find((item) => item.executionId === executionId)!.operationSummary
        .evidenceCaptured;

    assert.equal(summaryOf(seeded.writer.id), 2, 'a leaf visit reports its own captures');
    assert.equal(summaryOf(seeded.nested.id), 1, 'so does a nested one');
    assert.equal(summaryOf(sibling.id), 1, 'and so does its sibling, independently');
    assert.equal(
      summaryOf(seeded.subgraph.id),
      3,
      'a subgraph visit reports its own capture and both beneath it, and nothing else',
    );

    // Summing root-frame executions is the run total; summing every execution would count the two
    // nested captures twice, which is exactly the mistake the rule exists to prevent.
    const rootFrameTotal = executions.items
      .filter((item) => item.frameId === seeded.rootFrameId)
      .reduce((total, item) => total + item.operationSummary.evidenceCaptured, 0);
    assert.equal(rootFrameTotal, 5, 'every capture in the run, counted once');
    assert.equal(
      executions.items.reduce((total, item) => total + item.operationSummary.evidenceCaptured, 0),
      7,
      'and summing every execution instead double-counts both nested captures',
    );
  });
});

test('getOperation reports provenance, and says honestly when no transcript can be located', async () => {
  const harness = makeReadHarness({
    locateTranscript: (input) =>
      Effect.succeed(
        input.harnessSessionId === 'session-live'
          ? { locator: `/transcripts/${input.harnessSessionId}.jsonl`, available: true }
          : { locator: `/transcripts/${input.harnessSessionId}.jsonl`, available: false },
      ),
  });
  try {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const writer = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const callback = await claim(harness.fixture, runId);
    const headless = value(
      await run(
        harness.fixture.operations.recordIntent({
          runId,
          frameId: rootFrameId,
          executionId: writer.id,
          originAttemptId: callback.attempt.id,
          capability: 'run_headless_agent',
          callIndex: 0,
          request: { value: { prompt: 'judge' } },
          fingerprintOf: { value: { prompt: 'judge' } },
          artifactHash: PIN_A,
          provenance: {
            harness: 'claude',
            model: 'opus',
            effort: null,
            cwd: '/work/tree',
            runtimeId: 'runtime-1',
            incarnationId: 'incarnation-1',
          },
        }),
      ),
    );
    value(
      await run(
        harness.fixture.operations.settle({
          operationId: headless.id,
          state: 'completed',
          result: { value: { text: 'done' } },
          provenance: { correlatedHarnessSessionId: 'session-gone' },
        }),
      ),
    );

    const { operation } = await read(harness.projection.getOperation(runId, headless.operationKey));
    assert.equal(operation.provenance.harness, 'claude');
    assert.equal(operation.provenance.model, 'opus');
    assert.equal(operation.provenance.cwd, '/work/tree');
    assert.deepEqual(operation.provenance.runtime, {
      runtimeId: 'runtime-1',
      incarnationId: 'incarnation-1',
    });
    assert.deepEqual(
      operation.provenance.transcript,
      { locator: '/transcripts/session-gone.jsonl', available: false },
      'a transcript that is not there reads as unavailable, not as a live reference',
    );

    const listing = await read(harness.projection.listOperations(runId, {}));
    assert.ok(
      !Object.hasOwn(listing.items[0]!.provenance, 'transcript'),
      'a listing does not evaluate a locator at all, and must not imply it did',
    );

    const missing = await rejection(harness.projection.getOperation(runId, 'wop_nothing'));
    assert.equal(missing.code, 'workflow_operation_not_found');
  } finally {
    harness.close();
  }
});

test('getOperation omits the transcript when the operation records no session or cwd', async () => {
  const harness = makeReadHarness({
    locateTranscript: () => Effect.die(new Error('a locator must not be consulted without inputs')),
  });
  try {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const writer = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const callback = await claim(harness.fixture, runId);
    const capture = await captureEvidence(harness.fixture, {
      runId,
      frameId: rootFrameId,
      executionId: writer.id,
      attemptId: callback.attempt.id,
      callIndex: 0,
      title: 'Draft',
      role: 'draft',
    });

    const { operation } = await read(
      harness.projection.getOperation(runId, capture.operation.operationKey),
    );
    assert.equal(operation.capability, 'capture_evidence');
    assert.equal(operation.provenance.harness, null);
    assert.equal(
      operation.provenance.transcript,
      null,
      'no locator could be built, which is a fact rather than an omission',
    );
  } finally {
    harness.close();
  }
});

test('the same bytes read as one media type as evidence and another as a payload slot', async () => {
  await withHarness(async (harness) => {
    const { runId, rootFrameId } = await startRun(harness.fixture);
    const writer = await enterRoot(harness.fixture, {
      runId,
      frameId: rootFrameId,
      nodeId: 'writer',
    });
    const callback = await claim(harness.fixture, runId);

    // Large enough to be referenced rather than inlined, so both stores name the same blob.
    const verdict = { verdict: 'ship', notes: 'n'.repeat(inlinePayloadThresholdBytes) };

    // Captured first as plain text: the author labelled these bytes as something they are not, and
    // the runtime records what they said rather than second-guessing it.
    const capture = await captureEvidence(harness.fixture, {
      runId,
      frameId: rootFrameId,
      executionId: writer.id,
      attemptId: callback.attempt.id,
      callIndex: 0,
      title: 'Verdict',
      role: 'verdict',
      mediaType: 'text/plain',
      bytes: Buffer.from(canonicalJson(verdict), 'utf8'),
    });

    // The identical canonical bytes then reach a payload slot through the ordinary write path.
    value(
      await run(
        harness.fixture.runs.commitNodeResult({
          ...fence(runId, callback.attempt.id),
          frameId: rootFrameId,
          executionId: writer.id,
          state: { value: { rounds: 1 } },
          producerOutput: { value: verdict },
          producerArtifactHash: PIN_A,
          next: { kind: 'routing', edgeId: 'writer-out' },
        }),
      ),
    );

    const { evidence } = await read(
      harness.projection.getEvidence(runId, capture.evidence!.evidenceKey),
    );
    assert.equal(
      evidence.content.mediaType,
      'text/plain',
      'media type is a fact about this use of the bytes, not about the digest that names them',
    );

    const payload = await read(harness.projection.getPayload(runId, evidence.content.contentRef));
    assert.equal(
      payload.mediaType,
      'application/json',
      'and the payload route says what a payload slot is, whoever published the bytes first',
    );
    assert.deepEqual(payload.value, verdict);

    // The same answer from the slot projection, which is the read path a dock actually renders.
    // `slotDto` must reach it from the catalog row's size and *not* from its `media_type` column —
    // that column is the publisher's hint about one use of the bytes, and here it says `text/plain`.
    const executions = await read(harness.projection.listRunExecutions(runId, {}));
    const candidate = executions.items.find((item) => item.executionId === writer.id)!.candidateRef;
    assert.ok(
      candidate !== null && 'payloadRef' in candidate,
      'the operand is referenced, not inline',
    );
    assert.equal(
      candidate.payloadRef,
      evidence.content.contentRef,
      'one digest, named identically by both stores',
    );
    assert.equal(
      candidate.mediaType,
      'application/json',
      'and a slot is always JSON, however the bytes behind it were first published',
    );
  });
});
