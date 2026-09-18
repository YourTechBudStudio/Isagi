import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { workflowOperations } from '../../persistence/schema.js';
import { settleOperationWithin } from './operations.repository.js';
import type { WorkflowWriteResult } from './outcomes.js';
import {
  createPlacedRun,
  makeWorkflowPersistenceFixture,
  prepareClaim,
  run,
  type WorkflowPersistenceFixture,
} from './test-support.js';

const PIN = 'a'.repeat(64);
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

/** A run parked inside a node callback, with a claimed attempt that can record operations. */
async function insideCallback(fixture: WorkflowPersistenceFixture) {
  fixture.seedArtifact(PIN);
  const placement = fixture.seedPlacement();
  const created = await createPlacedRun(fixture, {
    workflowKey: 'fixture',
    title: 'Fixture',
    rootGraphKey: 'root',
    artifactHash: PIN,
    rootFrame: { graphKey: 'root' },
    placement,
  });
  const entry = value(
    await run(
      fixture.runs.claimSegment({
        ...(await prepareClaim(fixture, created.run.id)),
        owner: OWNER,
        ownerIncarnation: INCARNATION,
      }),
    ),
  );
  await run(
    fixture.runs.commitGraphEntry({
      runId: created.run.id,
      attemptId: entry.attempt.id,
      owner: OWNER,
      ownerIncarnation: INCARNATION,
      frameId: created.frame.id,
      state: { value: {} },
      entryNode: { nodeId: 'work', nodeKind: 'operation' },
    }),
  );
  const ready = (await run(fixture.runs.findRun(created.run.id)))!;
  const callback = value(
    await run(
      fixture.runs.claimSegment({
        ...(await prepareClaim(fixture, ready.id)),
        owner: OWNER,
        ownerIncarnation: INCARNATION,
      }),
    ),
  );
  return {
    runId: created.run.id,
    frameId: created.frame.id,
    executionId: callback.attempt.executionId!,
    attemptId: callback.attempt.id,
  };
}

test('an intent records a call position before anything crosses a boundary', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const operation = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'run_headless_agent',
          callIndex: 0,
          request: { value: { prompt: 'judge this' } },
          fingerprintOf: { value: { prompt: 'judge this' } },
          artifactHash: PIN,
        }),
      ),
    );
    // `intended`, not `dispatched`: it says a call position was recorded while nothing provably
    // left, which is exactly what makes a later redispatch under the same identity safe.
    assert.equal(operation.state, 'intended');
    assert.equal(operation.stage, null);
    assert.match(operation.operationKey, /^wop_/);
    assert.match(operation.requestFingerprint, /^[a-f0-9]{64}$/);
  } finally {
    fixture.close();
  }
});

test('identity covers what the author asked for, not what the runtime resolved for them', async () => {
  // The recorded request holds both facts; only one of them is identity. A runtime-chosen dispatch
  // value — a resolved default timeout, say — has to be durable so a redispatch keeps it, but if it
  // entered the fingerprint then changing that default would give every in-flight operation that
  // omitted the field a new identity, and the next recovery would reject an unchanged callback with
  // `operation_request_changed` naming nothing the author did.
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const authorIntent = { harness: 'claude', renderedPrompt: 'judge this', timeoutMs: null };
    const base = {
      runId: ctx.runId,
      frameId: ctx.frameId,
      executionId: ctx.executionId,
      originAttemptId: ctx.attemptId,
      capability: 'run_headless_agent' as const,
      callIndex: 0,
      artifactHash: PIN,
      fingerprintOf: { value: authorIntent },
    };
    const recorded = value(
      await run(
        fixture.operations.recordIntent({
          ...base,
          request: { value: { request: authorIntent, dispatch: { effectiveTimeoutMs: 600_000 } } },
        }),
      ),
    );

    // The same author intent re-entered while the runtime's resolved default has changed underneath
    // it. This is the recovery path, and it must adopt rather than refuse.
    const adopted = value(
      await run(
        fixture.operations.recordIntent({
          ...base,
          request: { value: { request: authorIntent, dispatch: { effectiveTimeoutMs: 900_000 } } },
        }),
      ),
    );
    assert.equal(adopted.id, recorded.id);
    assert.equal(adopted.requestFingerprint, recorded.requestFingerprint);

    // And the recorded request is not rewritten by the adoption: the operation keeps dispatching
    // under the configuration it was created with.
    const stored = await run(fixture.payloads.resolve(adopted.request!));
    assert.deepEqual(stored, {
      request: authorIntent,
      dispatch: { effectiveTimeoutMs: 600_000 },
    });

    // A changed *author* intent at the same position is still refused, before any effect.
    const changed = await run(
      fixture.operations.recordIntent({
        ...base,
        fingerprintOf: { value: { ...authorIntent, timeoutMs: 30_000 } },
        request: {
          value: {
            request: { ...authorIntent, timeoutMs: 30_000 },
            dispatch: { effectiveTimeoutMs: 30_000 },
          },
        },
      }),
    );
    assert.equal(rejection(changed).kind, 'operation_request_changed');
  } finally {
    fixture.close();
  }
});

