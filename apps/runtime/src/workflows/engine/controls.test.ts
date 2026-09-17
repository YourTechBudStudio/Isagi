import assert from 'node:assert/strict';
import test from 'node:test';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  subgraph,
  suspend,
  wait,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Cause, Effect, Option } from 'effect';

import {
  InternalRuntimeEventBus,
  InternalRuntimeEventBusLive,
} from '../../runtime-events/internal-event-bus.js';
import type { InternalRuntimeEvent } from '../../runtime-events/internal-event-bus.js';
import { run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { WorkflowEngineError } from '../types.js';
import { startEnvironmentWatch } from '../waits/environment.js';
import {
  createBoth,
  makeEngineHarness,
  type EngineHarness,
  type Placement,
} from './test-support.js';

/** A workflow whose only node throws, so a run can be driven to `failed` for control tests. */
function failingWorkflow(): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly answer: string | null }, {}, Record<string, unknown>>({
    key: 'human',
    title: 'Human',
    init: () => ({ answer: null }),
    state: { answer: reduce.replace<string | null>() },
    entry: 'ask',
    nodes: {
      ask: operation(async () => {
        throw new Error('this version cannot ask');
      }),
    },
    edges: {
      'ask-out': edge({ from: 'ask', to: ['answered'], choose: () => ({ to: 'answered' }) }),
    },
    outcomes: {
      answered: outcome({ kind: 'success', output: (state) => ({ answer: state.answer }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Human' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

/**
 * Controls, and the difference between stopping *dispatch* and stopping *recording*.
 *
 * Pause gates the next claim and nothing else: a callback already running reaches its durable
 * boundary and commits. Cancel additionally revokes permission to advance the graph and to cross new
 * external boundaries — but never permission to record what already happened, because forgetting a
 * completed effect is what would force it to be performed twice.
 */

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

/** A callback the test can hold open, so a control can be applied while a segment is in flight. */
function gatedWorkflow(
  gate: { promise: Promise<void>; entered: () => void },
  options: { readonly logAfterGate?: boolean } = {},
) {
  const logAfterGate = options.logAfterGate ?? true;
  const graph = createGraph<
    { readonly steps: readonly string[] },
    { readonly steps: string },
    Record<string, unknown>
  >({
    key: 'gated',
    title: 'Gated',
    init: () => ({ steps: [] }),
    state: { steps: reduce.append<string>() },
    entry: 'work',
    nodes: {
      work: operation(async (ctx) => {
        gate.entered();
        await gate.promise;
        if (logAfterGate) await ctx.log('info', 'the callback reached its boundary');
        return complete({ update: { steps: 'worked' } });
      }),
    },
    edges: {
      'work-out': edge({ from: 'work', to: ['finished'], choose: () => ({ to: 'finished' }) }),
    },
    outcomes: {
      finished: outcome({ kind: 'success', output: (state) => ({ steps: state.steps }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Gated' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

/** A human gate, which is the only wait nothing but a person can satisfy. */
function gateWorkflow(kind: 'user_continue' | 'user_input'): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly answer: string | null }, {}, Record<string, unknown>>({
    key: 'human',
    title: 'Human',
    init: () => ({ answer: null }),
    state: { answer: reduce.replace<string | null>() },
    entry: 'ask',
    nodes: {
      ask: operation(async () =>
        suspend({
          wait:
            kind === 'user_continue'
              ? wait.userContinue('Continue?')
              : wait.userInput([{ kind: 'text', key: 'note', label: 'Note' }]),
        }),
      ),
    },
    edges: {
      'ask-out': edge({
        from: 'ask',
        to: ['answered'],
        choose: (_state, event) => ({
          to: 'answered',
          update: {
            answer: event.kind === 'user_input' ? String(event.answers.note) : 'continued',
          },
        }),
      }),
    },
    outcomes: {
      answered: outcome({ kind: 'success', output: (state) => ({ answer: state.answer }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Human' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
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

test('Pause landing mid-callback does not stop that callback from committing', async () => {
  await withHarness(async (harness) => {
    const gate = makeGate();
    harness.publish({ workflowKey: 'gated', version: '1', definition: gatedWorkflow(gate) });
    const launched = await harness.launch({ workflowKey: 'gated' });

    const draining = harness.drain();
    await gate.enteredPromise;
    const paused = await run(harness.controls.pause(launched.id));
    assert.equal(paused.accepted, true);
    gate.release();
    await draining;

    const after = await harness.runOf(launched.id);
    // The claimed segment committed: its state was reduced and the position moved on. Only the next
    // claim is gated, which is what Pause actually means.
    assert.equal(after.paused, true);
    assert.equal(after.position.kind, 'routing');
    const frame = (await run(harness.fixture.runs.findFrame(after.activeFrameId!)))!;
    assert.deepEqual(await run(harness.fixture.payloads.resolve(frame.state!)), {
      steps: ['worked'],
    });

    // And a further drain moves nothing while the gate is closed.
    assert.equal(await harness.drain(), 0);
    assert.equal((await harness.runOf(launched.id)).position.kind, 'routing');

    assert.equal((await run(harness.controls.resume(launched.id))).accepted, true);
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'done');
  });
});

test('Cancel landing mid-callback keeps the result as evidence and advances nothing', async () => {
  await withHarness(async (harness) => {
    const gate = makeGate();
    harness.publish({ workflowKey: 'gated', version: '1', definition: gatedWorkflow(gate) });
    const launched = await harness.launch({ workflowKey: 'gated' });

    const draining = harness.drain();
    await gate.enteredPromise;
    const before = await harness.runOf(launched.id);
    assert.equal((await run(harness.controls.cancel(launched.id))).accepted, true);
    gate.release();
    await draining;

    const after = await harness.runOf(launched.id);
    assert.equal(after.status, 'cancelled');
    assert.deepEqual(after.position, before.position, 'the graph did not advance');

    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(before.activeFrameId!));
    const callbackAttempt = attempts.find((attempt) => attempt.segmentKind === 'node_callback')!;
    assert.equal(callbackAttempt.status, 'cancelled');
    assert.deepEqual(
      await run(harness.fixture.payloads.resolve(callbackAttempt.producerOutput!)),
      { type: 'complete', update: { steps: 'worked' } },
      'what the callback produced is retained as cancelled-attempt evidence',
    );

    const frame = (await run(harness.fixture.runs.findFrame(before.activeFrameId!)))!;
    assert.deepEqual(
      await run(harness.fixture.payloads.resolve(frame.state!)),
      { steps: [] },
      'but no state was reduced',
    );
    assert.equal(await harness.drain(), 0, 'and the run is not dispatchable any more');
  });
});

test('a diagnostic written after Cancel is still recorded', async () => {
  await withHarness(async (harness) => {
    const gate = makeGate();
    harness.publish({ workflowKey: 'gated', version: '1', definition: gatedWorkflow(gate) });
    const launched = await harness.launch({ workflowKey: 'gated' });

    const draining = harness.drain();
    await gate.enteredPromise;
    await run(harness.controls.cancel(launched.id));
    gate.release();
    await draining;

    const diagnostics = harness.fixture.client
      .prepare(
        "SELECT kind, detail_inline AS detail FROM workflow_transitions WHERE run_id = ? AND kind = 'log'",
      )
      .all(launched.id) as { kind: string; detail: string }[];
    assert.ok(
      diagnostics.some((row) => row.detail.includes('reached its boundary')),
      'the log the callback wrote after Cancel is retained',
    );
  });
});

test('Cancel must come before Dismiss, and Dismiss is inert once the attachment is gone', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'human',
      version: '1',
      definition: gateWorkflow('user_continue'),
    });
    const launched = await harness.launch({ workflowKey: 'human' });
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'waiting');

    const refused = await Effect.runPromiseExit(harness.controls.dismiss(launched.id));
    assert.equal(refused._tag, 'Failure');
    assert.ok(
      await run(harness.fixture.runs.findAttachment(launched.id)),
      'a live run keeps its placement; detaching it would take the surface back while work continued',
    );

    await run(harness.controls.cancel(launched.id));
    assert.equal((await run(harness.controls.dismiss(launched.id))).accepted, true);
    assert.equal(await run(harness.fixture.runs.findAttachment(launched.id)), null);

    // The run itself is untouched: Dismiss releases placement, it does not delete history.
    const retained = await harness.runOf(launched.id);
    assert.equal(retained.status, 'cancelled');
    assert.ok((await run(harness.fixture.runs.listFrames(launched.id))).length > 0);

    const beforeRepeat = await harness.runOf(launched.id);
    assert.equal((await run(harness.controls.dismiss(launched.id))).accepted, true);
    const afterRepeat = await harness.runOf(launched.id);
    assert.equal(afterRepeat.revision, beforeRepeat.revision, 'a repeat writes no history');
  });
});

test('a human gate is answered once, by wait identity, and never twice', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'human', version: '1', definition: gateWorkflow('user_input') });
    const launched = await harness.launch({ workflowKey: 'human' });
    await harness.drain();

    const armed = (await run(harness.fixture.runs.listArmedWaits(launched.id)))[0]!;
    // An answer that does not match the recorded questions is refused before anything is written.
    const invalid = await Effect.runPromiseExit(
      harness.controls.advance({ runId: launched.id, waitId: armed.id, answers: { wrong: 'x' } }),
    );
    assert.equal(invalid._tag, 'Failure');
    assert.equal((await run(harness.fixture.runs.findWait(armed.id)))!.status, 'armed');

    assert.equal(
      (
        await run(
          harness.controls.advance({
            runId: launched.id,
            waitId: armed.id,
            answers: { note: 'looks good' },
          }),
        )
      ).accepted,
      true,
    );
    const repeat = await Effect.runPromiseExit(
      harness.controls.advance({
        runId: launched.id,
        waitId: armed.id,
        answers: { note: 'again' },
      }),
    );
    assert.equal(repeat._tag, 'Failure', 'a second submission cannot advance the same wait twice');

    await harness.drain();
    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.deepEqual(await run(harness.fixture.payloads.resolve(finished.output!)), {
      answer: 'looks good',
    });
  });
});

test('a human answer submitted during Pause records readiness without dispatching', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'human',
      version: '1',
      definition: gateWorkflow('user_continue'),
    });
    const launched = await harness.launch({ workflowKey: 'human' });
    await harness.drain();

    await run(harness.controls.pause(launched.id));
    const armed = (await run(harness.fixture.runs.listArmedWaits(launched.id)))[0]!;
    assert.equal(
      (await run(harness.controls.advance({ runId: launched.id, waitId: armed.id }))).accepted,
      true,
    );

    const ready = await harness.runOf(launched.id);
    assert.equal(ready.status, 'ready', 'readiness is recorded — readiness is not dispatch');
    assert.equal(ready.paused, true);
    assert.equal(ready.position.kind, 'routing');
    assert.equal(await harness.drain(), 0, 'and the gate still stops the next claim');

    // Resume alone then finishes it, with no further external event.
    assert.equal((await run(harness.controls.resume(launched.id))).accepted, true);
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'done');
  });
});

