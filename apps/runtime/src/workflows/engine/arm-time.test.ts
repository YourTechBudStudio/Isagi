import assert from 'node:assert/strict';
import test from 'node:test';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  eventGuards,
  operation,
  outcome,
  reduce,
  suspend,
  wait,
} from '@yourtechbudstudio/isagi-workflow-sdk';

import { run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { makeEngineHarness, type EngineHarness } from './test-support.js';

/**
 * The window between a callback returning and its suspend committing.
 *
 * An operation can settle inside it. The notification that settlement publishes then finds no wait
 * to satisfy, because the wait does not exist yet — so unless the engine re-checks the wait at the
 * moment it arms it, the run sits `waiting` until some unrelated event happens to wake the resolver.
 *
 * Every test here drives delivery through a production path and none of them compensates: a run that
 * completes on `drain()` alone completed because *arm-time* reconciliation delivered it, and a run
 * that needs `deliver()` needed the subscriber.
 */

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

function makeGate() {
  let release = () => {};
  let entered = () => {};
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, entered: () => entered(), enteredPromise, release: () => release() };
}

/**
 * Launches a headless operation, then holds the callback open before suspending.
 *
 * Holding it open is what lets a test put a settlement *before* the wait exists, which is otherwise
 * a window a few microseconds wide.
 */
function gatedJudgment(gate?: {
  promise: Promise<void>;
  entered: () => void;
}): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly verdict: string | null }, {}, Record<string, unknown>>({
    key: 'gated-judgment',
    title: 'Gated judgment',
    init: () => ({ verdict: null }),
    state: { verdict: reduce.replace<string | null>() },
    entry: 'judge',
    nodes: {
      judge: operation(async (ctx) => {
        const handle = await ctx.runHeadlessAgent({ harness: 'claude', prompt: 'judge it' });
        if (gate) {
          gate.entered();
          await gate.promise;
        }
        return suspend({ wait: wait.headlessAgent(handle) });
      }),
      record: operation(async () => complete({ update: { verdict: 'recorded' } })),
    },
    edges: {
      'judge-out': edge({
        from: 'judge',
        to: ['record', 'unavailable'],
        choose: (_state, event) =>
          eventGuards.isHeadless(event) && event.results[0]?.status === 'completed'
            ? { to: 'record' }
            : { to: 'unavailable' },
      }),
      'record-out': edge({ from: 'record', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: {
      done: outcome({ kind: 'success', output: (state) => ({ verdict: state.verdict }) }),
      unavailable: outcome({ kind: 'failure', reason: 'no_judgment', output: () => ({}) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Gated judgment' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

async function settleTheJudgment(harness: EngineHarness, runId: number) {
  const record = (await run(harness.fixture.operations.listForRun(runId))).at(-1)!;
  await harness.settleOperation({
    operationId: record.id,
    state: 'completed',
    result: { operationId: record.operationKey, status: 'completed', output: 'approved' },
  });
  return record;
}

function deliveredTransitions(harness: EngineHarness, runId: number) {
  return (
    harness.fixture.client
      .prepare(
        "SELECT count(*) AS count FROM workflow_transitions WHERE run_id = ? AND kind = 'wait_delivered'",
      )
      .get(runId) as { count: number }
  ).count;
}

test('an operation that settled before the wait existed is still delivered, at arm time', async () => {
  await withHarness(async (harness) => {
    const gate = makeGate();
    harness.publish({
      workflowKey: 'gated-judgment',
      version: '1',
      definition: gatedJudgment(gate),
    });
    const launched = await harness.launch({ workflowKey: 'gated-judgment' });

    const draining = harness.drain();
    await gate.enteredPromise;
    // The effect finishes while the callback is still running. Its notification reaches a resolver
    // that finds nothing armed, because the suspend has not committed yet.
    await settleTheJudgment(harness, launched.id);
    assert.equal(await harness.deliver(launched.id), 0, 'there is no wait to satisfy yet');
    gate.release();
    await draining;

    // No `deliver` after the release: the run finished because the engine re-checked the wait the
    // moment it armed it.
    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.equal(finished.outcomeId, 'done');
    assert.equal(deliveredTransitions(harness, launched.id), 1);
  });
});

test('an operation that settles inside the arm-time window is delivered by that same reconciliation', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'gated-judgment', version: '1', definition: gatedJudgment() });
    const launched = await harness.launch({ workflowKey: 'gated-judgment' });

    // The suspend has committed and the wait is armed; the settlement lands before the engine gets
    // to re-check it. The re-check is what finds it.
    let settledInsideWindow = false;
    harness.onArmTimeReconcile(async (waitId) => {
      if (settledInsideWindow) return;
      settledInsideWindow = true;
      const armed = (await run(harness.fixture.runs.findWait(waitId)))!;
      assert.equal(armed.status, 'armed', 'the wait is durable before reconciliation runs');
      await settleTheJudgment(harness, launched.id);
    });

    await harness.drain();
    assert.equal(settledInsideWindow, true, 'the window was actually exercised');
    assert.equal((await harness.runOf(launched.id)).status, 'done');
    assert.equal(deliveredTransitions(harness, launched.id), 1);
  });
});

test('an operation that settles after reconciliation ran is delivered by the subscriber', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'gated-judgment', version: '1', definition: gatedJudgment() });
    const launched = await harness.launch({ workflowKey: 'gated-judgment' });

    await harness.drain();
    const waiting = await harness.runOf(launched.id);
    assert.equal(waiting.status, 'waiting', 'arm-time found nothing, which is correct');
    assert.equal(deliveredTransitions(harness, launched.id), 0);

    await settleTheJudgment(harness, launched.id);
    assert.equal(await harness.deliver(launched.id), 1);
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'done');
    assert.equal(deliveredTransitions(harness, launched.id), 1);
  });
});