test('the fingerprint is over canonical bytes, so key order does not change identity', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const first = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'send_agent_prompt',
          callIndex: 0,
          request: { value: { a: 1, b: 2 } },
          fingerprintOf: { value: { a: 1, b: 2 } },
          artifactHash: PIN,
        }),
      ),
    );
    const second = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'send_agent_prompt',
          callIndex: 1,
          request: { value: { b: 2, a: 1 } },
          fingerprintOf: { value: { b: 2, a: 1 } },
          artifactHash: PIN,
        }),
      ),
    );
    assert.equal(second.requestFingerprint, first.requestFingerprint);
    assert.notEqual(second.id, first.id, 'a different call position is a different operation');
  } finally {
    fixture.close();
  }
});

test('re-entering a callback adopts the recorded call rather than creating a second one', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const intent = {
      runId: ctx.runId,
      frameId: ctx.frameId,
      executionId: ctx.executionId,
      originAttemptId: ctx.attemptId,
      capability: 'close_pane' as const,
      callIndex: 0,
      request: { value: { paneId: 7 } },
      fingerprintOf: { value: { paneId: 7 } },
      artifactHash: PIN,
    };
    const first = value(await run(fixture.operations.recordIntent(intent)));
    const again = value(await run(fixture.operations.recordIntent(intent)));

    assert.equal(again.id, first.id);
    assert.equal(again.operationKey, first.operationKey);
    assert.equal((await run(fixture.operations.listForExecution(ctx.executionId))).length, 1);
  } finally {
    fixture.close();
  }
});

test('a stage is recorded before its boundary and allocates its own history', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const operation = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'send_agent_prompt',
          callIndex: 0,
          request: { value: { prompt: 'hello' } },
          fingerprintOf: { value: { prompt: 'hello' } },
          artifactHash: PIN,
        }),
      ),
    );
    const revisionBefore = (await run(fixture.runs.findRun(ctx.runId)))!.revision;

    const submitting = value(
      await run(
        fixture.operations.recordReceipt({
          operationId: operation.id,
          stage: 'submitting',
          targetKind: 'agent_session',
          targetId: 42,
          ptyProcessId: 7,
          // Persisted *before* the PTY write, which is the only reason recovery can bound its
          // search without the callback's return value.
          submissionWatermark: '2026-09-15T00:00:00.000Z',
        }),
      ),
    );
    assert.equal(submitting.stage, 'submitting');
    assert.equal(submitting.state, 'dispatched');
    assert.equal(submitting.submissionWatermark, '2026-09-15T00:00:00.000Z');

    // A reconnecting client must be able to learn about a stage it never saw, so the advance is a
    // revision of its own rather than a silent column update.
    const afterStage = (await run(fixture.runs.findRun(ctx.runId)))!;
    assert.equal(afterStage.revision, revisionBefore + 1);

    const submitted = value(
      await run(
        fixture.operations.recordReceipt({ operationId: operation.id, stage: 'submitted' }),
      ),
    );
    assert.equal(submitted.stage, 'submitted');
    assert.equal(
      submitted.dispatchedAt,
      submitting.dispatchedAt,
      'dispatch time is when it first crossed, not when it last advanced',
    );
  } finally {
    fixture.close();
  }
});

