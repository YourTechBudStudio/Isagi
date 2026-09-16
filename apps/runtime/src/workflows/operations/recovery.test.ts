import assert from 'node:assert/strict';
import test from 'node:test';

import type { OperationContext } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import type { WorkflowOperationRecord } from '../persistence/records.js';
import { terminalForFixedAssociation } from '../waits/conditions.js';
import { OperationRejection } from './errors.js';
import {
  crashingOperationsRepository,
  makeOperationHarness,
  run,
  runCallback,
  type OperationHarness,
} from './test-support.js';

const prompt = { harness: 'claude' as const, prompt: 'judge this' };

/**
 * Run one attempt, tolerating a simulated crash.
 *
 * A crash is not an outcome the caller inspects — the process is gone. What matters is the durable
 * state it leaves, which every test below reads from the database afterwards.
 */
async function attempt(
  harness: OperationHarness,
  callback: (ctx: OperationContext) => Promise<unknown>,
  options?: Parameters<OperationHarness['service']>[0],
) {
  const built = await harness.service(options ?? {});
  try {
    return await runCallback(
      built.service.withAttemptContext(harness.identity, (ctx) =>
        Effect.tryPromise({ try: () => callback(ctx), catch: (cause) => cause }),
      ),
    ).catch((cause) => ({ crashed: cause }));
  } finally {
    await built.close();
  }
}

async function reconcile(harness: OperationHarness, incarnationId: string) {
  const built = await harness.service({ incarnationId });
  try {
    return await Effect.runPromise(built.service.reconcileExecution(harness.identity.executionId));
  } finally {
    await built.close();
  }
}

async function onlyOperation(harness: OperationHarness): Promise<WorkflowOperationRecord> {
  const records = await run(
    harness.fixture.operations.listForExecution(harness.identity.executionId),
  );
  assert.equal(records.length, 1, 'exactly one call position should have been recorded');
  return records[0]!;
}

async function runStatus(harness: OperationHarness) {
  const record = await run(harness.fixture.runs.findRun(harness.identity.runId));
  return record!;
}

// --- headless launch evidence, one test per recorded stage ---------------------------------------

test('a crash before the marker that precedes `start` settles abandoned and stays dispatchable', async () => {
  const harness = await makeOperationHarness();
  try {
    await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt), {
      incarnationId: 'incarnation-a',
      operations: crashingOperationsRepository(harness.fixture.operations, {
        stages: ['starting'],
      }),
    });
    const crashed = await onlyOperation(harness);
    assert.equal(crashed.stage, 'allocated');
    assert.equal(harness.state.counters.starts, 0, '`start` was never called');
    // The reservation is released by the scoped acquire, so an allocation nobody owns does not leak.
    assert.deepEqual(harness.state.abandoned, [crashed.ptyProcessId]);

    await reconcile(harness, 'incarnation-b');
    const settled = await onlyOperation(harness);
    assert.equal(settled.state, 'abandoned');

    // Re-entry dispatches under the *same* operation identity, which is what "dispatch stays
    // eligible" means concretely — not a second operation at the same call position.
    const resumed = await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt), {
      incarnationId: 'incarnation-b',
    });
    const after = await onlyOperation(harness);
    assert.equal(after.operationKey, crashed.operationKey);
    assert.equal(after.stage, 'started');
    assert.equal(harness.state.counters.starts, 1, 'exactly one launch reached a backend');
    assert.equal(
      (resumed as { value: { operationId: string } }).value.operationId,
      crashed.operationKey,
    );
  } finally {
    harness.close();
  }
});

test('a crash inside the one-write-wide `starting` window blocks rather than guessing', async () => {
  const harness = await makeOperationHarness();
  try {
    await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt), {
      incarnationId: 'incarnation-a',
      operations: crashingOperationsRepository(harness.fixture.operations, { stages: ['started'] }),
    });
    assert.equal((await onlyOperation(harness)).stage, 'starting');

    const outcome = await reconcile(harness, 'incarnation-b');
    const settled = await onlyOperation(harness);
    assert.equal(settled.state, 'uncertain');
    assert.equal(settled.uncertaintyDetail, 'headless_launch_outcome_unrecorded');
    assert.equal(outcome.uncertainOperationId, settled.id);
    // Blocked, not failed: `start` may have been interrupted, may have spawned, or may have failed,
    // and no process inspection can tell those apart.
    assert.equal((await runStatus(harness)).status, 'blocked');
    assert.equal(harness.state.counters.allocations, 1, 'no second agent was launched');
  } finally {
    harness.close();
  }
});

test('an interrupted `start` returns nothing at all and is classified indeterminate', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.launchOutcomes = [{ kind: 'interrupted' }];
    await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt), {
      incarnationId: 'incarnation-a',
    });
    assert.equal((await onlyOperation(harness)).stage, 'starting');

    await reconcile(harness, 'incarnation-b');
    assert.equal((await onlyOperation(harness)).state, 'uncertain');
  } finally {
    harness.close();
  }
});

