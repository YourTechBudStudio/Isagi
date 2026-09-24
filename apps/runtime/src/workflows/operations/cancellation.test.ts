import assert from 'node:assert/strict';
import test from 'node:test';

import type { OperationContext } from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import { OperationRejection } from './errors.js';
import {
  makeOperationHarness,
  openableGate,
  run,
  runCallback,
  type OperationHarness,
} from './test-support.js';

/**
 * Cancel and a callback that is already running.
 *
 * Cancel revokes permission to *advance the graph* and to *cross a new external boundary*. It does
 * not revoke permission to record what already happened, and it does not reach into an effect that
 * is mid-flight. The interesting case is therefore neither of the easy ones: a callback claimed
 * before Cancel, still executing after it, reaching for another capability.
 */

const prompt = { harness: 'claude' as const, prompt: 'judge this' };

async function cancelRun(harness: OperationHarness) {
  const current = (await run(harness.fixture.runs.findRun(harness.identity.runId)))!;
  await run(
    harness.fixture.runs.applyCancel({
      runId: harness.identity.runId,
      controlRevision: current.controlRevision,
    }),
  );
}

async function withContext<A>(
  harness: OperationHarness,
  callback: (ctx: OperationContext) => Promise<A>,
) {
  const built = await harness.service();
  try {
    return await runCallback(
      built.service.withAttemptContext(harness.identity, (ctx) =>
        Effect.tryPromise({ try: () => callback(ctx), catch: (cause) => cause }),
      ),
    );
  } finally {
    await built.close();
  }
}

function rejectionOf(cause: unknown): OperationRejection {
  if (cause instanceof OperationRejection) return cause;
  throw cause;
}

test('a cancelled run refuses every new external effect a running callback asks for', async () => {
  const harness = await makeOperationHarness();
  try {
    let rejections: OperationRejection[] = [];
    await withContext(harness, async (ctx) => {
      // Claimed before Cancel, still running after it — the window where nothing else is watching.
      await cancelRun(harness);
      for (const attemptCall of [
        () => ctx.runHeadlessAgent(prompt),
        () => ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' }),
        () => ctx.spawnAgentSession({ harness: 'claude', prompt: 'seed' }),
        () => ctx.closePane(9),
      ]) {
        await attemptCall().then(
          () => assert.fail('a cancelled run must not authorize new external work'),
          (cause: unknown) => rejections.push(rejectionOf(cause)),
        );
      }
    });

    assert.equal(rejections.length, 4);
    for (const rejection of rejections) {
      assert.equal(rejection.code, 'workflow_run_cancelled');
    }
    // Nothing crossed a boundary: no process, no prompt, no session, no pane.
    assert.equal(harness.state.counters.allocations, 0);
    assert.equal(harness.state.counters.starts, 0);
    assert.equal(harness.state.counters.promptWrites, 0);
    assert.equal(harness.state.counters.spawnCreate, 0);
    assert.equal(harness.state.closedPanes.size, 0);
    // And no operation row was created for an effect that never happened.
    assert.deepEqual(
      await run(harness.fixture.operations.listForExecution(harness.identity.executionId)),
      [],
    );
  } finally {
    harness.close();
  }
});

test('the fence is atomic with the intent it guards, not a read the caller races', async () => {
  const harness = await makeOperationHarness();
  try {
    // Cancel commits between the callback deciding to act and the intent being written. A fence read
    // in the caller would have passed before this and still recorded the intent; the check lives in
    // the same transaction as the write, so the two serialize and the loser is refused.
    const cancelDuringClaim = {
      ...harness.fixture.operations,
      recordIntent: (input: Parameters<typeof harness.fixture.operations.recordIntent>[0]) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => cancelRun(harness));
          return yield* harness.fixture.operations.recordIntent(input);
        }),
    };

    const built = await harness.service({ operations: cancelDuringClaim });
    let rejection: unknown;
    try {
      await runCallback(
        built.service.withAttemptContext(harness.identity, (ctx) =>
          Effect.tryPromise({ try: () => ctx.runHeadlessAgent(prompt), catch: (c) => c }),
        ),
      ).catch((cause) => {
        rejection = cause;
      });
    } finally {
      await built.close();
    }

    assert.equal(rejectionOf(rejection).code, 'workflow_run_cancelled');
    assert.equal(harness.state.counters.allocations, 0);
  } finally {
    harness.close();
  }
});