test('settlement is monotonic, so a duplicate or late write is a no-op', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const operation = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'run_headless_agent',
          callIndex: 0,
          request: { value: { prompt: 'judge' } },
          fingerprintOf: { value: { prompt: 'judge' } },
          artifactHash: PIN,
        }),
      ),
    );

    // The originating attempt closes first. An operation settles long after that, which is exactly
    // why it cannot be fenced on attempt ownership.
    await run(
      fixture.runs.failSegment({
        runId: ctx.runId,
        attemptId: ctx.attemptId,
        owner: OWNER,
        ownerIncarnation: INCARNATION,
        code: 'node_callback_failed',
        message: 'callback gave up waiting',
      }),
    );

    const settled = value(
      await run(
        fixture.operations.settle({
          operationId: operation.id,
          state: 'completed',
          result: { value: { status: 'ok' } },
        }),
      ),
    );
    assert.equal(settled.state, 'completed');
    assert.ok(settled.settledAt);

    const duplicate = rejection(
      await run(fixture.operations.settle({ operationId: operation.id, state: 'failed' })),
    );
    assert.deepEqual(duplicate, { kind: 'operation_state_conflict', state: 'completed' });

    // A receipt arriving after settlement cannot walk it backwards either.
    assert.equal(
      rejection(
        await run(
          fixture.operations.recordReceipt({ operationId: operation.id, stage: 'started' }),
        ),
      ).kind,
      'operation_state_conflict',
    );
  } finally {
    fixture.close();
  }
});

test('late evidence is retained without reviving a settled operation', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const operation = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'run_headless_agent',
          callIndex: 0,
          request: { value: {} },
          fingerprintOf: { value: {} },
          artifactHash: PIN,
        }),
      ),
    );
    await run(fixture.operations.settle({ operationId: operation.id, state: 'interrupted' }));

    const withEvidence = value(
      await run(
        fixture.operations.recordLateEvidence({
          operationId: operation.id,
          evidence: { value: { exitCode: 0, observedAt: 'later' } },
        }),
      ),
    );
    assert.equal(withEvidence.state, 'interrupted', 'the settlement stands');
    assert.ok(withEvidence.lateEvidence);
    assert.deepEqual(await run(fixture.payloads.resolve(withEvidence.lateEvidence)), {
      exitCode: 0,
      observedAt: 'later',
    });
  } finally {
    fixture.close();
  }
});

test('a stop outcome is recorded once and never downgraded', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const operation = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'run_headless_agent',
          callIndex: 0,
          request: { value: {} },
          fingerprintOf: { value: {} },
          artifactHash: PIN,
        }),
      ),
    );
    assert.equal(operation.stopState, 'not_requested');

    const pending = value(
      await run(
        fixture.operations.recordStopOutcome({
          operationId: operation.id,
          stopState: 'pending',
          detail: 'termination requested, exit not observed',
        }),
      ),
    );
    assert.equal(pending.stopState, 'pending');
    assert.equal(pending.stopSettledAt, null, 'pending is not a settled stop');

    const confirmed = value(
      await run(
        fixture.operations.recordStopOutcome({ operationId: operation.id, stopState: 'confirmed' }),
      ),
    );
    assert.equal(confirmed.stopState, 'confirmed');
    assert.equal(
      confirmed.stopRequestedAt,
      pending.stopRequestedAt,
      'the request time is when it was asked for, not when it was answered',
    );

    // A stop request is never proof of stopping, and a later report cannot walk a confirmed stop
    // back to pending.
    assert.equal(
      rejection(
        await run(
          fixture.operations.recordStopOutcome({ operationId: operation.id, stopState: 'pending' }),
        ),
      ).kind,
      'operation_state_conflict',
    );
  } finally {
    fixture.close();
  }
});

test('blocking a terminal run records the operation without resurrecting the run', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const operation = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'send_agent_prompt',
          callIndex: 0,
          request: { value: {} },
          fingerprintOf: { value: {} },
          artifactHash: PIN,
        }),
      ),
    );

    const running = (await run(fixture.runs.findRun(ctx.runId)))!;
    await run(
      fixture.runs.applyCancel({ runId: running.id, controlRevision: running.controlRevision }),
    );

    // Reconciliation legitimately finds uncertainty on a cancelled run. That uncertainty belongs on
    // the operation; it is not a reason to make the run live again.
    await run(
      fixture.operations.settle({
        operationId: operation.id,
        state: 'uncertain',
        uncertaintyDetail: 'no turn found at or after the watermark',
      }),
    );
    const blocked = value(
      await run(fixture.runs.blockRun({ runId: ctx.runId, operationId: operation.id })),
    );
    assert.equal(blocked.blocked, false);

    const after = (await run(fixture.runs.findRun(ctx.runId)))!;
    assert.equal(after.status, 'cancelled');
    assert.equal(after.blockedOperationId, operation.id, 'the operation is still recorded');
    const settled = (await run(fixture.operations.findById(operation.id)))!;
    assert.equal(settled.state, 'uncertain');
  } finally {
    fixture.close();
  }
});