test('a started launch whose capture owner ended is a confirmed interruption', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.capturedOutput.set(900, { raw: 'partial', output: 'partial' });
    await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt), {
      incarnationId: 'incarnation-a',
    });
    assert.equal((await onlyOperation(harness)).stage, 'started');

    await reconcile(harness, 'incarnation-b');
    const settled = await onlyOperation(harness);
    assert.equal(settled.state, 'interrupted');
    const result = (await run(harness.fixture.payloads.resolve(settled.result!))) as Record<
      string,
      unknown
    >;
    assert.equal(result.status, 'interrupted');
    const interruption = result.interruption as Record<string, unknown>;
    assert.equal(interruption.reason, 'capture_owner_lost');
    // Retained as diagnostic material, never as an accepted judgment.
    assert.equal(interruption.partialOutput, 'partial');
    // Stop completeness is a separate fact, reported rather than assumed.
    assert.deepEqual(interruption.stop, { state: 'confirmed', detail: settled.stopDetail });
    assert.equal(settled.stopState, 'confirmed');
    assert.equal(harness.state.counters.terminations, 1);
  } finally {
    harness.close();
  }
});

test('a stop that cannot be observed stays pending and never reads as a stopped process', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.terminateOutcome = () =>
      Object.assign(new Error('PTY backend node_pty is unavailable.'), {
        code: 'backend_unavailable',
      });
    await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt), {
      incarnationId: 'incarnation-a',
    });
    await reconcile(harness, 'incarnation-b');

    const settled = await onlyOperation(harness);
    assert.equal(settled.state, 'interrupted');
    assert.equal(settled.stopState, 'pending', 'an unobservable stop is not a failed stop');
    assert.notEqual(settled.stopState, 'confirmed');
  } finally {
    harness.close();
  }
});

test('a committed result wins over capture-owner loss', async () => {
  const harness = await makeOperationHarness();
  try {
    const built = await harness.service({ incarnationId: 'incarnation-a' });
    let key = '';
    try {
      const outcome = await runCallback(
        built.service.withAttemptContext(harness.identity, (ctx) =>
          Effect.tryPromise({ try: () => ctx.runHeadlessAgent(prompt), catch: (c) => c }),
        ),
      );
      key = outcome.value.operationId;
      const record = (await run(harness.fixture.operations.findByKey(key)))!;
      await run(
        harness.fixture.operations.settle({
          operationId: record.id,
          state: 'completed',
          result: { value: { operationId: key, status: 'completed', output: 'done' } },
        }),
      );
    } finally {
      await built.close();
    }

    await reconcile(harness, 'incarnation-b');
    const settled = (await run(harness.fixture.operations.findByKey(key)))!;
    assert.equal(settled.state, 'completed', 'a committed result is never downgraded');
    assert.equal(harness.state.counters.terminations, 0, 'nothing was stopped');
  } finally {
    harness.close();
  }
});

test('an intent with no allocated process stays eligible rather than interrupted', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.failures.set('allocate', new Error('allocation refused'));
    await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt), {
      incarnationId: 'incarnation-a',
    });
    const recorded = await onlyOperation(harness);
    assert.equal(recorded.state, 'intended');
    assert.equal(recorded.ptyProcessId, null);

    await reconcile(harness, 'incarnation-b');
    const after = await onlyOperation(harness);
    // Absence of a *result* proves nothing on its own; absence of an *allocation* does.
    assert.equal(after.state, 'intended');
    assert.equal((await runStatus(harness)).status !== 'blocked', true);

    harness.state.failures.delete('allocate');
    await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt), {
      incarnationId: 'incarnation-b',
    });
    const dispatched = await onlyOperation(harness);
    assert.equal(dispatched.operationKey, recorded.operationKey);
    assert.equal(dispatched.stage, 'started');
  } finally {
    harness.close();
  }
});

// --- live launch failures ------------------------------------------------------------------------

test('a preparation failure rejects the capability and never fabricates an agent outcome', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.launchOutcomes = [
      { kind: 'preparation_failed', cause: 'harness binary missing' },
    ];
    const built = await harness.service({ incarnationId: 'incarnation-a' });
    let rejection: unknown;
    try {
      await runCallback(
        built.service.withAttemptContext(harness.identity, (ctx) =>
          Effect.tryPromise({ try: () => ctx.runHeadlessAgent(prompt), catch: (c) => c }),
        ),
      );
    } catch (cause) {
      rejection = cause;
    } finally {
      await built.close();
    }
    assert.ok(rejection instanceof OperationRejection);
    assert.equal((rejection as OperationRejection).code, 'workflow_operation_launch_failed');

    const settled = await onlyOperation(harness);
    // `abandoned`, not `failed`: nothing reached a backend, so there is no operational outcome to
    // route on, and a fabricated failed result would burn one of the author's bounded retry rounds.
    assert.equal(settled.state, 'abandoned');
    assert.equal(settled.stage, 'launch_failed');

    // Explicit Retry re-enters, finds the abandoned position, and dispatches **once** under the same
    // identity. Asserted by counting, not by the run completing.
    harness.state.launchOutcomes = [{ kind: 'spawned' }];
    const retried = await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt), {
      incarnationId: 'incarnation-a',
    });
    const after = await onlyOperation(harness);
    assert.equal(after.operationKey, settled.operationKey);
    assert.equal(harness.state.counters.starts, 2, 'one failed preparation, one real launch');
    assert.equal(
      (retried as { value: { operationId: string } }).value.operationId,
      settled.operationKey,
    );
  } finally {
    harness.close();
  }
});

test('a caught preparation failure still accounts for its recorded call position', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.launchOutcomes = [
      { kind: 'preparation_failed', cause: 'harness binary missing' },
      { kind: 'spawned' },
    ];
    const outcome = await attempt(harness, async (ctx) => {
      await ctx.runHeadlessAgent(prompt).catch(() => null);
      return 'handled';
    });
    // The position was claimed before the failure, so the prefix is accounted for even though the
    // author swallowed the rejection. Counting only successful calls would let a caught failure
    // silently shift every later effect's index.
    assert.equal((outcome as { consumedCallCount: number }).consumedCallCount, 1);
    assert.equal((outcome as { recordedCallCount: number }).recordedCallCount, 1);
  } finally {
    harness.close();
  }
});

