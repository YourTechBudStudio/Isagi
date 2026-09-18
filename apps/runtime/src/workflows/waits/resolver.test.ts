import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
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

import { makeEngineHarness, type EngineHarness } from '../engine/test-support.js';
import { inlinePayloadThresholdBytes } from '../persistence/payload-store.js';
import { run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import type { WaitDeclaration } from '../types.js';

/**
 * What the resolver does when the evidence it needs is not there, and when it is.
 *
 * Two properties are under test and they pull in the same direction. A payload it cannot read is
 * **explicit degradation** — never a substituted value, because a fabricated result reaches the
 * author's router as though the world had answered. And the association between a submission and a
 * native turn is **fixed once and persisted**, because selection runs over evidence that keeps
 * arriving: left unfrozen, a second start would turn an explainable turn into ambiguity.
 */

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

function diagnostics(harness: EngineHarness, runId: number) {
  return (
    harness.fixture.client
      .prepare(
        "SELECT detail_inline AS detail FROM workflow_transitions WHERE run_id = ? AND kind = 'log'",
      )
      .all(runId) as { detail: string }[]
  ).map((row) => row.detail);
}

/** A human gate whose declaration is large enough to be stored as a reference. */
function bulkyGateWorkflow(): AnyWorkflowDefinition {
  const questions = Array.from({ length: 200 }, (_value, index) => ({
    kind: 'text' as const,
    key: `field-${index}`,
    label: 'x'.repeat(80),
  }));
  const graph = createGraph<{ readonly answered: boolean }, {}, Record<string, unknown>>({
    key: 'bulky-gate',
    title: 'Bulky gate',
    init: () => ({ answered: false }),
    state: { answered: reduce.replace<boolean>() },
    entry: 'ask',
    nodes: { ask: operation(async () => suspend({ wait: wait.userInput(questions) })) },
    edges: {
      'ask-out': edge({ from: 'ask', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: { done: outcome({ kind: 'success', output: () => ({}) }) },
  });
  return defineWorkflow({
    command: () => ({ title: 'Bulky gate' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

/** One headless judgment whose router branches on the reported status. */
function judgingWorkflow(): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly verdict: string }, {}, Record<string, unknown>>({
    key: 'judging',
    title: 'Judging',
    init: () => ({ verdict: 'none' }),
    state: { verdict: reduce.replace<string>() },
    entry: 'judge',
    nodes: {
      judge: operation(async (ctx) => {
        const handle = await ctx.runHeadlessAgent({ harness: 'claude', prompt: 'judge it' });
        return suspend({ wait: wait.headlessAgent(handle) });
      }),
    },
    edges: {
      'judge-out': edge({
        from: 'judge',
        to: ['approved', 'rejected'],
        choose: (_state, event) => {
          const status = eventGuards.isHeadless(event) ? event.results[0]?.status : 'unknown';
          return status === 'completed'
            ? { to: 'approved', update: { verdict: 'approved' } }
            : { to: 'rejected', update: { verdict: String(status) } };
        },
      }),
    },
    outcomes: {
      approved: outcome({ kind: 'success', output: (state) => ({ verdict: state.verdict }) }),
      rejected: outcome({ kind: 'failure', reason: 'no', output: (state) => state }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Judging' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

/** A prompt into an existing session, then a wait on the turn it should cause. */
function promptingWorkflow(): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly outcome: string }, {}, Record<string, unknown>>({
    key: 'prompting',
    title: 'Prompting',
    init: () => ({ outcome: 'none' }),
    state: { outcome: reduce.replace<string>() },
    entry: 'ask',
    nodes: {
      ask: operation(async (ctx) => {
        const target = await ctx.sendAgentPrompt({ agentSessionId: 500, prompt: 'please' });
        return suspend({ wait: wait.agentTurn(target) });
      }),
      record: operation(async () => complete()),
    },
    edges: {
      'ask-out': edge({
        from: 'ask',
        to: ['record'],
        choose: (_state, event) => ({
          to: 'record',
          update: {
            outcome: eventGuards.isAgentTurn(event)
              ? `${event.outcome}:${'reason' in event ? event.reason : ''}`
              : 'not-a-turn',
          },
        }),
      }),
      'record-out': edge({ from: 'record', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: {
      done: outcome({ kind: 'success', output: (state) => ({ outcome: state.outcome }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Prompting' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

test('a wait declaration that cannot be read is reported, not silently ignored', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'bulky-gate', version: '1', definition: bulkyGateWorkflow() });
    const launched = await harness.launch({ workflowKey: 'bulky-gate' });
    await harness.drain();

    const armed = (await run(harness.fixture.runs.listArmedWaits(launched.id)))[0]!;
    assert.ok(armed.condition?.ref, 'the declaration is large enough to be a reference');
    rmSync(harness.fixture.payloads.pathOf(armed.condition!.ref!));

    assert.equal(await harness.deliver(launched.id), 0, 'nothing is delivered');
    const stillArmed = (await run(harness.fixture.runs.findWait(armed.id)))!;
    assert.equal(stillArmed.status, 'armed', 'and the wait is not resolved behind the scenes');

    const logged = diagnostics(harness, launched.id);
    assert.ok(
      logged.some(
        (detail) =>
          detail.includes('payload_unavailable') &&
          detail.includes(armed.condition!.ref!) &&
          detail.includes('missing'),
      ),
      `expected a payload diagnostic naming the reference, saw ${JSON.stringify(logged)}`,
    );
  });
});

test('an unreadable operation result is never replaced with a fabricated success', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'judging', version: '1', definition: judgingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'judging' });
    await harness.drain();

    // A completed operation with a large result, so the slot is a reference we can take away.
    const record = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;
    await harness.settleOperation({
      operationId: record.id,
      state: 'completed',
      result: {
        operationId: record.operationKey,
        status: 'completed',
        output: 'y'.repeat(inlinePayloadThresholdBytes + 512),
      },
    });
    const settled = (await run(harness.fixture.operations.findById(record.id)))!;
    assert.ok(settled.result?.ref, 'the result is stored as a reference');
    rmSync(harness.fixture.payloads.pathOf(settled.result!.ref!));

    assert.equal(await harness.deliver(launched.id), 0, 'the wait is not satisfied');
    assert.equal(
      (await run(harness.fixture.runs.listArmedWaits(launched.id))).length,
      1,
      'it stays armed rather than routing on a result nobody could read',
    );
    assert.equal(await harness.drain(), 0);
    const current = await harness.runOf(launched.id);
    assert.equal(current.status, 'waiting');
    assert.equal(
      current.outcomeId,
      null,
      'and in particular the run did not complete on a fabricated success',
    );

    assert.ok(
      diagnostics(harness, launched.id).some(
        (detail) => detail.includes('payload_unavailable') && detail.includes(settled.result!.ref!),
      ),
      'the unreadable result is recorded against the run',
    );
  });
});

test('an operation with no result slot still reports what its record says', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'judging', version: '1', definition: judgingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'judging' });
    await harness.drain();

    // `abandoned` crossed no boundary, so there is genuinely no result — and that is the one case
    // where the record's own state is the whole story.
    const record = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;
    await harness.settleOperation({ operationId: record.id, state: 'failed' });
    assert.equal((await run(harness.fixture.operations.findById(record.id)))!.result, null);

    assert.equal(await harness.deliver(launched.id), 1);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.outcomeId, 'rejected', 'the edge saw a failure, not a success');
    assert.deepEqual(await run(harness.fixture.payloads.resolve(finished.output!)), {
      verdict: 'failed',
    });
  });
});

test('a turn association is fixed and persisted the first time it can be established', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'prompting', version: '1', definition: promptingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'prompting' });
    await harness.drain();

    const submission = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;
    assert.equal(submission.capability, 'send_agent_prompt');
    assert.equal(submission.correlatedHarnessSessionId, null, 'nothing is correlated yet');
    const watermark = submission.submissionWatermark!;
    const sessionId = submission.targetId!;

    // One start, no terminal yet. The resolver cannot deliver — but it must decide *now* which turn
    // this submission caused, because the evidence only grows from here.
    harness.adapters.turnEdges.set(sessionId, [
      {
        type: 'turn_started',
        agentSessionId: sessionId,
        harnessSessionId: 'harness-A',
        seq: 1,
        recordedAt: watermark,
      },
    ]);
    assert.equal(await harness.deliver(launched.id), 0, 'no terminal, so nothing is delivered');

    const fixed = (await run(harness.fixture.operations.findById(submission.id)))!;
    assert.equal(fixed.attribution, 'inferred_by_watermark');
    assert.equal(fixed.correlatedStartSeq, 1);
    assert.equal(fixed.correlatedHarnessSessionId, 'harness-A');
    assert.equal(fixed.state, 'dispatched', 'fixing the association settles nothing');

    // A second start now arrives and supersedes the first. Because the association is already
    // fixed, this is ordinary session activity plus a confirmed interruption — not ambiguity.
    harness.adapters.turnEdges.set(sessionId, [
      ...harness.adapters.turnEdges.get(sessionId)!,
      {
        type: 'turn_started',
        agentSessionId: sessionId,
        harnessSessionId: 'harness-A',
        seq: 2,
        recordedAt: watermark,
      },
      {
        type: 'turn_failed',
        agentSessionId: sessionId,
        harnessSessionId: 'harness-A',
        seq: 1,
        recordedAt: watermark,
        reason: 'new_start_supersedes',
      },
    ]);
    assert.equal(await harness.deliver(launched.id), 1);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.deepEqual(await run(harness.fixture.payloads.resolve(finished.output!)), {
      outcome: 'interrupted:superseded_by_new_turn',
    });
    assert.notEqual(
      finished.status,
      'blocked',
      'a second start did not turn an explainable turn into uncertainty',
    );
    const settled = (await run(harness.fixture.operations.findById(submission.id)))!;
    assert.equal(settled.state, 'interrupted');
    assert.equal(settled.correlatedStartSeq, 1, 'and the correlation it was fixed with survives');
  });
});