test('one call position holds one operation, enforced by the database', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    await run(
      fixture.operations.recordIntent({
        runId: ctx.runId,
        frameId: ctx.frameId,
        executionId: ctx.executionId,
        originAttemptId: ctx.attemptId,
        capability: 'close_pane',
        callIndex: 0,
        request: { value: {} },
        fingerprintOf: { value: {} },
        artifactHash: PIN,
      }),
    );
    assert.throws(
      () =>
        fixture.client
          .prepare(
            `INSERT INTO workflow_operations (
               operation_key, run_id, frame_id, execution_id, origin_attempt_id, capability,
               call_index, request_fingerprint, artifact_hash, state, target_kind, attribution,
               stop_state, created_at
             ) VALUES ('wop_other', ?, ?, ?, ?, 'close_pane', 0, ?, ?, 'intended', 'none',
                       'not_applicable', 'not_requested', '2026-01-01T00:00:00.000Z')`,
          )
          .run(ctx.runId, ctx.frameId, ctx.executionId, ctx.attemptId, 'f'.repeat(64), PIN),
      /UNIQUE constraint failed/,
    );
  } finally {
    fixture.close();
  }
});

/**
 * Builds a run with one execution and returns a helper that records operations against it, so the
 * recovery queries below have a realistic population rather than hand-inserted rows.
 */
async function operationWorld(fixture: WorkflowPersistenceFixture, title: string) {
  const ctx = await insideCallback(fixture);
  let callIndex = 0;
  const record = async (
    capability: Parameters<typeof fixture.operations.recordIntent>[0]['capability'],
  ) => {
    const operation = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability,
          callIndex: callIndex++,
          request: { value: { title } },
          fingerprintOf: { value: { title } },
          artifactHash: PIN,
        }),
      ),
    );
    return operation;
  };
  return { ...ctx, record };
}

test('recovery queries are deterministic, scoped to their run, and span the lifecycle', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const world = await operationWorld(fixture, 'first');

    const intended = await world.record('close_pane');
    const dispatched = await world.record('send_agent_prompt');
    const settled = await world.record('run_headless_agent');
    const owned = await world.record('spawn_agent_session');

    value(
      await run(
        fixture.operations.recordReceipt({ operationId: dispatched.id, stage: 'submitting' }),
      ),
    );
    value(await run(fixture.operations.settle({ operationId: settled.id, state: 'completed' })));
    value(
      await run(
        fixture.operations.recordReceipt({
          operationId: owned.id,
          stage: 'allocated',
          captureOwner: 'incarnation-1',
          ptyProcessId: 77,
        }),
      ),
    );

    // Unsettled spans both states an operation can still move from, and excludes the settled one.
    const unsettled = await run(fixture.operations.listUnsettled());
    assert.deepEqual(
      unsettled.map((operation) => operation.id),
      [intended.id, dispatched.id, owned.id],
      'ordered by id, so a caller gets the same answer twice',
    );
    assert.deepEqual(
      unsettled.map((operation) => operation.state),
      ['intended', 'dispatched', 'dispatched'],
    );

    // Capture ownership is its own dimension: only the headless operation this incarnation is
    // holding, and only while it can still move.
    assert.deepEqual(
      (await run(fixture.operations.listByCaptureOwner('incarnation-1'))).map((o) => o.id),
      [owned.id],
    );
    assert.deepEqual(await run(fixture.operations.listByCaptureOwner('another-incarnation')), []);

    assert.equal((await run(fixture.operations.findByKey(intended.operationKey)))?.id, intended.id);
    assert.equal(await run(fixture.operations.findByKey('wop_nonexistent')), null);
    assert.deepEqual(
      (await run(fixture.operations.listForRun(world.runId))).map((o) => o.id),
      [intended.id, dispatched.id, settled.id, owned.id],
    );
    assert.deepEqual(
      (await run(fixture.operations.listForExecution(world.executionId))).map((o) => o.callIndex),
      [0, 1, 2, 3],
      'call order, which is what prefix matching reads',
    );

    // A second run must not appear in the first one's recovery set.
    const other = await operationWorld(fixture, 'second');
    const otherOperation = await other.record('close_pane');
    assert.ok(
      !(await run(fixture.operations.listForRun(world.runId)))
        .map((o) => o.id)
        .includes(otherOperation.id),
    );
    assert.deepEqual(
      (await run(fixture.operations.listUnsettled({ runId: other.runId }))).map((o) => o.id),
      [otherOperation.id],
    );
  } finally {
    fixture.close();
  }
});