test('the subscriber and arm-time reconciliation racing each other deliver exactly once', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'gated-judgment', version: '1', definition: gatedJudgment() });
    const launched = await harness.launch({ workflowKey: 'gated-judgment' });

    let raced = false;
    harness.onArmTimeReconcile(async () => {
      if (raced) return;
      raced = true;
      // Settle *and* let the subscriber run, so both paths reach an armed wait with satisfying
      // evidence. The wait row's own monotonic guard is what makes the loser a no-op.
      await settleTheJudgment(harness, launched.id);
      assert.equal(await harness.deliver(launched.id), 1, 'the subscriber delivered first');
    });

    await harness.drain();
    assert.equal(raced, true);
    assert.equal((await harness.runOf(launched.id)).status, 'done');
    assert.equal(
      deliveredTransitions(harness, launched.id),
      1,
      'the arm-time re-check found the wait already delivered and wrote nothing',
    );
  });
});

test('repeated reconciliation of a delivered wait writes nothing', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'gated-judgment', version: '1', definition: gatedJudgment() });
    const launched = await harness.launch({ workflowKey: 'gated-judgment' });
    await harness.drain();
    await settleTheJudgment(harness, launched.id);
    assert.equal(await harness.deliver(launched.id), 1);

    const afterFirst = await harness.runOf(launched.id);
    assert.equal(await harness.deliver(launched.id), 0);
    assert.equal(await harness.deliver(), 0, 'and the same holds for a run-wide sweep');
    const afterRepeats = await harness.runOf(launched.id);
    assert.equal(afterRepeats.revision, afterFirst.revision, 'no transition was appended');
    assert.equal(deliveredTransitions(harness, launched.id), 1);
  });
});

test('a reconciliation that cannot run leaves the armed wait authoritative', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'gated-judgment', version: '1', definition: gatedJudgment() });
    const launched = await harness.launch({ workflowKey: 'gated-judgment' });

    harness.onArmTimeReconcile(() => {
      // The suspend is already durable by the time this runs. Reporting the segment as failed here
      // would contradict a committed fact and re-enter a callback whose effect already crossed a
      // boundary, so the failure must be swallowed.
      throw new Error('arm-time reconciliation exploded');
    });
    await harness.drain();

    const waiting = await harness.runOf(launched.id);
    assert.equal(waiting.status, 'waiting', 'the run suspended normally');
    assert.equal(waiting.failureCode, null, 'and the segment was not reported as failed');
    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(waiting.activeFrameId!));
    const callbackAttempt = attempts.find((attempt) => attempt.segmentKind === 'node_callback')!;
    assert.equal(callbackAttempt.status, 'succeeded');
    assert.equal(
      (await run(harness.fixture.runs.listArmedWaits(launched.id))).length,
      1,
      'the armed wait stays authoritative',
    );

    // And the ordinary paths still reach it.
    harness.onArmTimeReconcile(() => {});
    await settleTheJudgment(harness, launched.id);
    assert.equal(await harness.deliver(launched.id), 1);
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'done');
  });
});

test('startup recovery also reaches a wait whose evidence arrived while the process was down', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'gated-judgment', version: '1', definition: gatedJudgment() });
    const launched = await harness.launch({ workflowKey: 'gated-judgment' });
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'waiting');

    // Settled with nobody listening, then the process restarts. Startup reconciliation is the third
    // path to the same wait, and it is why a dropped notification costs a delay and not a result.
    await settleTheJudgment(harness, launched.id);
    await harness.restart();

    const parked = await harness.runOf(launched.id);
    assert.equal(parked.position.kind, 'routing', 'the evidence was discovered, not re-requested');
    assert.equal(parked.paused, true, 'and the run still waits for an explicit Resume');
    assert.equal(deliveredTransitions(harness, launched.id), 1);
  });
});