test('a stale prepared control is refused when a newer control landed first', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'human',
      version: '1',
      definition: gateWorkflow('user_continue'),
    });
    const launched = await harness.launch({ workflowKey: 'human' });
    await harness.drain();
    const before = await harness.runOf(launched.id);

    // Two Pauses prepared from the same revision: the first wins, the second is a stale action.
    const first = await run(
      harness.fixture.runs.applyPause({
        runId: launched.id,
        controlRevision: before.controlRevision,
      }),
    );
    const second = await run(
      harness.fixture.runs.applyPause({
        runId: launched.id,
        controlRevision: before.controlRevision,
      }),
    );
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(
      (await harness.runOf(launched.id)).controlRevision,
      before.controlRevision + 1,
      'exactly one control applied',
    );
  });
});

test('deleting the destination parks the run, and Resume refuses to place work that has nowhere to go', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'human',
      version: '1',
      definition: gateWorkflow('user_continue'),
    });
    const launched = await harness.launch({ workflowKey: 'human' });
    await harness.drain();

    // The event is handled *after* the cascade, exactly as the owner publishes it — so the run has
    // to be found through its retained destination identity, not through an attachment that is
    // already gone.
    harness.fixture.client
      .prepare('DELETE FROM worktrees WHERE id = ?')
      .run(harness.placement.worktreeId);
    assert.equal(
      await run(harness.fixture.runs.findAttachment(launched.id)),
      null,
      'the attachment cascaded away before anything was notified',
    );

    await run(
      harness.fixture.runs.applyEnvironmentAvailability({
        available: false,
        runIds: (
          await run(harness.fixture.runs.listByDestinationWorktree(harness.placement.worktreeId))
        ).map((record) => record.id),
      }),
    );

    const parked = await harness.runOf(launched.id);
    assert.equal(parked.paused, true);
    assert.equal(parked.environmentAvailable, false);
    assert.ok(
      (await run(harness.fixture.runs.listPauseIntervals(launched.id))).some(
        (interval) => interval.reason === 'environment_deleted',
      ),
    );

    const refused = await Effect.runPromiseExit(harness.controls.resume(launched.id));
    assert.equal(refused._tag, 'Failure');
    const unchanged = await harness.runOf(launched.id);
    assert.equal(unchanged.paused, true);
    assert.equal(unchanged.position.kind, parked.position.kind);

    // Retained inspection survives all of it.
    assert.ok((await run(harness.fixture.runs.listFrames(launched.id))).length > 0);
  });
});