test('two open starts before any terminal are still ambiguity, and still block', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'prompting', version: '1', definition: promptingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'prompting' });
    await harness.drain();

    const submission = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;
    const watermark = submission.submissionWatermark!;
    const sessionId = submission.targetId!;
    // Both starts are already there at the first evaluation, with nothing closing the first. Nobody
    // can say which turn this prompt caused, and nothing invents an answer.
    harness.adapters.turnEdges.set(sessionId, [
      {
        type: 'turn_started',
        agentSessionId: sessionId,
        harnessSessionId: 'harness-A',
        seq: 1,
        recordedAt: watermark,
      },
      {
        type: 'turn_started',
        agentSessionId: sessionId,
        harnessSessionId: 'harness-A',
        seq: 2,
        recordedAt: watermark,
      },
    ]);

    assert.equal(await harness.deliver(launched.id), 0);
    const settled = (await run(harness.fixture.operations.findById(submission.id)))!;
    assert.equal(settled.state, 'uncertain');
    assert.equal(settled.correlatedHarnessSessionId, null, 'nothing was fixed');
    const blocked = await harness.runOf(launched.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedOperationId, submission.id);

    const declaration = (await run(
      harness.fixture.payloads.resolve(
        (
          await run(harness.fixture.runs.listArmedWaits(launched.id))
        )[0]!.condition!,
      ),
    )) as Extract<WaitDeclaration, { kind: 'agent_turn' }>;
    assert.equal(
      declaration.target.sentAt,
      watermark,
      'the wait is still bounded by the watermark',
    );
  });
});