test('a post-spawn failure is a confirmed operation failure with a process that may still be live', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.launchOutcomes = [
      { kind: 'spawn_failed', cause: 'onData registration threw after spawn' },
    ];
    const outcome = await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt));

    // The callback *did* receive a handle: an agent invocation really was attempted and really
    // failed, and that is data the author's declared failure route consumes.
    assert.ok((outcome as { value?: { operationId: string } }).value?.operationId);

    const settled = await onlyOperation(harness);
    assert.equal(settled.state, 'failed', 'not `abandoned` — the spawn may have succeeded');
    const result = (await run(harness.fixture.payloads.resolve(settled.result!))) as Record<
      string,
      unknown
    >;
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'onData registration threw after spawn');
    // A stop is requested because the process may be live, and its completeness is recorded
    // separately. A failed operation is never proof that its process is gone.
    assert.equal(harness.state.counters.terminations, 1);
    assert.equal(settled.stopState, 'confirmed');
    assert.notEqual(settled.state, settled.stopState);

    // Never redispatch under the same identity. A retry route is a *new* execution and a new
    // operation, which this layer expresses by reusing the settled receipt instead of launching.
    const before = harness.state.counters.starts;
    await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    assert.equal(harness.state.counters.starts, before);
  } finally {
    harness.close();
  }
});

// --- submission boundaries -----------------------------------------------------------------------

const seed = { harness: 'claude' as const, prompt: 'start here' };

test('a crash after the PTY write and before its confirmation never resends the prompt', async () => {
  const harness = await makeOperationHarness();
  try {
    await attempt(harness, (ctx) => ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' }), {
      incarnationId: 'incarnation-a',
      operations: crashingOperationsRepository(harness.fixture.operations, {
        stages: ['submitted'],
      }),
    });
    const crashed = await onlyOperation(harness);
    assert.equal(crashed.stage, 'submitting');
    assert.equal(harness.state.counters.promptWrites, 1);
    // Everything recovery needs, persisted before the write it describes.
    assert.equal(crashed.targetId, 42);
    assert.ok(crashed.ptyProcessId !== null);
    assert.ok(crashed.submissionWatermark !== null);

    // A turn that started after the watermark: the association is fixed and the receipt becomes
    // reusable, reconstructed from the persisted fields alone.
    harness.state.turnEdges.set(42, [
      {
        type: 'turn_started',
        agentSessionId: 42,
        harnessSessionId: 'h1',
        seq: 1,
        recordedAt: '2026-06-18T23:59:59.000Z',
      },
    ]);
    await reconcile(harness, 'incarnation-b');
    const settled = await onlyOperation(harness);
    assert.equal(settled.stage, 'submitted');
    assert.equal(settled.attribution, 'inferred_by_watermark');
    assert.equal(settled.correlatedStartSeq, 1);
    assert.equal(settled.correlatedHarnessSessionId, 'h1');

    const resumed = await attempt(harness, (ctx) =>
      ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' }),
    );
    assert.equal(harness.state.counters.promptWrites, 1, 'the prompt was never sent twice');
    assert.equal(
      (resumed as { value: { sentAt: string } }).value.sentAt,
      crashed.submissionWatermark,
    );
  } finally {
    harness.close();
  }
});

test('no turn after the watermark settles uncertain rather than resending or failing', async () => {
  const harness = await makeOperationHarness();
  try {
    await attempt(harness, (ctx) => ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' }), {
      incarnationId: 'incarnation-a',
      operations: crashingOperationsRepository(harness.fixture.operations, {
        stages: ['submitted'],
      }),
    });
    await reconcile(harness, 'incarnation-b');

    const settled = await onlyOperation(harness);
    assert.equal(settled.state, 'uncertain');
    assert.equal(settled.uncertaintyDetail, 'no_turn_observed_after_submission');
    assert.equal((await runStatus(harness)).status, 'blocked');
    assert.equal(harness.state.counters.promptWrites, 1, 'recovery wrote nothing to the PTY');

    // Retry cannot convert uncertainty into an outcome, and it cannot resend.
    const built = await harness.service({ incarnationId: 'incarnation-c' });
    try {
      let rejection: unknown;
      await runCallback(
        built.service.withAttemptContext(harness.identity, (ctx) =>
          Effect.tryPromise({
            try: () => ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' }),
            catch: (c) => c,
          }),
        ),
      ).catch((cause) => {
        rejection = cause;
      });
      assert.ok(rejection instanceof OperationRejection);
      assert.equal((rejection as OperationRejection).code, 'operation_uncertain');
    } finally {
      await built.close();
    }
    assert.equal(harness.state.counters.promptWrites, 1);
  } finally {
    harness.close();
  }
});

test('a turn that started before the watermark is not ours', async () => {
  const harness = await makeOperationHarness();
  try {
    await attempt(harness, (ctx) => ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' }), {
      incarnationId: 'incarnation-a',
      now: () => '2026-06-18T00:00:10.000Z',
      operations: crashingOperationsRepository(harness.fixture.operations, {
        stages: ['submitted'],
      }),
    });
    harness.state.turnEdges.set(42, [
      {
        type: 'turn_started',
        agentSessionId: 42,
        harnessSessionId: 'h1',
        seq: 1,
        recordedAt: '2026-06-18T00:00:09.000Z',
      },
    ]);
    await reconcile(harness, 'incarnation-b');
    assert.equal((await onlyOperation(harness)).state, 'uncertain');
  } finally {
    harness.close();
  }
});