test('a missed deletion notification is caught by the claim’s own live-placement re-check', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'gated', version: '1', definition: gatedWorkflow(makeGate()) });
    const launched = await harness.launch({ workflowKey: 'gated' });

    // No notification at all: the flag still says the environment is available, which is precisely
    // the stale-cache case the re-check exists for.
    harness.fixture.client
      .prepare('DELETE FROM worktrees WHERE id = ?')
      .run(harness.placement.worktreeId);
    assert.equal((await harness.runOf(launched.id)).environmentAvailable, true);

    const advanced = await harness.drain();
    assert.equal(advanced, 0, 'no callback ran against a worktree that is gone');
    const attempts = await run(
      harness.fixture.runs.listAttemptsForFrame((await harness.runOf(launched.id)).activeFrameId!),
    );
    assert.deepEqual(
      attempts.map((attempt) => attempt.segmentKind),
      ['environment_preparation'],
      'and the rejected claim allocated no attempt beyond the placement the launch made',
    );
  });
});

test('startup re-derivation finds a run whose environment vanished while the process was down', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'human',
      version: '1',
      definition: gateWorkflow('user_continue'),
    });
    const launched = await harness.launch({ workflowKey: 'human' });
    await harness.drain();

    harness.fixture.client
      .prepare('DELETE FROM worktrees WHERE id = ?')
      .run(harness.placement.worktreeId);
    await harness.restart();

    const parked = await harness.runOf(launched.id);
    assert.equal(parked.environmentAvailable, false);
    assert.equal(parked.paused, true);
  });
});

/**
 * Drives the environment watch through the real bus for one deletion event.
 *
 * The real bus, so the subscription filter and the forked handler are what is exercised rather than
 * a hand-rolled stand-in that could not get either wrong.
 */
async function publishDeletion(harness: EngineHarness, event: InternalRuntimeEvent) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const eventBus = yield* InternalRuntimeEventBus;
        yield* startEnvironmentWatch({
          runs: harness.fixture.runs,
          workspace: {} as never,
          surfaces: {} as never,
          eventBus,
        });
        yield* eventBus.publish(event);
        yield* Effect.sleep('50 millis');
      }),
    ).pipe(Effect.provide(InternalRuntimeEventBusLive)),
  );
}

async function assertParkedByEnvironment(harness: EngineHarness, runId: number) {
  const parked = await harness.runOf(runId);
  assert.equal(parked.environmentAvailable, false);
  assert.equal(parked.paused, true);
  assert.ok(
    (await run(harness.fixture.runs.listPauseIntervals(runId))).some(
      (interval) => interval.reason === 'environment_deleted',
    ),
  );
  // Retained inspection outlives the environment it ran in.
  assert.ok((await run(harness.fixture.runs.listFrames(runId))).length > 0);
}

test('the environment watch parks runs from each deletion event, by destination identity', async () => {
  // One case per event the watch handles. Each deletes the rows first and *then* publishes, exactly
  // as every owner in this codebase does — so a handler that looked for affected runs through the
  // attachment would find nothing every time, and the bug would look like a missed event.
  const cases: readonly {
    readonly name: string;
    readonly cascade: (harness: EngineHarness) => void;
    readonly event: (harness: EngineHarness) => InternalRuntimeEvent;
  }[] = [
    {
      name: 'worktree_deleted',
      cascade: (harness) => {
        harness.fixture.client
          .prepare('DELETE FROM worktrees WHERE id = ?')
          .run(harness.placement.worktreeId);
      },
      event: (harness) => ({
        type: 'worktree_deleted',
        worktreeId: harness.placement.worktreeId,
        projectId: 1,
      }),
    },
    {
      name: 'project_deleted',
      cascade: (harness) => {
        harness.fixture.client.prepare('DELETE FROM projects').run();
      },
      event: (harness) => ({
        type: 'project_deleted',
        projectId: 1,
        // Read before the cascade by the owner, which is the only moment they exist.
        worktreeIds: [harness.placement.worktreeId],
      }),
    },
    {
      name: 'surface_changed: deleted',
      cascade: (harness) => {
        harness.fixture.client
          .prepare('DELETE FROM worktree_surfaces WHERE id = ?')
          .run(harness.placement.surfaceId);
      },
      event: (harness) => ({
        type: 'surface_changed',
        payload: {
          change: 'deleted',
          worktreeId: harness.placement.worktreeId,
          surfaceId: harness.placement.surfaceId,
          deletedPaneIds: [],
        },
      }),
    },
  ];

  for (const testCase of cases) {
    await withHarness(async (harness) => {
      harness.publish({
        workflowKey: 'human',
        version: '1',
        definition: gateWorkflow('user_continue'),
      });
      const launched = await harness.launch({ workflowKey: 'human' });
      await harness.drain();

      testCase.cascade(harness);
      const attachment = await run(harness.fixture.runs.findAttachment(launched.id));
      if (testCase.name === 'surface_changed: deleted') {
        assert.equal(
          attachment?.surfaceId ?? null,
          null,
          `${testCase.name}: the attachment's surface was nulled by the cascade`,
        );
      } else {
        assert.equal(attachment, null, `${testCase.name}: the attachment row cascaded away`);
      }

      await publishDeletion(harness, testCase.event(harness));
      await assertParkedByEnvironment(harness, launched.id);
    });
  }
});