test('a pending stop is an obligation of its own, even on a settled operation', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const world = await operationWorld(fixture, 'stops');
    const settledWithPendingStop = await world.record('run_headless_agent');
    const settledAndStopped = await world.record('close_pane');
    const stillRunning = await world.record('send_agent_prompt');

    // Settling says the *operation* reached an outcome. It says nothing about whether the process
    // behind it is gone — a stop was requested and never observed to complete, and that obligation
    // outlives the settlement.
    value(
      await run(
        fixture.operations.settle({ operationId: settledWithPendingStop.id, state: 'failed' }),
      ),
    );
    value(
      await run(
        fixture.operations.recordStopOutcome({
          operationId: settledWithPendingStop.id,
          stopState: 'pending',
          detail: 'termination requested, exit not observed',
        }),
      ),
    );
    value(
      await run(
        fixture.operations.settle({ operationId: settledAndStopped.id, state: 'completed' }),
      ),
    );
    value(
      await run(
        fixture.operations.recordStopOutcome({
          operationId: settledAndStopped.id,
          stopState: 'confirmed',
        }),
      ),
    );

    const pending = await run(fixture.operations.listPendingStops());
    assert.deepEqual(
      pending.map((operation) => operation.id),
      [settledWithPendingStop.id],
      'a settled operation with an unfinished stop is still recovery work',
    );
    // And it is genuinely absent from the unsettled set, so neither query subsumes the other.
    assert.ok(
      !(await run(fixture.operations.listUnsettled()))
        .map((operation) => operation.id)
        .includes(settledWithPendingStop.id),
    );
    assert.ok(
      (await run(fixture.operations.listUnsettled()))
        .map((operation) => operation.id)
        .includes(stillRunning.id),
    );

    // An operation nobody asked to stop is not an obligation.
    assert.ok(!pending.map((operation) => operation.id).includes(stillRunning.id));
  } finally {
    fixture.close();
  }
});

test('a call position re-entered with a changed request is refused, not adopted', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    // The normalized request of a keyed pane split: the facts that decide *which* pane gets created
    // and where. They live here, in the operation's recorded request, which is why this is the seam
    // that can tell one split intent from another.
    const original = {
      worktreeId: 1,
      surfaceId: 7,
      sourcePaneId: 21,
      direction: 'right',
      newPane: { kind: 'agent_session', harness: 'claude' },
    };
    const intent = {
      runId: ctx.runId,
      frameId: ctx.frameId,
      executionId: ctx.executionId,
      originAttemptId: ctx.attemptId,
      capability: 'spawn_agent_session' as const,
      callIndex: 0,
      request: { value: original },
      fingerprintOf: { value: original },
      artifactHash: PIN,
    };
    const recorded = value(await run(fixture.operations.recordIntent(intent)));

    // The identical re-entry still adopts: that is the recovery path, and it must keep working.
    const adopted = value(await run(fixture.operations.recordIntent(intent)));
    assert.equal(adopted.id, recorded.id);

    // A different source pane on the *same* surface. Nothing about the destination surface changed,
    // so a surface-level check cannot see this — but it is a different intended split, and adopting
    // the earlier pane would silently give the caller a pane split from somewhere else.
    const movedSource = await run(
      fixture.operations.recordIntent({
        ...intent,
        request: { value: { ...original, sourcePaneId: 99 } },
        fingerprintOf: { value: { ...original, sourcePaneId: 99 } },
      }),
    );
    const movedRejection = rejection(movedSource);
    assert.equal(movedRejection.kind, 'operation_request_changed');
    assert.equal(
      movedRejection.kind === 'operation_request_changed'
        ? movedRejection.recordedFingerprint
        : null,
      recorded.requestFingerprint,
    );

    // A different direction, same source pane and surface.
    assert.equal(
      rejection(
        await run(
          fixture.operations.recordIntent({
            ...intent,
            request: { value: { ...original, direction: 'down' } },
            fingerprintOf: { value: { ...original, direction: 'down' } },
          }),
        ),
      ).kind,
      'operation_request_changed',
    );

    // And a different capability at the same position.
    assert.equal(
      rejection(await run(fixture.operations.recordIntent({ ...intent, capability: 'close_pane' })))
        .kind,
      'operation_request_changed',
    );

    // No refusal created a second operation, and the recorded one is untouched.
    assert.deepEqual(
      (await run(fixture.operations.listForExecution(ctx.executionId))).map((o) => o.id),
      [recorded.id],
    );
    assert.deepEqual(await run(fixture.operations.findById(recorded.id)), recorded);
  } finally {
    fixture.close();
  }
});