test('two competing starts settle ambiguous and block', async () => {
  const harness = await makeOperationHarness();
  try {
    await attempt(harness, (ctx) => ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' }), {
      incarnationId: 'incarnation-a',
      now: () => '2026-06-18T00:00:10.000Z',
      operations: crashingOperationsRepository(harness.fixture.operations, {
        stages: ['submitted'],
      }),
    });
    harness.state.turnEdges.set(42, [
      {
        type: 'turn_started',
        agentSessionId: 42,
        harnessSessionId: 'h1',
        seq: 1,
        recordedAt: '2026-06-18T00:00:11.000Z',
      },
      {
        type: 'turn_started',
        agentSessionId: 42,
        harnessSessionId: 'h2',
        seq: 1,
        recordedAt: '2026-06-18T00:00:12.000Z',
      },
    ]);
    await reconcile(harness, 'incarnation-b');
    const settled = await onlyOperation(harness);
    assert.equal(settled.state, 'uncertain');
    assert.equal(settled.uncertaintyDetail, 'ambiguous_turn_attribution:2');
  } finally {
    harness.close();
  }
});

test('a fixed association delivers the superseded terminal, not an ambiguity', async () => {
  const harness = await makeOperationHarness();
  try {
    await attempt(harness, (ctx) => ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' }), {
      incarnationId: 'incarnation-a',
      now: () => '2026-06-18T00:00:10.000Z',
      operations: crashingOperationsRepository(harness.fixture.operations, {
        stages: ['submitted'],
      }),
    });
    // The shape `reducePiLifecycle` really produces: a second start interrupts the turn ours
    // caused, and the harness emits a `turn_failed` carrying the *superseded* turn's seq.
    harness.state.turnEdges.set(42, [
      {
        type: 'turn_started',
        agentSessionId: 42,
        harnessSessionId: 'h1',
        seq: 1,
        recordedAt: '2026-06-18T00:00:11.000Z',
      },
      {
        type: 'turn_started',
        agentSessionId: 42,
        harnessSessionId: 'h1',
        seq: 2,
        recordedAt: '2026-06-18T00:00:12.000Z',
      },
      {
        type: 'turn_failed',
        agentSessionId: 42,
        harnessSessionId: 'h1',
        seq: 1,
        recordedAt: '2026-06-18T00:00:12.000Z',
        reason: 'new_start_supersedes',
      },
    ]);
    await reconcile(harness, 'incarnation-b');

    const settled = await onlyOperation(harness);
    // Not `uncertain`: the runtime can fully explain this turn, and blocking a run whose outcome is
    // confirmed would be the expensive kind of caution.
    assert.notEqual(settled.state, 'uncertain');
    assert.equal(settled.stage, 'submitted');
    assert.equal(settled.correlatedStartSeq, 1);
    assert.equal(settled.attribution, 'inferred_by_watermark');

    // And the persisted association resolves to the confirmed interruption, which is the classified
    // result the author's edge will see — not merely that the columns were filled in.
    const terminal = terminalForFixedAssociation(
      {
        agentSessionId: 42,
        sentAt: settled.submissionWatermark!,
        harnessSessionId: settled.correlatedHarnessSessionId!,
        startSeq: settled.correlatedStartSeq,
      },
      harness.state.turnEdges.get(42)!,
    );
    assert.equal(terminal?.type, 'turn_failed');
    assert.equal(terminal?.reason, 'new_start_supersedes');
    assert.equal(
      terminal?.seq,
      1,
      'the terminal paired to the turn we caused, not to the later one',
    );
  } finally {
    harness.close();
  }
});

test('a crash after the owner created the compound but before any receipt adopts it', async () => {
  const harness = await makeOperationHarness();
  try {
    // §10.8's first row: the operation is still `intended` with no stage, yet a real pane and
    // session exist under its key. Nothing recorded them, so only the owner can say what this
    // operation already owns — and a recovery that asked the operation instead would create a
    // second pane in the person's workspace.
    await attempt(harness, (ctx) => ctx.spawnAgentSession(seed), {
      incarnationId: 'incarnation-a',
      operations: crashingOperationsRepository(harness.fixture.operations, {
        stages: ['session_created'],
      }),
    });
    const crashed = await onlyOperation(harness);
    assert.equal(crashed.state, 'intended');
    assert.equal(crashed.stage, null, 'no receipt was ever written');
    assert.equal(crashed.targetId, null);
    assert.equal(harness.state.counters.spawnCreate, 1, 'but the owner really did create it');
    assert.equal(harness.state.counters.promptWrites, 0);

    // A fresh service, as after a restart. Reconciliation has nothing to settle here — an intent
    // with no recorded effect is eligible, not uncertain — and the redispatch adopts through the key.
    const outcome = await reconcile(harness, 'incarnation-b');
    assert.equal(outcome.uncertainOperationId, null);
    assert.notEqual((await runStatus(harness)).status, 'blocked');

    const resumed = await attempt(harness, (ctx) => ctx.spawnAgentSession(seed), {
      incarnationId: 'incarnation-b',
    });
    const after = await onlyOperation(harness);
    assert.equal(after.operationKey, crashed.operationKey, 'the same operation, not a second one');
    assert.equal(after.stage, 'seed_submitted');
    assert.equal(
      (resumed as { value: { agentSessionId: number; paneId: number } }).value.agentSessionId,
      after.targetId,
    );
    // The decisive counts: the keyed call ran again and resolved to what already existed, and the
    // seed crossed the boundary exactly once.
    assert.equal(harness.state.counters.spawnCreate, 2);
    assert.equal(harness.state.counters.promptWrites, 1);
    assert.equal(harness.state.nextAgentSessionId, 501, 'no second agent session was allocated');
    assert.equal(harness.state.nextPaneId, 701, 'and no second pane');
  } finally {
    harness.close();
  }
});