test('deleting one environment leaves a run in another untouched', async () => {
  // Deletion targets a destination, and the query that finds affected runs is by destination
  // identity. A query that was too broad — or an event handler that parked everything it could see —
  // would stop work that has nothing to do with what was deleted, which is the failure this guards.
  const cases: readonly {
    readonly name: string;
    readonly cascade: (harness: EngineHarness, doomed: Placement) => void;
    readonly event: (harness: EngineHarness, doomed: Placement) => InternalRuntimeEvent;
  }[] = [
    {
      name: 'worktree_deleted',
      cascade: (harness, doomed) => {
        harness.fixture.client.prepare('DELETE FROM worktrees WHERE id = ?').run(doomed.worktreeId);
      },
      event: (_harness, doomed) => ({
        type: 'worktree_deleted',
        worktreeId: doomed.worktreeId,
        projectId: 1,
      }),
    },
    {
      name: 'project_deleted',
      cascade: (harness, doomed) => {
        // Each placement has its own project, so deleting one leaves the other's rows alone.
        harness.fixture.client
          .prepare(
            'DELETE FROM projects WHERE id = (SELECT project_id FROM worktrees WHERE id = ?)',
          )
          .run(doomed.worktreeId);
      },
      event: (_harness, doomed) => ({
        type: 'project_deleted',
        projectId: 1,
        worktreeIds: [doomed.worktreeId],
      }),
    },
    {
      name: 'surface_changed: deleted',
      cascade: (harness, doomed) => {
        harness.fixture.client
          .prepare('DELETE FROM worktree_surfaces WHERE id = ?')
          .run(doomed.surfaceId);
      },
      event: (_harness, doomed) => ({
        type: 'surface_changed',
        payload: {
          change: 'deleted',
          worktreeId: doomed.worktreeId,
          surfaceId: doomed.surfaceId,
          deletedPaneIds: [],
        },
      }),
    },
  ];

  for (const testCase of cases) {
    await withHarness(async (harness) => {
      harness.publish({
        workflowKey: 'human',
        version: '1',
        definition: gateWorkflow('user_continue'),
      });
      const survivor = harness.seedPlacement();
      const doomedRun = await harness.launch({ workflowKey: 'human' });
      const survivingRun = await harness.launch({
        workflowKey: 'human',
        placement: survivor,
      });
      await harness.drain();

      const before = await harness.runOf(survivingRun.id);
      const attachmentBefore = await run(harness.fixture.runs.findAttachment(survivingRun.id));
      assert.ok(attachmentBefore, `${testCase.name}: the surviving run is attached to start with`);

      testCase.cascade(harness, harness.placement);
      await publishDeletion(harness, testCase.event(harness, harness.placement));

      await assertParkedByEnvironment(harness, doomedRun.id);

      const after = await harness.runOf(survivingRun.id);
      assert.equal(after.environmentAvailable, true, `${testCase.name}: still available`);
      assert.equal(after.paused, false, `${testCase.name}: still running`);
      assert.equal(after.status, before.status, `${testCase.name}: status unchanged`);
      assert.deepEqual(after.position, before.position, `${testCase.name}: position unchanged`);
      assert.equal(after.artifactHash, before.artifactHash, `${testCase.name}: pin unchanged`);
      assert.equal(after.revision, before.revision, `${testCase.name}: no transition appended`);
      assert.equal(
        after.controlRevision,
        before.controlRevision,
        `${testCase.name}: no control applied`,
      );
      assert.equal(after.activeAttemptId, before.activeAttemptId);
      assert.equal(after.owner, before.owner);
      assert.deepEqual(
        await run(harness.fixture.runs.findAttachment(survivingRun.id)),
        attachmentBefore,
        `${testCase.name}: its placement is untouched`,
      );
      assert.deepEqual(
        (await run(harness.fixture.runs.listPauseIntervals(survivingRun.id))).filter(
          (interval) => interval.reason === 'environment_deleted',
        ),
        [],
        `${testCase.name}: and it was never parked`,
      );
    });
  }
});

test('a Retry prepared before a competing control lands is refused, changing nothing', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'human', version: 'broken', definition: failingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'human' });
    await harness.drain();
    const failed = await harness.runOf(launched.id);
    assert.equal(failed.status, 'failed');

    harness.publish({
      workflowKey: 'human',
      version: 'fixed',
      definition: gateWorkflow('user_continue'),
    });
    harness.setCurrent('human', 'fixed');

    // Retry resolves, loads and structurally validates outside any transaction. A control landing in
    // that window is exactly what the adoption's revision fence exists for: the newer control wins,
    // and the prepared decision loses without writing anything.
    const before = await harness.runOf(launched.id);
    const attemptsBefore = await run(
      harness.fixture.runs.listAttemptsForFrame(before.activeFrameId!),
    );
    const adoptionsBefore = await run(harness.fixture.runs.listVersionAdoptions(launched.id));
    let raced = false;
    harness.onArtifactResolve(async () => {
      if (raced) return;
      raced = true;
      // A real control a person could genuinely apply to a failed run while a Retry is being
      // prepared: they dismiss it. It changes the control revision, which is all the fence reads.
      const dismissed = await run(harness.controls.dismiss(launched.id));
      assert.equal(dismissed.accepted, true, 'the competing control landed');
    });

    const refused = await Effect.runPromiseExit(harness.controls.retry(launched.id));
    assert.equal(raced, true, 'the window was actually exercised');
    // Either the control layer surfaces the stale adoption as a rejection, or it reports it as not
    // accepted; what matters is that nothing moved.
    const accepted =
      refused._tag === 'Success' ? (refused.value as { accepted: boolean }).accepted : false;
    assert.equal(accepted, false, 'a stale prepared adoption is never accepted');

    const after = await harness.runOf(launched.id);
    assert.equal(after.artifactHash, before.artifactHash, 'the pin did not move');
    assert.deepEqual(after.position, before.position, 'nor the saved position');
    assert.equal(after.failureCode, before.failureCode, 'nor the failure evidence');
    assert.equal(after.pendingInvocationKind, null, 'no retry was queued for the next claim');
    assert.deepEqual(
      await run(harness.fixture.runs.listAttemptsForFrame(before.activeFrameId!)),
      attemptsBefore,
      'no attempt was created or rewritten',
    );
    assert.deepEqual(
      await run(harness.fixture.runs.listVersionAdoptions(launched.id)),
      adoptionsBefore,
      'and nothing was adopted',
    );
    assert.equal(
      (
        harness.fixture.client
          .prepare(
            "SELECT count(*) AS count FROM workflow_transitions WHERE run_id = ? AND kind = 'retry_pin_adopted'",
          )
          .get(launched.id) as { count: number }
      ).count,
      0,
      'and no adoption transition was recorded',
    );

    // Without the competing control the same Retry is accepted, so the refusal above was the fence
    // doing its job rather than the Retry being impossible.
    harness.onArtifactResolve(() => {});
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    const adopted = await harness.runOf(launched.id);
    assert.notEqual(adopted.artifactHash, before.artifactHash);
    assert.equal(adopted.pendingInvocationKind, 'retry');
  });
});