test('key order in a request does not make it a different request', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const intent = {
      runId: ctx.runId,
      frameId: ctx.frameId,
      executionId: ctx.executionId,
      originAttemptId: ctx.attemptId,
      capability: 'spawn_agent_session' as const,
      callIndex: 0,
      artifactHash: PIN,
    };
    const recorded = value(
      await run(
        fixture.operations.recordIntent({
          ...intent,
          request: { value: { sourcePaneId: 21, direction: 'right' } },
          fingerprintOf: { value: { sourcePaneId: 21, direction: 'right' } },
        }),
      ),
    );
    // Canonicalization is what makes the fingerprint a statement about the request rather than
    // about how the callback happened to build the object.
    const reordered = value(
      await run(
        fixture.operations.recordIntent({
          ...intent,
          request: { value: { direction: 'right', sourcePaneId: 21 } },
          fingerprintOf: { value: { direction: 'right', sourcePaneId: 21 } },
        }),
      ),
    );
    assert.equal(reordered.id, recorded.id);
  } finally {
    fixture.close();
  }
});

test('a Retry under an edited pin re-enters the same call unchanged', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const request = { value: { sourcePaneId: 21, direction: 'right' } };
    const recorded = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'spawn_agent_session',
          callIndex: 0,
          request,
          fingerprintOf: request,
          artifactHash: PIN,
        }),
      ),
    );

    // The pin is deliberately not part of the comparison: editing code and retrying is the whole
    // point of Retry, and a callback that reaches the same call position with the same request has
    // not changed its intended effect.
    const underNewPin = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'spawn_agent_session',
          callIndex: 0,
          request,
          fingerprintOf: request,
          artifactHash: 'e'.repeat(64),
        }),
      ),
    );
    assert.equal(underNewPin.id, recorded.id);
    assert.equal(underNewPin.artifactHash, PIN, 'the recorded pin is the one that recorded it');
  } finally {
    fixture.close();
  }
});

test('the first late evidence is immutable, and an identical repeat allocates no revision', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const operation = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'run_headless_agent',
          callIndex: 0,
          request: { value: { prompt: 'judge' } },
          fingerprintOf: { value: { prompt: 'judge' } },
          artifactHash: PIN,
        }),
      ),
    );
    value(
      await run(fixture.operations.settle({ operationId: operation.id, state: 'interrupted' })),
    );

    const observed = { reason: 'late_process_terminal', result: { status: 'completed' } };
    const first = value(
      await run(
        fixture.operations.recordLateEvidence({
          operationId: operation.id,
          evidence: { value: observed },
        }),
      ),
    );
    assert.ok(first.lateEvidence);
    const revisionsAfterFirst = revisionCount(fixture, ctx.runId);

    // The same observation reported twice is not two facts. It must not allocate a second revision,
    // or a client walking history would be handed the same thing again.
    const repeat = value(
      await run(
        fixture.operations.recordLateEvidence({
          operationId: operation.id,
          evidence: { value: observed },
        }),
      ),
    );
    assert.deepEqual(repeat.lateEvidence, first.lateEvidence);
    assert.equal(revisionCount(fixture, ctx.runId), revisionsAfterFirst);

    // A *different* later report does not get to redefine what the process did. The first thing
    // anyone actually saw is the thing worth keeping, and whichever report arrived last is not
    // evidence of anything.
    const conflicting = await run(
      fixture.operations.recordLateEvidence({
        operationId: operation.id,
        evidence: { value: { reason: 'late_process_terminal', result: { status: 'failed' } } },
      }),
    );
    assert.equal(rejection(conflicting).kind, 'late_evidence_conflict');

    const unchanged = (await run(fixture.operations.findById(operation.id)))!;
    assert.deepEqual(unchanged.lateEvidence, first.lateEvidence);
    assert.equal(unchanged.state, 'interrupted', 'and the settlement is untouched throughout');
    assert.equal(revisionCount(fixture, ctx.runId), revisionsAfterFirst);
  } finally {
    fixture.close();
  }
});