test('durable diagnostics may be appended after Cancel, and advance nothing', async () => {
  const harness = await makeOperationHarness();
  try {
    const current = await runStatus(harness);
    await run(
      harness.fixture.runs.applyCancel({
        runId: harness.identity.runId,
        controlRevision: current.controlRevision,
      }),
    );
    const cancelled = await runStatus(harness);

    const built = await harness.service();
    try {
      // Forgetting what already happened is what would make a cancelled run unexplainable. A
      // diagnostic written while the run is winding down is exactly the one worth keeping.
      await runCallback(
        built.service.withAttemptContext(harness.identity, (ctx) =>
          Effect.tryPromise({
            try: async () => {
              await ctx.log('warning', 'cleaning up after cancellation');
              await ctx.setUiFeedback({ phase: 'cancelled', message: 'stopping' });
            },
            catch: (cause) => cause,
          }),
        ),
      );
    } finally {
      await built.close();
    }

    const logs = harness.fixture.client
      .prepare(
        `SELECT kind, attempt_id FROM workflow_transitions
           WHERE run_id = ? AND kind IN ('log', 'ui_feedback') ORDER BY revision`,
      )
      .all(harness.identity.runId) as { kind: string; attempt_id: number }[];
    assert.deepEqual(
      logs.map((row) => row.kind),
      ['log', 'ui_feedback'],
      'both are retained',
    );
    assert.equal(logs[0]!.attempt_id, harness.identity.attemptId);

    const after = await runStatus(harness);
    assert.equal(after.status, 'cancelled', 'recording is not reviving');
    assert.deepEqual(after.position, cancelled.position, 'and it advances nothing');
    assert.equal(after.activeFrameId, cancelled.activeFrameId);
  } finally {
    harness.close();
  }
});

test('a crash before the seed write leaves resources recorded and resuming is safe', async () => {
  const harness = await makeOperationHarness();
  try {
    await attempt(harness, (ctx) => ctx.spawnAgentSession(seed), {
      incarnationId: 'incarnation-a',
      operations: crashingOperationsRepository(harness.fixture.operations, {
        stages: ['seed_submitting'],
      }),
    });
    const crashed = await onlyOperation(harness);
    assert.equal(crashed.stage, 'session_created');
    assert.equal(harness.state.counters.promptWrites, 0, 'no PTY write happened');
    assert.equal(harness.state.counters.spawnCreate, 1);

    const resumed = await attempt(harness, (ctx) => ctx.spawnAgentSession(seed), {
      incarnationId: 'incarnation-b',
    });
    // The keyed owner call adopts the existing compound rather than creating a second pane or a
    // second agent session.
    assert.equal(harness.state.counters.spawnCreate, 2, 'the keyed call ran again');
    const after = await onlyOperation(harness);
    assert.equal(after.stage, 'seed_submitted');
    assert.equal(
      (resumed as { value: { agentSessionId: number } }).value.agentSessionId,
      crashed.targetId,
      'the same session, not a second one',
    );
    assert.equal(harness.state.counters.promptWrites, 1);
  } finally {
    harness.close();
  }
});

test('a seed handshake failure keeps the confirmed receipt and never reseeds', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.failures.set('awaitSeedAcknowledgement', new Error('harness never answered'));
    await attempt(harness, (ctx) => ctx.spawnAgentSession(seed), {
      incarnationId: 'incarnation-a',
    });
    const recorded = await onlyOperation(harness);
    // The write returned, and that is all `seed_submitted` ever claimed. Losing the receipt because
    // a later handshake timed out would leave a prompt that really was sent with nothing recording
    // it — and the next attempt would send it again.
    assert.equal(recorded.stage, 'seed_submitted');
    assert.equal(harness.state.counters.promptWrites, 1);

    harness.state.failures.delete('awaitSeedAcknowledgement');
    const resumed = await attempt(harness, (ctx) => ctx.spawnAgentSession(seed), {
      incarnationId: 'incarnation-a',
    });
    assert.equal(harness.state.counters.promptWrites, 1, 'the seed was never sent twice');
    assert.equal(
      harness.state.counters.seedAcknowledgements,
      0,
      'receipt reuse does not re-run the live handshake, which would re-send a submit key',
    );
    assert.ok((resumed as { value: { paneId: number } }).value.paneId);
  } finally {
    harness.close();
  }
});

// --- run status, blocking and stop ---------------------------------------------------------------