/** One headless judgment, so a wait can resolve from the outside world while the run is paused. */
function judgingWorkflow(): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly verdict: string | null }, {}, Record<string, unknown>>({
    key: 'judging',
    title: 'Judging',
    init: () => ({ verdict: null }),
    state: { verdict: reduce.replace<string | null>() },
    entry: 'judge',
    nodes: {
      judge: operation(async (ctx) => {
        const handle = await ctx.runHeadlessAgent({ harness: 'claude', prompt: 'judge it' });
        return suspend({ wait: wait.headlessAgent(handle) });
      }),
      record: operation(async () => complete({ update: { verdict: 'recorded' } })),
    },
    edges: {
      'judge-out': edge({ from: 'judge', to: ['record'], choose: () => ({ to: 'record' }) }),
      'record-out': edge({ from: 'record', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: {
      done: outcome({ kind: 'success', output: (state) => ({ verdict: state.verdict }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Judging' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

function transitionCount(harness: EngineHarness, runId: number, kind: string) {
  return (
    harness.fixture.client
      .prepare('SELECT count(*) AS count FROM workflow_transitions WHERE run_id = ? AND kind = ?')
      .get(runId, kind) as { count: number }
  ).count;
}

test('an external operation resolves its wait while the run is paused, and Resume alone finishes it', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'judging', version: '1', definition: judgingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'judging' });
    await harness.drain();

    const waiting = await harness.runOf(launched.id);
    assert.equal(waiting.status, 'waiting');
    assert.equal(harness.adapters.counters.starts, 1, 'the effect crossed a boundary once');
    const operationRecord = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;

    // Pause opens *before* the operation settles. Pause gates dispatch; it has no authority over an
    // effect that is already out in the world.
    assert.equal((await run(harness.controls.pause(launched.id))).accepted, true);
    assert.equal((await harness.runOf(launched.id)).paused, true);

    // The world answers, and the resolver delivers through its ordinary path.
    await harness.settleOperation({
      operationId: operationRecord.id,
      state: 'completed',
      result: { operationId: operationRecord.operationKey, status: 'completed', output: 'ok' },
    });
    assert.equal(await harness.deliver(launched.id), 1);

    const ready = await harness.runOf(launched.id);
    assert.equal(ready.status, 'ready', 'readiness is recorded — readiness is not dispatch');
    assert.equal(ready.paused, true, 'and the gate is still closed');
    assert.equal(ready.position.kind, 'routing');
    assert.equal(transitionCount(harness, launched.id, 'wait_delivered'), 1);

    // The dispatcher will not claim it while the gate is closed.
    const attemptsWhilePaused = await run(
      harness.fixture.runs.listAttemptsForFrame(ready.activeFrameId!),
    );
    assert.equal(await harness.drain(), 0, 'nothing is claimed');
    assert.deepEqual(
      await run(harness.fixture.runs.listAttemptsForFrame(ready.activeFrameId!)),
      attemptsWhilePaused,
      'and no attempt was allocated',
    );

    // Resume alone finishes it: no second operation event, no further reconciliation call.
    assert.equal((await run(harness.controls.resume(launched.id))).accepted, true);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.deepEqual(await run(harness.fixture.payloads.resolve(finished.output!)), {
      verdict: 'recorded',
    });
    assert.equal(
      transitionCount(harness, launched.id, 'wait_delivered'),
      1,
      'delivered exactly once across the whole run',
    );
    assert.equal(harness.adapters.counters.starts, 1, 'and the effect was never repeated');
  });
});

test('a callback already running when its placement disappears still commits its boundary', async () => {
  await withHarness(async (harness) => {
    const gate = makeGate();
    harness.publish({
      workflowKey: 'gated',
      version: '1',
      // No `ctx` call after the gate: the point is that the segment commits, not that it can still
      // reach out to anything once its destination is gone.
      definition: gatedWorkflow(gate, { logAfterGate: false }),
    });
    const launched = await harness.launch({ workflowKey: 'gated' });

    const draining = harness.drain();
    await gate.enteredPromise;
    const claimed = await harness.runOf(launched.id);
    assert.equal(claimed.status, 'running');
    assert.ok(claimed.activeAttemptId, 'the segment is claimed and its callback is in flight');
    const attemptId = claimed.activeAttemptId!;
    const owner = claimed.owner;

    // The destination goes away underneath it, announced the way its owner announces it: after the
    // rows are gone.
    harness.fixture.client
      .prepare('DELETE FROM worktrees WHERE id = ?')
      .run(harness.placement.worktreeId);
    await publishDeletion(harness, {
      type: 'worktree_deleted',
      worktreeId: harness.placement.worktreeId,
      projectId: 1,
    });
    const parked = await harness.runOf(launched.id);
    assert.equal(parked.environmentAvailable, false);
    assert.equal(parked.paused, true);
    assert.equal(parked.activeAttemptId, attemptId, 'the in-flight attempt still belongs to it');

    // Now let the callback return.
    gate.release();
    await draining;

    // Its boundary committed, under the ownership it was claimed with. `environment_available` is a
    // dispatch gate exactly like `paused`, not a commit gate — interrupting a callback that has
    // already done its work would lose the work rather than protect anything.
    const attempt = (await run(harness.fixture.runs.findAttempt(attemptId)))!;
    assert.equal(attempt.status, 'succeeded');
    assert.equal(attempt.endCertainty, 'observed');
    assert.equal(attempt.artifactHash, claimed.artifactHash);
    const after = await harness.runOf(launched.id);
    assert.equal(after.position.kind, 'routing', 'the committed result moved the position on');
    const frame = (await run(harness.fixture.runs.findFrame(after.activeFrameId!)))!;
    assert.deepEqual(await run(harness.fixture.payloads.resolve(frame.state!)), {
      steps: ['worked'],
    });
    assert.equal(transitionCount(harness, launched.id, 'state_reduced'), 1);

    // And nothing succeeds it: the placement is gone and the gate is closed.
    assert.equal(after.environmentAvailable, false);
    assert.equal(after.paused, true);
    assert.equal(after.activeAttemptId, null, 'ownership was released with the commit');
    assert.equal(after.owner, null);
    assert.notEqual(owner, null);
    assert.ok(
      (await run(harness.fixture.runs.listPauseIntervals(launched.id))).some(
        (interval) => interval.reason === 'environment_deleted' && interval.resumedAt === null,
      ),
      'the environment pause band is open',
    );
    assert.equal(await harness.drain(), 0, 'no successor segment is claimed');
    assert.deepEqual(
      (await run(harness.fixture.runs.listAttemptsForFrame(frame.id))).map(
        (candidate) => candidate.segmentKind,
      ),
      ['environment_preparation', 'graph_entry', 'node_callback'],
      'and the routing segment was never allocated an attempt',
    );

    // Resume is refused while the destination is gone, so the run stays exactly where it is.
    const refused = await Effect.runPromiseExit(harness.controls.resume(launched.id));
    assert.equal(refused._tag, 'Failure');
    assert.deepEqual(await harness.runOf(launched.id), after);
  });
});

/** A callback that performs a durable operation and then suspends on an unrelated human gate. */
function promptThenAskWorkflow(): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly answer: string | null }, {}, Record<string, unknown>>({
    key: 'prompt-then-ask',
    title: 'Prompt then ask',
    init: () => ({ answer: null }),
    state: { answer: reduce.replace<string | null>() },
    entry: 'ask',
    nodes: {
      ask: operation(async (ctx) => {
        await ctx.sendAgentPrompt({ agentSessionId: 500, prompt: 'get started' });
        return suspend({ wait: wait.userContinue('Ready?') });
      }),
    },
    edges: {
      'ask-out': edge({
        from: 'ask',
        to: ['answered'],
        choose: () => ({ to: 'answered', update: { answer: 'continued' } }),
      }),
    },
    outcomes: {
      answered: outcome({ kind: 'success', output: (state) => ({ answer: state.answer }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Prompt then ask' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

test('answering a human gate does not discharge an unrelated uncertainty', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'prompt-then-ask',
      version: '1',
      definition: promptThenAskWorkflow(),
    });
    const launched = await harness.launch({ workflowKey: 'prompt-then-ask' });
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'waiting');

    // The prompt's outcome turns out to be unestablishable, and the run is blocked on it. The human
    // gate it suspended on is a *different* question entirely.
    const submission = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;
    await run(
      harness.fixture.operations.settle({
        operationId: submission.id,
        state: 'uncertain',
        uncertaintyDetail: 'no_turn_observed_after_submission',
      }),
    );
    await run(harness.operations.reconcileExecution(submission.executionId).pipe(Effect.asVoid));
    const blocked = await harness.runOf(launched.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedOperationId, submission.id);

    // Answering the gate says nothing about whether the prompt landed, so it cannot release the
    // run — and reporting it as accepted would let the person believe it had.
    const armed = (await run(harness.fixture.runs.listArmedWaits(launched.id)))[0]!;
    const refused = await Effect.runPromiseExit(
      harness.controls.advance({ runId: launched.id, waitId: armed.id }),
    );
    assert.equal(refused._tag, 'Failure');

    const after = await harness.runOf(launched.id);
    assert.equal(after.status, 'blocked', 'the run is still blocked');
    assert.equal(
      after.blockedOperationId,
      submission.id,
      'and still names what it cannot account for',
    );
    assert.deepEqual(after.position, blocked.position);
    assert.equal(await harness.drain(), 0, 'and nothing dispatches');

    // Cancel is the way out, and it keeps every record including the unresolved operation.
    assert.equal((await run(harness.controls.cancel(launched.id))).accepted, true);
    assert.equal((await harness.runOf(launched.id)).status, 'cancelled');
    assert.equal(
      (await run(harness.fixture.operations.findById(submission.id)))!.state,
      'uncertain',
    );
  });
});

/**
 * A callback that both prompts and launches a judgment, then suspends on the judgment.
 *
 * The shape matters: the prompt is what becomes uncertain, and the *judgment's* wait is what the
 * world can still answer — so a blocked run really can receive an external event it must keep.
 */
function promptAndJudgeWorkflow(): AnyWorkflowDefinition {
  const graph = createGraph<{ readonly verdict: string | null }, {}, Record<string, unknown>>({
    key: 'prompt-and-judge',
    title: 'Prompt and judge',
    init: () => ({ verdict: null }),
    state: { verdict: reduce.replace<string | null>() },
    entry: 'work',
    nodes: {
      work: operation(async (ctx) => {
        await ctx.sendAgentPrompt({ agentSessionId: 500, prompt: 'get started' });
        const handle = await ctx.runHeadlessAgent({ harness: 'claude', prompt: 'judge it' });
        return suspend({ wait: wait.headlessAgent(handle) });
      }),
    },
    edges: {
      'work-out': edge({
        from: 'work',
        to: ['done'],
        choose: () => ({ to: 'done', update: { verdict: 'judged' } }),
      }),
    },
    outcomes: {
      done: outcome({ kind: 'success', output: (state) => ({ verdict: state.verdict }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Prompt and judge' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

test('an external event reaching a blocked run is kept as evidence and moves nothing', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'prompt-and-judge',
      version: '1',
      definition: promptAndJudgeWorkflow(),
    });
    const launched = await harness.launch({ workflowKey: 'prompt-and-judge' });
    await harness.drain();

    const operations = await run(harness.fixture.operations.listForRun(launched.id));
    const prompt = operations.find((record) => record.capability === 'send_agent_prompt')!;
    const judgment = operations.find((record) => record.capability === 'run_headless_agent')!;

    // The prompt's outcome cannot be established, so the run is blocked on it.
    await run(
      harness.fixture.operations.settle({
        operationId: prompt.id,
        state: 'uncertain',
        uncertaintyDetail: 'no_turn_observed_after_submission',
      }),
    );
    await run(harness.operations.reconcileExecution(prompt.executionId).pipe(Effect.asVoid));
    const blocked = await harness.runOf(launched.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedOperationId, prompt.id);

    // The judgment then finishes. That is a fact about the world: discarding it would lose evidence,
    // so it is recorded and the wait is delivered — but it says nothing about the prompt, so the run
    // stays exactly where it is.
    await harness.settleOperation({
      operationId: judgment.id,
      state: 'completed',
      result: { operationId: judgment.operationKey, status: 'completed', output: 'fine' },
    });
    assert.equal(await harness.deliver(launched.id), 0, 'delivery did not advance the run');

    const waitRow = (
      await run(harness.fixture.runs.listWaitsForExecution(judgment.executionId))
    )[0]!;
    assert.equal(waitRow.status, 'delivered', 'the event was kept on the wait');
    assert.ok(waitRow.event, 'with its payload');
    const after = await harness.runOf(launched.id);
    assert.equal(after.status, 'blocked');
    assert.equal(after.blockedOperationId, prompt.id);
    assert.deepEqual(after.position, blocked.position, 'the position did not advance');
    assert.equal(transitionCount(harness, launched.id, 'wait_delivered'), 1);
    assert.equal(await harness.drain(), 0, 'and nothing is dispatched');
  });
});

test('an operator answer to a blocked run is refused, not consumed', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'prompt-then-ask',
      version: '1',
      definition: promptThenAskWorkflow(),
    });
    const launched = await harness.launch({ workflowKey: 'prompt-then-ask' });
    await harness.drain();

    const submission = (await run(harness.fixture.operations.listForRun(launched.id)))[0]!;
    await run(
      harness.fixture.operations.settle({
        operationId: submission.id,
        state: 'uncertain',
        uncertaintyDetail: 'no_turn_observed_after_submission',
      }),
    );
    await run(harness.operations.reconcileExecution(submission.executionId).pipe(Effect.asVoid));
    const blocked = await harness.runOf(launched.id);
    const armed = (await run(harness.fixture.runs.listArmedWaits(launched.id)))[0]!;

    // Refused inside the transaction, so a run that becomes blocked between a caller's check and the
    // write cannot slip an answer through either. Nothing about the gate is consumed.
    const refused = await run(
      harness.fixture.runs.consumeHumanWait({
        waitId: armed.id,
        event: { value: { kind: 'user_continue' } },
        edgeId: 'ask-out',
      }),
    );
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.deepEqual(refused.rejection, {
      kind: 'run_blocked',
      blockedOperationId: submission.id,
    });

    assert.equal(
      (await run(harness.fixture.runs.findWait(armed.id)))!.status,
      'armed',
      'the gate is still answerable if the uncertainty is ever resolved',
    );
    const after = await harness.runOf(launched.id);
    assert.deepEqual(after, blocked, 'and nothing about the run moved');
    assert.equal(transitionCount(harness, launched.id, 'wait_delivered'), 0);
  });
});