function revisionCount(fixture: WorkflowPersistenceFixture, runId: number): number {
  const row = fixture.client
    .prepare(`SELECT COUNT(*) AS total FROM workflow_transitions WHERE run_id = ?`)
    .get(runId) as { total: number };
  return row.total;
}

/**
 * The one escape from "abandoned is settled", and the fence around it.
 *
 * `abandoned` means the effect provably never left, so re-entering that call position and
 * completing it is honest rather than a conflict — but only for the caller that asks for it by
 * name. `settle` never passes the flag, which is what keeps every ordinary settlement path unable
 * to revive a row. The abandonment stays in the transition history either way: the row reads as
 * completed, and the record of what happened to it stays intact.
 */
test('only an explicit reopen can revive an abandoned operation', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const operation = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'capture_evidence',
          callIndex: 0,
          request: { value: { title: 'round two' } },
          fingerprintOf: { value: { title: 'round two' } },
          artifactHash: PIN,
        }),
      ),
    );

    // Intent recorded, nothing committed: reconciliation settles the position `abandoned` with the
    // reason as its result, which is the convention the headless abandon branch already uses.
    const abandoned = value(
      await run(
        fixture.operations.settle({
          operationId: operation.id,
          state: 'abandoned',
          result: { value: { reason: 'capture_not_committed' } },
        }),
      ),
    );
    assert.equal(abandoned.state, 'abandoned');

    // The ordinary path still refuses it. Nothing but the capture commit may move this row.
    assert.deepEqual(
      rejection(
        await run(
          fixture.operations.settle({
            operationId: operation.id,
            state: 'completed',
            result: { value: { evidenceKey: 'wev_1' } },
          }),
        ),
      ),
      { kind: 'operation_state_conflict', state: 'abandoned' },
    );

    const result = await run(fixture.payloads.publish({ evidenceKey: 'wev_1' }));
    // An injected clock, not the wall one. The reopen and the abandonment it overwrites are
    // milliseconds apart, so asserting the timestamp merely *changed* would be a race: two
    // `new Date()` readings can legitimately land on the same millisecond, and a test that passes
    // by luck reads as coverage without being any.
    const reopenedAt = '2099-01-01T00:00:00.000Z';
    const reopened = value(
      await run(
        fixture.database.transaction('test_reopen', (db) => {
          const row = db
            .select()
            .from(workflowOperations)
            .where(eq(workflowOperations.id, operation.id))
            .get()!;
          return settleOperationWithin(db, {
            row,
            state: 'completed',
            result,
            reopenAbandoned: true,
            now: reopenedAt,
          });
        }),
      ),
    );
    assert.equal(reopened.state, 'completed');
    // `settled_at` is rewritten, not merely still set: the row now names when it *completed*, and
    // the abandonment's own timestamp does not survive as the settlement time of a finished row.
    assert.equal(reopened.settledAt, reopenedAt);
    assert.notEqual(reopened.settledAt, abandoned.settledAt);
    // The *new* result, not the abandonment's reason: a revived row must say what settled it.
    assert.deepEqual(await run(fixture.payloads.resolve(reopened.result!)), {
      evidenceKey: 'wev_1',
    });

    // Two settlements in history, in order. The abandonment was not rewritten away.
    const transitions = fixture.client
      .prepare(`SELECT kind FROM workflow_transitions WHERE operation_id = ? ORDER BY id ASC`)
      .all(operation.id) as { kind: string }[];
    assert.deepEqual(
      transitions.map((row) => row.kind),
      ['operation_recorded', 'operation_settled', 'operation_settled'],
    );
  } finally {
    fixture.close();
  }
});

/**
 * Reviving a row without saying what settled it would write a self-contradiction: a `completed`
 * operation still carrying the reason it was abandoned. The only caller that passes the flag always
 * has an evidence key to record, so this is a precondition rather than a fallback — it fails loudly
 * instead of quietly producing a record nobody could interpret.
 */