test('reconciling a cancelled run records uncertainty without reviving it', async () => {
  const harness = await makeOperationHarness();
  try {
    await attempt(harness, (ctx) => ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' }), {
      incarnationId: 'incarnation-a',
      operations: crashingOperationsRepository(harness.fixture.operations, {
        stages: ['submitted'],
      }),
    });
    const current = await runStatus(harness);
    await run(
      harness.fixture.runs.applyCancel({
        runId: harness.identity.runId,
        controlRevision: current.controlRevision,
      }),
    );

    await reconcile(harness, 'incarnation-b');
    const settled = await onlyOperation(harness);
    assert.equal(settled.state, 'uncertain', 'the uncertainty lands on the operation');
    const after = await runStatus(harness);
    assert.equal(after.status, 'cancelled', 'and never resurrects the run');
    assert.equal(after.blockedOperationId, settled.id, 'while still naming what is unresolved');
  } finally {
    harness.close();
  }
});

test('an uncertain operation whose block never committed is repaired on the next pass', async () => {
  const harness = await makeOperationHarness();
  try {
    const first = await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    const record = (await run(
      harness.fixture.operations.findByKey(
        (first as { value: { operationId: string } }).value.operationId,
      ),
    ))!;
    // Settling and blocking are two transactions, so this is a reachable durable state, not a
    // contrived one.
    await run(
      harness.fixture.operations.settle({
        operationId: record.id,
        state: 'uncertain',
        uncertaintyDetail: 'crash between settle and block',
      }),
    );
    assert.notEqual((await runStatus(harness)).status, 'blocked');

    const outcome = await reconcile(harness, 'incarnation-b');
    assert.equal(outcome.uncertainOperationId, record.id);
    assert.equal((await runStatus(harness)).status, 'blocked');
  } finally {
    harness.close();
  }
});

test('startup repairs a run left uncertain but never blocked', async () => {
  const harness = await makeOperationHarness();
  try {
    const first = await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    const record = (await run(
      harness.fixture.operations.findByKey(
        (first as { value: { operationId: string } }).value.operationId,
      ),
    ))!;
    // The exact durable state a crash between the two transactions leaves: the operation settled
    // uncertain, and the block that should name it never committed.
    await run(
      harness.fixture.operations.settle({
        operationId: record.id,
        state: 'uncertain',
        uncertaintyDetail: 'crash between settle and block',
      }),
    );
    const beforeRestart = await runStatus(harness);
    assert.notEqual(beforeRestart.status, 'blocked');
    assert.equal(beforeRestart.blockedOperationId, null);

    // A restart, going through the startup entry point rather than through a targeted reconcile.
    // An uncertain operation is genuinely settled, so the unsettled query cannot find it; startup
    // has to look for it deliberately or the run comes back up looking dispatchable while holding
    // an effect nobody can account for.
    const built = await harness.service({ incarnationId: 'incarnation-b' });
    try {
      await Effect.runPromise(built.service.reconcileAtStartup);
    } finally {
      await built.close();
    }

    const after = await runStatus(harness);
    assert.equal(after.status, 'blocked');
    assert.equal(after.blockedOperationId, record.id);
  } finally {
    harness.close();
  }
});

test('repeated per-execution reconciliation of a terminal run appends no extra history', async () => {
  const harness = await makeOperationHarness();
  try {
    // The path phase 04 takes before re-entering a callback. It does not go through the startup
    // query, so the guard inside the repair is the only thing standing between a cancelled run and
    // a fresh `run_blocked` on every reconciliation.
    const first = await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    const record = (await run(
      harness.fixture.operations.findByKey(
        (first as { value: { operationId: string } }).value.operationId,
      ),
    ))!;
    const current = await runStatus(harness);
    await run(
      harness.fixture.runs.applyCancel({
        runId: harness.identity.runId,
        controlRevision: current.controlRevision,
      }),
    );
    await run(
      harness.fixture.operations.settle({
        operationId: record.id,
        state: 'uncertain',
        uncertaintyDetail: 'crash between settle and block',
      }),
    );

    const blockedTransitions = () =>
      (
        harness.fixture.client
          .prepare(
            `SELECT COUNT(*) AS total FROM workflow_transitions WHERE run_id = ? AND kind = 'run_blocked'`,
          )
          .get(harness.identity.runId) as { total: number }
      ).total;

    for (let pass = 0; pass < 3; pass += 1) {
      await reconcile(harness, `incarnation-${pass}`);
    }

    assert.equal(blockedTransitions(), 1, 'the repair is recorded once, not once per pass');
    assert.equal((await runStatus(harness)).status, 'cancelled');
  } finally {
    harness.close();
  }
});

test('repeated startups add exactly one run_blocked, for active and terminal runs alike', async () => {
  for (const shape of ['active', 'terminal'] as const) {
    const harness = await makeOperationHarness();
    try {
      const first = await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt));
      const record = (await run(
        harness.fixture.operations.findByKey(
          (first as { value: { operationId: string } }).value.operationId,
        ),
      ))!;
      if (shape === 'terminal') {
        const current = await runStatus(harness);
        await run(
          harness.fixture.runs.applyCancel({
            runId: harness.identity.runId,
            controlRevision: current.controlRevision,
          }),
        );
      }
      await run(
        harness.fixture.operations.settle({
          operationId: record.id,
          state: 'uncertain',
          uncertaintyDetail: 'crash between settle and block',
        }),
      );

      const blockedTransitions = () =>
        (
          harness.fixture.client
            .prepare(
              `SELECT COUNT(*) AS total FROM workflow_transitions WHERE run_id = ? AND kind = 'run_blocked'`,
            )
            .get(harness.identity.runId) as { total: number }
        ).total;

      for (const incarnation of ['incarnation-b', 'incarnation-c', 'incarnation-d']) {
        const built = await harness.service({ incarnationId: incarnation });
        try {
          await Effect.runPromise(built.service.reconcileAtStartup);
        } finally {
          await built.close();
        }
      }

      // Three restarts, one repair. A terminal run records the blocking operation without becoming
      // blocked — that is what "record the uncertainty without reviving the run" means — so a check
      // on status rather than on the recorded operation would call it unrepaired forever and append
      // a fresh transition on every boot, growing history without bound.
      assert.equal(blockedTransitions(), 1, `${shape} run should be repaired exactly once`);
      const after = await runStatus(harness);
      assert.equal(after.blockedOperationId, record.id);
      assert.equal(after.status, shape === 'terminal' ? 'cancelled' : 'blocked');

      // And the repair obligation is discharged, so later startups do not even read it back.
      assert.deepEqual(await run(harness.fixture.operations.listBlockingObligations()), []);
    } finally {
      harness.close();
    }
  }
});