/**
 * The controls, pointed at a run that is still preparing its environment.
 *
 * A preparing run is the one position the dispatcher never claims, which changes what each control
 * can honestly do. Retry becomes the *only* thing that moves it — so it claims the segment itself
 * and blocks on it, exactly as the launch request does. Pause and Resume become refusals, because a
 * paused preparation would wait for a Resume that hands it back to a worker that will not take it.
 * Cancel, Dismiss and Advance are unchanged, and the cases below say what "unchanged" means here.
 *
 * The preparation itself is phase 07's subject and has its own file; what is under test here is the
 * control boundary in front of it.
 */

interface SelectorLog {
  calls: number;
}

function preparableGraph() {
  return createGraph<{ readonly rounds: number }, {}, Record<string, unknown>>({
    key: 'preparable',
    title: 'Preparable',
    init: () => ({ rounds: 0 }),
    state: { rounds: reduce.add() },
    entry: 'work',
    nodes: { work: operation(async () => complete({ update: { rounds: 1 } })) },
    edges: {
      'work-out': edge({ from: 'work', to: ['finished'], choose: () => ({ to: 'finished' }) }),
    },
    outcomes: { finished: outcome({ kind: 'success', output: () => ({}) }) },
  });
}

/**
 * A workflow that can carry an `environment` selector, and that can be *demoted*.
 *
 * `demoted` keeps `preparable` declared — as a subgraph of a new root — which is the case the
 * graph-exists check cannot see. The graph a run was created to start in is still there; it is
 * simply no longer where this workflow begins.
 */