test('Cancel does not revoke permission to account for work already recorded', async () => {
  const harness = await makeOperationHarness();
  try {
    // A receipt reuse performs no effect; it lets a re-entered callback finish reconstructing its
    // return value. Refusing it would make a cancelled run unable to describe its own history.
    const first = await withContext(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    assert.equal(harness.state.counters.allocations, 1);

    await cancelRun(harness);

    const reused = await withContext(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    assert.equal(reused.value.operationId, first.value.operationId);
    assert.equal(harness.state.counters.allocations, 1, 'no new effect, and no refusal either');

    // Diagnostics stay available for the same reason.
    await withContext(harness, (ctx) => ctx.log('warning', 'cleaning up'));
  } finally {
    harness.close();
  }
});

test('an effect already crossing when Cancel lands is retained and stoppable', async () => {
  const harness = await makeOperationHarness();
  try {
    // The window the design calls irreducible: the intent is recorded, then Cancel commits, then the
    // boundary is crossed. Nothing pretends this did not happen — it is recorded, and the stop
    // protocol is what answers for it.
    const handle = await withContext(harness, (ctx) => ctx.runHeadlessAgent(prompt));
    await cancelRun(harness);

    const record = (await run(harness.fixture.operations.findByKey(handle.value.operationId)))!;
    assert.equal(record.state, 'dispatched');

    const built = await harness.service();
    let summary;
    try {
      summary = await Effect.runPromise(
        built.service.stopOwnedOperations({ runId: harness.identity.runId, reason: 'cancelled' }),
      );
    } finally {
      await built.close();
    }
    assert.equal(summary.requested, 1);
    assert.equal(summary.confirmed, 1);
    assert.equal(harness.state.counters.terminations, 1);

    const stopped = (await run(harness.fixture.operations.findByKey(handle.value.operationId)))!;
    assert.equal(stopped.stopState, 'confirmed');
    const after = (await run(harness.fixture.runs.findRun(harness.identity.runId)))!;
    assert.equal(after.status, 'cancelled', 'and the run was never revived by any of it');
  } finally {
    harness.close();
  }
});

/**
 * Cancel landing *during* preparation, after the intent is recorded.
 *
 * The transactional intent guard closes one window; these close the one after it. Real work happens
 * between recording a call position and crossing its boundary — waiting for an observer and for
 * quiescence, creating a pane and a session, bringing a process up — and a Cancel arriving in that
 * gap has to stop the crossing, not merely the recording.
 *
 * Each assertion pairs "no effect crossed" with "the operation is left in a state recovery reads as
 * nothing-crossed", because a refusal that stranded an operation mid-marker would trade a stray
 * effect for a blocked run.
 */

async function runInBackground(
  harness: OperationHarness,
  callback: (ctx: OperationContext) => Promise<unknown>,
) {
  const built = await harness.service();
  const captured: { rejection?: unknown } = {};
  const fiber = Effect.runFork(
    built.service.withAttemptContext(harness.identity, (ctx) =>
      Effect.tryPromise({
        try: () =>
          callback(ctx).catch((cause: unknown) => {
            captured.rejection = cause;
            throw cause;
          }),
        catch: (cause) => cause,
      }),
    ),
  );
  return { built, fiber, captured };
}

async function waitFor(predicate: () => boolean, within = 2_000) {
  const deadline = Date.now() + within;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was never reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function onlyOperation(harness: OperationHarness) {
  const records = await run(
    harness.fixture.operations.listForExecution(harness.identity.executionId),
  );
  assert.equal(records.length, 1);
  return records[0]!;
}

test('Cancel during prompt preparation refuses the PTY write that was about to happen', async () => {
  const harness = await makeOperationHarness();
  try {
    const gate = openableGate();
    harness.state.gates.set('prepareSend', gate.promise);
    const { built, captured } = await runInBackground(harness, (ctx) =>
      ctx.sendAgentPrompt({ agentSessionId: 42, prompt: 'go' }),
    );
    try {
      // Inside the owner call: the intent is recorded and the session is being resolved.
      await waitFor(() => harness.state.counters.sendPrepares === 1);
      const recorded = await onlyOperation(harness);
      assert.equal(recorded.state, 'intended');

      await cancelRun(harness);
      gate.open();
      await waitFor(() => captured.rejection !== undefined);

      assert.equal(rejectionOf(captured.rejection).code, 'workflow_run_cancelled');
      assert.equal(harness.state.counters.promptWrites, 0, 'nothing reached the PTY');
      const after = await onlyOperation(harness);
      // No `submitting` marker was written, so recovery reads this as a position whose effect never
      // left rather than as a submission nobody can account for.
      assert.equal(after.stage, null);
      assert.equal(after.submissionWatermark, null);
      assert.equal(after.state, 'intended');
    } finally {
      await built.close();
    }
  } finally {
    harness.close();
  }
});

test('Cancel during seed preparation refuses the seed, keeping the resources it already made', async () => {
  const harness = await makeOperationHarness();
  try {
    const gate = openableGate();
    harness.state.gates.set('prepareSeed', gate.promise);
    const { built, captured } = await runInBackground(harness, (ctx) =>
      ctx.spawnAgentSession({ harness: 'claude', prompt: 'seed' }),
    );
    try {
      await waitFor(() => harness.state.counters.seedPrepare === 1);
      await cancelRun(harness);
      gate.open();
      await waitFor(() => captured.rejection !== undefined);

      assert.equal(rejectionOf(captured.rejection).code, 'workflow_run_cancelled');
      assert.equal(harness.state.counters.promptWrites, 0, 'the seed never crossed');
      const after = await onlyOperation(harness);
      // The pane and session really were created before Cancel, and pretending otherwise would lose
      // them. The stage says exactly that, and says no PTY write happened.
      assert.equal(after.stage, 'session_created');
      assert.equal(harness.state.counters.spawnCreate, 1);
    } finally {
      await built.close();
    }
  } finally {
    harness.close();
  }
});

test('Cancel during headless allocation refuses the spawn and leaves a redispatchable position', async () => {
  const harness = await makeOperationHarness();
  try {
    const gate = openableGate();
    harness.state.gates.set('allocate', gate.promise);
    const { built, captured } = await runInBackground(harness, (ctx) =>
      ctx.runHeadlessAgent(prompt),
    );
    try {
      await waitFor(() => harness.state.counters.allocations === 1);
      await cancelRun(harness);
      gate.open();
      await waitFor(() => captured.rejection !== undefined);

      assert.equal(rejectionOf(captured.rejection).code, 'workflow_run_cancelled');
      assert.equal(harness.state.counters.starts, 0, 'no process was ever spawned');
      const after = await onlyOperation(harness);
      // Refused before the `starting` marker on purpose: `allocated` is the state recovery reads as
      // "`start` was never called", while `starting` would be indeterminate and would block the run.
      assert.equal(after.stage, 'allocated');
      assert.notEqual(after.stage, 'starting');
      // And the reservation was handed back rather than left to nobody.
      assert.deepEqual(harness.state.abandoned, [after.ptyProcessId]);
    } finally {
      await built.close();
    }
  } finally {
    harness.close();
  }
});

test('Cancel between intent and the owner call refuses the pane closure', async () => {
  const harness = await makeOperationHarness();
  try {
    // `closePane` has no preparation to wait inside, so the gap under test is the one between the
    // intent transaction and the owner call. Cancelling as the intent commits lands exactly there.
    const cancelAfterIntent = {
      ...harness.fixture.operations,
      recordIntent: (input: Parameters<typeof harness.fixture.operations.recordIntent>[0]) =>
        Effect.gen(function* () {
          const written = yield* harness.fixture.operations.recordIntent(input);
          yield* Effect.promise(() => cancelRun(harness));
          return written;
        }),
    };

    const built = await harness.service({ operations: cancelAfterIntent });
    let rejection: unknown;
    try {
      await runCallback(
        built.service.withAttemptContext(harness.identity, (ctx) =>
          Effect.tryPromise({ try: () => ctx.closePane(41), catch: (c) => c }),
        ),
      ).catch((cause) => {
        rejection = cause;
      });
    } finally {
      await built.close();
    }

    assert.equal(rejectionOf(rejection).code, 'workflow_run_cancelled');
    assert.equal(harness.state.closedPanes.size, 0, 'the pane was not touched');
    const after = await onlyOperation(harness);
    assert.equal(after.state, 'intended');
  } finally {
    harness.close();
  }
});