test('an execution with two uncertain operations owes one repair, and stops being scanned', async () => {
  const harness = await makeOperationHarness();
  try {
    // The multi-headless shape this phase exists to support: one callback launches two judgments and
    // waits for both. Losing one is ordinary; losing both is what this covers.
    const handles = await attempt(harness, async (ctx) => [
      await ctx.runHeadlessAgent({ ...prompt, prompt: 'A' }),
      await ctx.runHeadlessAgent({ ...prompt, prompt: 'B' }),
    ]);
    const keys = (handles as { value: { operationId: string }[] }).value.map(
      (handle) => handle.operationId,
    );
    const first = (await run(harness.fixture.operations.findByKey(keys[0]!)))!;
    const second = (await run(harness.fixture.operations.findByKey(keys[1]!)))!;
    assert.equal(first.executionId, second.executionId, 'the same visit, two call positions');

    for (const record of [first, second]) {
      await run(
        harness.fixture.operations.settle({
          operationId: record.id,
          state: 'uncertain',
          uncertaintyDetail: 'crash between settle and block',
        }),
      );
    }

    // Exactly one obligation, named by the earliest recorded uncertainty — which within one
    // execution is the lower call index. The second uncertainty is real and retained; it simply is
    // not a second repair.
    const outstanding = await run(harness.fixture.operations.listBlockingObligations());
    assert.deepEqual(
      outstanding.map((record) => record.id),
      [first.id],
    );

    const blockedTransitions = () =>
      (
        harness.fixture.client
          .prepare(
            `SELECT COUNT(*) AS total FROM workflow_transitions WHERE run_id = ? AND kind = 'run_blocked'`,
          )
          .get(harness.identity.runId) as { total: number }
      ).total;

    for (const incarnation of ['incarnation-b', 'incarnation-c', 'incarnation-d']) {
      const built = await harness.service({ incarnationId: incarnation });
      try {
        await Effect.runPromise(built.service.reconcileAtStartup);
      } finally {
        await built.close();
      }
    }

    assert.equal(blockedTransitions(), 1, 'three restarts, one repair');
    const after = await runStatus(harness);
    assert.equal(after.status, 'blocked');
    assert.equal(after.blockedOperationId, first.id);

    // And the run drops out of the scan entirely. Comparing each uncertain row against the run's
    // single blocking id would have left the second permanently mismatched, so a discharged run
    // would be reconciled on every boot for as long as its history is kept.
    assert.deepEqual(await run(harness.fixture.operations.listBlockingObligations()), []);

    // Both uncertainties are still on record; only the repair obligation is gone.
    assert.equal((await run(harness.fixture.operations.findByKey(keys[0]!)))!.state, 'uncertain');
    assert.equal((await run(harness.fixture.operations.findByKey(keys[1]!)))!.state, 'uncertain');
  } finally {
    harness.close();
  }
});