function preparableWorkflow(
  options: {
    readonly selector?: SelectorLog | undefined;
    readonly demoted?: boolean | undefined;
  } = {},
): AnyWorkflowDefinition {
  const preparable = preparableGraph();
  const graph = options.demoted
    ? createGraph<{ readonly rounds: number }, {}, Record<string, unknown>>({
        key: 'relocated',
        title: 'Relocated',
        init: () => ({ rounds: 0 }),
        state: { rounds: reduce.add() },
        entry: 'inner',
        nodes: {
          inner: subgraph({
            graph: preparable,
            parameters: () => ({}),
            onResult: () => ({ rounds: 1 }),
          }),
        },
        edges: {
          'inner-out': edge({
            from: 'inner',
            to: ['finished'],
            choose: () => ({ to: 'finished' }),
          }),
        },
        outcomes: { finished: outcome({ kind: 'success', output: () => ({}) }) },
      })
    : preparable;
  const selector = options.selector;
  return defineWorkflow({
    command: () => ({ title: 'Preparable' }),
    validate: () => {},
    ...(selector
      ? {
          environment: () => {
            selector.calls += 1;
            return {
              worktree: { kind: 'create' as const, branch: 'feature/prep', fromRef: 'main' },
              surface: { kind: 'create' as const, title: 'Prep' },
            };
          },
        }
      : {}),
    graph,
  }) as AnyWorkflowDefinition;
}

function transitionKindsOf(harness: EngineHarness, runId: number): string[] {
  return (
    harness.fixture.client
      .prepare('SELECT kind FROM workflow_transitions WHERE run_id = ? ORDER BY revision')
      .all(runId) as { kind: string }[]
  ).map((row) => row.kind);
}

/** Hooks that fail, which is the cheapest way to a failed preparation that allocated something. */
const failingSetup = {
  status: 'failed',
  runId: 7,
  failedHookIndex: 1,
  failedHookType: 'command',
  message: 'the hook exited non-zero',
  exitCode: 1,
  outputExcerpt: 'boom',
} as const;

async function preparationFailureOf(harness: EngineHarness, runId: number) {
  const failed = await harness.runOf(runId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'environment_preparation_failed');
  const attempt = (await run(harness.fixture.runs.findAttempt(failed.failureAttemptId!)))!;
  return (await run(harness.fixture.payloads.resolve(attempt.failureDetail!))) as Record<
    string,
    unknown
  >;
}

/** Runs a control and returns the error it refused with, failing the test if it did not refuse. */
async function refusalOf(effect: Effect.Effect<unknown, unknown>): Promise<WorkflowEngineError> {
  const exit = await Effect.runPromiseExit(effect);
  assert.equal(exit._tag, 'Failure', 'expected the control to refuse');
  if (exit._tag !== 'Failure') throw new Error('unreachable');
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  assert.ok(
    failure instanceof WorkflowEngineError,
    `expected a typed refusal, got ${Cause.pretty(exit.cause)}`,
  );
  return failure;
}

/**
 * Drives a launch to a failed preparation that created a worktree and then failed its hooks.
 *
 * `branch: null` omits the caller override entirely, which is the only way the author's selector
 * gets asked — a caller `placement` beats the hook, by design.
 */
async function failedPreparation(harness: EngineHarness, branch: string | null = 'feature/retry') {
  harness.owning.allowsWorktrees({ setup: failingSetup }).allowsSurfaces();
  const started = await harness.launch({
    workflowKey: 'preparable',
    ...(branch === null ? {} : { request: createBoth(branch, 'Prep') }),
  });
  const detail = await preparationFailureOf(harness, started.id);
  assert.deepEqual([detail.step, detail.reason], ['setup', 'setup_failed']);
  return started;
}

test('Retry of a failed preparation adopts the latest verified version, and never re-runs the selector', async () => {
  await withHarness(async (harness) => {
    const selector: SelectorLog = { calls: 0 };
    harness.publish({
      workflowKey: 'preparable',
      version: '1',
      definition: preparableWorkflow({ selector }),
    });

    const started = await failedPreparation(harness, null);
    assert.equal(selector.calls, 1, 'the launch asked the author where to go');
    const failed = await harness.runOf(started.id);

    // A newer verified version, published after the failure. Retry adopts it — the same
    // latest-code semantics every other Retry has, so an author who fixed their package is not left
    // running the old code because the failure happened to be in preparation.
    harness.publish({
      workflowKey: 'preparable',
      version: '2',
      definition: preparableWorkflow({ selector }),
    });
    harness.setCurrent('preparable', '2');
    harness.owning.calls.length = 0;
    harness.owning.allowsSetup({ status: 'succeeded', runId: 9 });

    const retried = await harness.retry(started.id);
    assert.deepEqual([retried.accepted, retried.status], [true, 'ready']);

    const after = await harness.runOf(started.id);
    assert.notEqual(after.artifactHash, failed.artifactHash, 'the newer version was adopted');
    assert.equal(after.position.kind, 'graph_entry');
    const kinds = transitionKindsOf(harness, started.id);
    assert.deepEqual(
      kinds.slice(kinds.indexOf('retry_pin_adopted')),
      [
        'retry_pin_adopted',
        // The adoption's own control band, written in the same transaction as the repin.
        'control_applied',
        'node_dispatched',
        // The two allocations this attempt made: hooks, then the surface.
        'environment_step_recorded',
        'environment_step_recorded',
        'environment_prepared',
      ],
      'the adoption precedes the claim, the claim precedes the work, and the commit ends it',
    );

    /**
     * The selector was **not** asked again, and that is the load-bearing assertion here.
     *
     * The recorded placement request *is* the decision. Re-selecting under a newer version could
     * silently relocate a run that has already created a worktree, and the receipts that make
     * re-entry safe are all written against the first answer.
     */
    assert.equal(selector.calls, 1);
    const prep = (await harness.preparationOf(started.id))!;
    assert.equal(prep.source, 'selector');
    assert.deepEqual(
      harness.owning.calls,
      ['runWorktreeSetup', 'createSinglePaneSurface'],
      'and the worktree it already created was reused, not made a second time',
    );
    assert.deepEqual(harness.owning.deletions, []);
  });
});