test('a permanently unreadable payload is reported once, not on every wake-up', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'bulky-gate', version: '1', definition: bulkyGateWorkflow() });
    const launched = await harness.launch({ workflowKey: 'bulky-gate' });
    await harness.drain();

    const armed = (await run(harness.fixture.runs.listArmedWaits(launched.id)))[0]!;
    rmSync(harness.fixture.payloads.pathOf(armed.condition!.ref!));

    await harness.deliver(launched.id);
    const afterFirst = await harness.runOf(launched.id);
    assert.equal(diagnostics(harness, launched.id).length, 1, 'reported once');

    // The resolver is woken by every turn and settlement anywhere in the runtime, and this wait stays
    // armed forever. Appending each time would let one corrupt payload write unbounded retained
    // history as entirely unrelated work proceeds.
    for (let wake = 0; wake < 5; wake += 1) {
      await harness.deliver(launched.id);
      await harness.deliver();
    }

    assert.equal(diagnostics(harness, launched.id).length, 1, 'and only once');
    assert.equal(
      (await harness.runOf(launched.id)).revision,
      afterFirst.revision,
      'so the run accrues no further revisions',
    );
    assert.equal(
      (await run(harness.fixture.runs.findWait(armed.id)))!.status,
      'armed',
      'while the wait itself is still visibly unresolved',
    );
  });
});

test('a degradation whose diagnostic could not be written is reported on the next pass', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'bulky-gate', version: '1', definition: bulkyGateWorkflow() });
    const launched = await harness.launch({ workflowKey: 'bulky-gate' });
    await harness.drain();

    const armed = (await run(harness.fixture.runs.listArmedWaits(launched.id)))[0]!;
    rmSync(harness.fixture.payloads.pathOf(armed.condition!.ref!));

    // The first attempt to record the degradation fails to persist. Suppressing every later attempt
    // because of it would leave the wait visibly unresolved with nothing on record saying why —
    // exactly the silence the reporter exists to prevent.
    harness.crashNext('appendDiagnostic');
    await harness.deliver(launched.id);
    assert.equal(diagnostics(harness, launched.id).length, 0, 'nothing was recorded');

    await harness.deliver(launched.id);
    assert.equal(diagnostics(harness, launched.id).length, 1, 'the next pass records it');
    const afterRecovery = await harness.runOf(launched.id);

    // And from there it is idempotent again.
    for (let wake = 0; wake < 3; wake += 1) {
      await harness.deliver(launched.id);
      await harness.deliver();
    }
    assert.equal(diagnostics(harness, launched.id).length, 1, 'and only once thereafter');
    assert.equal((await harness.runOf(launched.id)).revision, afterRecovery.revision);
  });
});