test('uncertainty in two executions of one run settles on one stable block', async () => {
  const harness = await makeOperationHarness();
  try {
    // Reachable because delivering a wait clears `blocked_operation_id`: a run blocked on one
    // uncertainty can be released by an unrelated wait resolving, advance to a new visit, and pick
    // up a second uncertainty there. The run then holds two, in different executions, while the
    // column that names one is singular.
    const firstVisit = await attempt(harness, (ctx) =>
      ctx.runHeadlessAgent({ ...prompt, prompt: 'A' }),
    );
    const older = (await run(
      harness.fixture.operations.findByKey(
        (firstVisit as { value: { operationId: string } }).value.operationId,
      ),
    ))!;
    await run(
      harness.fixture.operations.settle({
        operationId: older.id,
        state: 'uncertain',
        uncertaintyDetail: 'first visit',
      }),
    );

    const revisit = await harness.nextVisit();
    const built = await harness.service();
    let newerKey = '';
    try {
      const outcome = await runCallback(
        built.service.withAttemptContext(revisit, (ctx) =>
          Effect.tryPromise({
            try: () => ctx.runHeadlessAgent({ ...prompt, prompt: 'B' }),
            catch: (c) => c,
          }),
        ),
      );
      newerKey = outcome.value.operationId;
    } finally {
      await built.close();
    }
    const newer = (await run(harness.fixture.operations.findByKey(newerKey)))!;
    await run(
      harness.fixture.operations.settle({
        operationId: newer.id,
        state: 'uncertain',
        uncertaintyDetail: 'second visit',
      }),
    );
    assert.notEqual(newer.executionId, older.executionId, 'two visits, two executions');

    const blockedTransitions = () =>
      (
        harness.fixture.client
          .prepare(
            `SELECT COUNT(*) AS total FROM workflow_transitions WHERE run_id = ? AND kind = 'run_blocked'`,
          )
          .get(harness.identity.runId) as { total: number }
      ).total;
    const before = blockedTransitions();

    for (const incarnation of ['incarnation-b', 'incarnation-c', 'incarnation-d']) {
      const boot = await harness.service({ incarnationId: incarnation });
      try {
        await Effect.runPromise(boot.service.reconcileAtStartup);
      } finally {
        await boot.close();
      }
    }

    // One repair across three restarts, and it names the same operation every time. If each
    // execution blocked on whatever it found, the two would overwrite each other on every boot —
    // history growing without bound and neither uncertainty ever settling as *the* blocking one.
    assert.equal(blockedTransitions(), before + 1);
    const after = await runStatus(harness);
    assert.equal(after.blockedOperationId, older.id, 'the earliest recorded uncertainty, always');
    assert.deepEqual(await run(harness.fixture.operations.listBlockingObligations()), []);

    // Both uncertainties remain on record; only the run-level obligation is singular.
    assert.equal((await run(harness.fixture.operations.findById(older.id)))!.state, 'uncertain');
    assert.equal((await run(harness.fixture.operations.findById(newer.id)))!.state, 'uncertain');

    // The other caller: phase 04 reconciles one execution before re-entering its callback, and the
    // later execution finding its own uncertainty must not take the block from the earlier one.
    const reconciled = await reconcile(harness, 'incarnation-e');
    assert.equal(reconciled.uncertainOperationId, older.id);
    const viaExecution = await harness.service({ incarnationId: 'incarnation-f' });
    try {
      const outcome = await Effect.runPromise(
        viaExecution.service.reconcileExecution(newer.executionId),
      );
      // Reported as *that execution's* unresolved operation, which is a different question from
      // which one the run names.
      assert.equal(outcome.uncertainOperationId, newer.id);
    } finally {
      await viaExecution.close();
    }
    assert.equal(blockedTransitions(), before + 1, 'still one repair');
    assert.equal((await runStatus(harness)).blockedOperationId, older.id, 'and still the same one');
  } finally {
    harness.close();
  }
});

test('stopping reports what each capability can honestly establish', async () => {
  const harness = await makeOperationHarness();
  try {
    await attempt(harness, async (ctx) => {
      await ctx.runHeadlessAgent(prompt);
      await ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' });
      await ctx.spawnAgentSession(seed);
    });

    const built = await harness.service({ incarnationId: 'incarnation-b' });
    let summary;
    try {
      summary = await Effect.runPromise(
        built.service.stopOwnedOperations({ runId: harness.identity.runId, reason: 'cancelled' }),
      );
    } finally {
      await built.close();
    }
    assert.equal(summary.requested, 3);
    assert.equal(summary.confirmed, 1, 'only the owned headless process can be terminated');
    assert.equal(summary.unsupported, 2);

    const records = await run(
      harness.fixture.operations.listForExecution(harness.identity.executionId),
    );
    const byCapability = new Map(records.map((entry) => [entry.capability, entry]));
    // A workflow that sent one prompt does not get to kill a shared interactive session or delete
    // the person's durable pane, and saying so is the honest report rather than a silent no-op.
    assert.equal(byCapability.get('send_agent_prompt')!.stopState, 'unsupported');
    assert.equal(
      byCapability.get('send_agent_prompt')!.stopDetail,
      'interactive_turn_not_stoppable',
    );
    assert.equal(byCapability.get('spawn_agent_session')!.stopState, 'unsupported');
    assert.equal(byCapability.get('spawn_agent_session')!.stopDetail, 'shared_session_not_owned');
    assert.equal(byCapability.get('run_headless_agent')!.stopState, 'confirmed');
  } finally {
    harness.close();
  }
});

test('a settled operation with an outstanding stop is still a stop obligation', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.launchOutcomes = [{ kind: 'spawn_failed', cause: 'listener threw' }];
    harness.state.terminateOutcome = () =>
      Object.assign(new Error('PTY backend node_pty is unavailable.'), {
        code: 'backend_unavailable',
      });
    await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    const settled = await onlyOperation(harness);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.stopState, 'pending');

    // Settling says the operation reached an outcome. It never says the process behind it is gone,
    // so the pending stop survives into the next incarnation and is retried without a graph Resume.
    harness.state.terminateOutcome = () => 'terminated_live';
    const built = await harness.service({ incarnationId: 'incarnation-b' });
    try {
      await Effect.runPromise(built.service.reconcileAtStartup);
    } finally {
      await built.close();
    }
    assert.equal((await onlyOperation(harness)).stopState, 'confirmed');
  } finally {
    harness.close();
  }
});

test('a settled operation publishes exactly one settlement notification', async () => {
  const harness = await makeOperationHarness();
  try {
    harness.state.launchOutcomes = [{ kind: 'preparation_failed', cause: 'missing binary' }];
    await attempt(harness, (ctx) => ctx.runHeadlessAgent(prompt).catch(() => null));
    const settlements = harness.events.filter(
      (event) => event.type === 'workflow_operation_settled',
    );
    assert.equal(settlements.length, 1);
    // A wake-up, never the authority: it carries identities, and the row it names is what says what
    // the operation settled as.
    assert.deepEqual(Object.keys(settlements[0]!).sort(), [
      'operationId',
      'operationKey',
      'runId',
      'type',
    ]);
  } finally {
    harness.close();
  }
});