test('Retry refuses a version whose root graph is no longer the root, changing nothing', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'preparable', version: '1', definition: preparableWorkflow() });
    const started = await failedPreparation(harness, 'feature/moved');
    const before = await harness.runOf(started.id);
    const prepBefore = (await harness.preparationOf(started.id))!;

    // The graph the run was created to start in is **still declared**, now as a subgraph of a new
    // root. The graph-exists check passes on it; being the *root* is the thing that changed, and
    // resuming here would start the run somewhere the author no longer begins.
    harness.publish({
      workflowKey: 'preparable',
      version: '2',
      definition: preparableWorkflow({ demoted: true }),
    });
    harness.setCurrent('preparable', '2');

    harness.owning.calls.length = 0;
    const refusal = await refusalOf(harness.controls.retry(started.id));
    assert.equal(refusal.code, 'workflow_structure_validation_failed');
    assert.deepEqual(
      refusal.diagnostics?.map((diagnostic) => diagnostic.code),
      ['graph_missing'],
    );

    assert.deepEqual(await harness.runOf(started.id), before, 'the run is byte-identical');
    assert.deepEqual(await harness.preparationOf(started.id), prepBefore);
    assert.deepEqual(harness.owning.calls, [], 'and nothing was allocated by a refused Retry');
  });
});

test('Retry blocks until the preparation it claimed has settled', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'preparable', version: '1', definition: preparableWorkflow() });
    const started = await failedPreparation(harness, 'feature/blocking');

    // Ordering, observed rather than assumed: the hook records that it ran, and the control must
    // not have returned before it did.
    const order: string[] = [];
    harness.owning.allowsSetup({ status: 'succeeded', runId: 4 });
    harness.owning.setRunWorktreeSetup(() =>
      Effect.suspend(() => {
        order.push('setup');
        return Effect.succeed({ status: 'succeeded', runId: 4 } as const);
      }),
    );

    const retried = await harness.retry(started.id);
    order.push('returned');

    assert.deepEqual(order, ['setup', 'returned'], 'the control waited for the work it claimed');
    // The status it reports is the *settled* one, read after preparation finished rather than the
    // `ready` the pin adoption left a moment earlier.
    assert.deepEqual([retried.accepted, retried.status], [true, 'ready']);
    assert.equal((await harness.runOf(started.id)).position.kind, 'graph_entry');
    assert.ok((await harness.preparationOf(started.id))!.surface, 'through to the last step');
  });
});

test('Pause and Resume refuse a preparing run, and a stopped one is stale rather than preparing', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'preparable', version: '1', definition: preparableWorkflow() });
    harness.owning.allowsWorktrees().allowsSurfaces();

    // Both controls are applied from *inside* the preparation, which is the only moment a run is
    // genuinely preparing: a failed one keeps this position forever.
    const refusals: WorkflowEngineError[] = [];
    harness.owning.wrapOpenWorktree(
      (inner) => (input) =>
        inner(input).pipe(
          Effect.tap(() =>
            Effect.promise(async () => {
              refusals.push(await refusalOf(harness.controls.pause(1)));
              refusals.push(await refusalOf(harness.controls.resume(1)));
            }),
          ),
        ),
    );

    const started = await harness.launch({
      workflowKey: 'preparable',
      request: createBoth('feature/gated', 'Gated'),
    });

    assert.deepEqual(
      refusals.map((refusal) => [refusal.code, refusal.operation]),
      [
        ['workflow_run_preparing', 'pause'],
        ['workflow_run_preparing', 'resume'],
      ],
    );
    const placed = await harness.runOf(started.id);
    assert.equal(placed.paused, false, 'the refusal happened before any write');
    assert.equal(placed.position.kind, 'graph_entry', 'and the preparation finished regardless');

    /**
     * The terminal check has to come first, and this is why.
     *
     * A run that *failed* while preparing keeps `environment_preparation` as its position. Answering
     * `workflow_run_preparing` there would tell the person "this run is still setting up where
     * it'll work" about a run that is already dead — which is the shipped copy for that reason, and
     * a straightforwardly false statement.
     */
    const stopped = await failedPreparation(harness, 'feature/stopped');
    const stale = await refusalOf(harness.controls.pause(stopped.id));
    assert.deepEqual([stale.code, stale.operation], ['workflow_stale_control', 'pause']);
    assert.equal(
      (await refusalOf(harness.controls.resume(stopped.id))).code,
      'workflow_stale_control',
    );
  });
});

test('Cancel during preparation keeps the receipt, advances nothing, and closes Retry', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'preparable', version: '1', definition: preparableWorkflow() });
    harness.owning.allowsWorktrees().allowsSurfaces();
    harness.owning.wrapOpenWorktree(
      (inner) => (input) =>
        inner(input).pipe(
          Effect.tap(() =>
            Effect.promise(async () => void (await run(harness.controls.cancel(1)))),
          ),
        ),
    );

    const started = await harness.launch({
      workflowKey: 'preparable',
      request: createBoth('feature/cancelled', 'Cancelled'),
    });

    const cancelled = await harness.runOf(started.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.position.kind, 'environment_preparation', 'nothing advanced');
    assert.deepEqual(cancelled.destination, {
      worktreeId: null,
      worktreePath: null,
      surfaceId: null,
    });

    // Receipts are evidence, not decisions: what was really created is recorded even though the
    // run that created it was cancelled, because that record is all a person has to find it by.
    const prep = (await harness.preparationOf(started.id))!;
    assert.equal(prep.worktree?.acquisition, 'created');
    const attempt = (await run(
      harness.fixture.runs.findAttempt(cancelled.failureAttemptId ?? prep.runId),
    ))!;
    assert.equal(attempt.status, 'cancelled');
    assert.deepEqual(harness.owning.deletions, [], 'and nothing was tidied away');

    // Retry is closed, which is what the summary's `controls.retry` flag will report in phase 09.
    // Asserted here from the control's own side: a flag that says `false` while the control would
    // have accepted is the failure worth catching.
    const refusal = await refusalOf(harness.controls.retry(started.id));
    assert.equal(refusal.code, 'workflow_run_not_retryable');
  });
});

test('Dismiss on a failed preparation finds no attachment, and changes nothing', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'preparable', version: '1', definition: preparableWorkflow() });
    const started = await failedPreparation(harness, 'feature/dismissed');
    const before = await harness.runOf(started.id);
    const prepBefore = (await harness.preparationOf(started.id))!;

    // A preparing run never reached the commit, so it has no attachment to release. That is a
    // `detached: false` from `detachRun`, not a refusal — the run is terminal and Dismiss is the
    // control for a terminal run.
    const dismissed = await run(harness.controls.dismiss(started.id));
    assert.equal(dismissed.accepted, true);
    assert.equal(dismissed.status, 'failed');
    assert.equal(await run(harness.fixture.runs.findAttachment(started.id)), null);
    assert.equal((await harness.runOf(started.id)).position.kind, before.position.kind);
    assert.deepEqual(
      await harness.preparationOf(started.id),
      prepBefore,
      'and every receipt is still there to find the worktree by',
    );
  });
});