test('reopening an abandoned operation without a result is a defect, not a silent overwrite', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const ctx = await insideCallback(fixture);
    const operation = value(
      await run(
        fixture.operations.recordIntent({
          runId: ctx.runId,
          frameId: ctx.frameId,
          executionId: ctx.executionId,
          originAttemptId: ctx.attemptId,
          capability: 'capture_evidence',
          callIndex: 0,
          request: { value: { title: 'no result' } },
          fingerprintOf: { value: { title: 'no result' } },
          artifactHash: PIN,
        }),
      ),
    );
    await run(
      fixture.operations.settle({
        operationId: operation.id,
        state: 'abandoned',
        result: { value: { reason: 'capture_not_committed' } },
      }),
    );

    await assert.rejects(
      run(
        fixture.database.transaction('test_reopen_without_result', (db) => {
          const row = db
            .select()
            .from(workflowOperations)
            .where(eq(workflowOperations.id, operation.id))
            .get()!;
          return settleOperationWithin(db, {
            row,
            state: 'completed',
            result: null,
            reopenAbandoned: true,
            now: new Date().toISOString(),
          });
        }),
      ),
      /cannot be reopened from abandoned without a result/,
    );

    // And it really did not move.
    assert.equal((await run(fixture.operations.findById(operation.id)))!.state, 'abandoned');
  } finally {
    fixture.close();
  }
});

/**
 * `findSubmission` is how captured evidence is attributed to the turn that produced it.
 *
 * The run scoping is the part that matters most. Two runs can legitimately drive the same agent
 * session, and an operation borrowed from the other run would make the evidence claim a provenance
 * that never happened — a confident false statement, which is strictly worse than the honest
 * `unresolved` the caller records when nothing matches.
 */
test('a submission lookup is scoped to its run, its session and its watermark', async () => {
  const fixture = makeWorkflowPersistenceFixture();
  try {
    const first = await insideCallback(fixture);
    const second = await insideCallback(fixture);
    assert.notEqual(first.runId, second.runId, 'The two runs must really be distinct.');

    const submit = async (
      ctx: Awaited<ReturnType<typeof insideCallback>>,
      callIndex: number,
      watermark: string,
    ) => {
      const operation = value(
        await run(
          fixture.operations.recordIntent({
            runId: ctx.runId,
            frameId: ctx.frameId,
            executionId: ctx.executionId,
            originAttemptId: ctx.attemptId,
            capability: 'send_agent_prompt',
            callIndex,
            request: { value: { prompt: watermark } },
            fingerprintOf: { value: { prompt: watermark } },
            artifactHash: PIN,
          }),
        ),
      );
      return value(
        await run(
          fixture.operations.recordReceipt({
            operationId: operation.id,
            stage: 'submitted',
            targetKind: 'agent_session',
            targetId: 42,
            submissionWatermark: watermark,
          }),
        ),
      );
    };

    const older = await submit(first, 0, '2026-01-01T00:00:00.000Z');
    const newer = await submit(first, 1, '2026-01-02T00:00:00.000Z');
    const otherRun = await submit(second, 0, '2026-01-03T00:00:00.000Z');

    // Without a watermark: the latest submission this run made to that session.
    assert.equal(
      (await run(fixture.operations.findSubmission({ runId: first.runId, agentSessionId: 42 })))!
        .id,
      newer.id,
    );
    // With one: that exact turn, even though a later submission exists.
    assert.equal(
      (await run(
        fixture.operations.findSubmission({
          runId: first.runId,
          agentSessionId: 42,
          submissionWatermark: '2026-01-01T00:00:00.000Z',
        }),
      ))!.id,
      older.id,
    );
    // The other run's submission is the newest row overall and must never be returned here.
    assert.equal(
      (await run(fixture.operations.findSubmission({ runId: second.runId, agentSessionId: 42 })))!
        .id,
      otherRun.id,
    );
    assert.notEqual(
      (await run(fixture.operations.findSubmission({ runId: first.runId, agentSessionId: 42 })))!
        .id,
      otherRun.id,
    );
    // A session nobody sent to, and a watermark nobody recorded, are both honest misses.
    assert.equal(
      await run(fixture.operations.findSubmission({ runId: first.runId, agentSessionId: 99 })),
      null,
    );
    assert.equal(
      await run(
        fixture.operations.findSubmission({
          runId: first.runId,
          agentSessionId: 42,
          submissionWatermark: 'never-sent',
        }),
      ),
      null,
    );
  } finally {
    fixture.close();
  }
});
