import assert from 'node:assert/strict';
import test from 'node:test';

import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  field,
  operation,
  outcome,
  reduce,
  subgraph,
  suspend,
  wait,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Effect } from 'effect';

import { run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { makeEngineHarness, type EngineHarness } from './test-support.js';

/**
 * Which producer a repaired segment re-runs, and which it must not.
 *
 * The rule under test is that the **durable operand** decides, not the latest failure code. Keying
 * off the diagnostic breaks after one hop — a `reduction_failed` retried under a pin that removed
 * the field fails with `unknown_state_field`, and the next Retry would then re-enter a callback that
 * already succeeded and re-dispatch its effects — and it cannot answer the crash case at all, where
 * there is no failure code to key off.
 *
 * Every assertion here therefore counts *invocations*, not eventual state. A run that finishes is
 * not evidence that it finished without doing the work twice.
 */

interface Counters {
  callback: number;
  choose: number;
  output: number;
  mapping: number;
}

function makeCounters(): Counters {
  return { callback: 0, choose: 0, output: 0, mapping: 0 };
}

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

/**
 * One node, one router, one outcome — with every pure seam counted and every failure switchable.
 *
 * Written as one parameterized definition rather than five near-identical graphs so that "version 2
 * differs from version 1 only in the named way" is true by construction.
 */
function countingWorkflow(
  counters: Counters,
  options: {
    readonly reducerThrows?: boolean;
    readonly dropField?: boolean;
    readonly chooseTo?: string;
    readonly chooseThrows?: boolean;
    readonly outputThrows?: boolean;
  },
): AnyWorkflowDefinition {
  const noted = options.reducerThrows
    ? field<readonly string[], string>({
        reduce: () => {
          throw new Error('the reducer for notes is broken in this version');
        },
      })
    : reduce.append<string>();

  const state = options.dropField
    ? { rounds: reduce.add() }
    : { rounds: reduce.add(), notes: noted };

  const graph = createGraph<
    { readonly rounds: number; readonly notes?: readonly string[] },
    { readonly notes: string },
    Record<string, unknown>
  >({
    key: 'counted',
    title: 'Counted',
    init: () => (options.dropField ? { rounds: 0 } : { rounds: 0, notes: [] }),
    state: state as never,
    entry: 'work',
    nodes: {
      work: operation(async () => {
        counters.callback += 1;
        return complete({ update: { rounds: 1, notes: 'did the work' } });
      }),
    },
    edges: {
      'work-out': edge({
        from: 'work',
        to: ['finished', 'other'],
        choose: () => {
          counters.choose += 1;
          if (options.chooseThrows) throw new Error('the router is broken in this version');
          return { to: options.chooseTo ?? 'finished' };
        },
      }),
    },
    outcomes: {
      finished: outcome({
        kind: 'success',
        output: (value) => {
          counters.output += 1;
          if (options.outputThrows) throw new Error('the output evaluator is broken');
          return { rounds: value.rounds };
        },
      }),
      other: outcome({
        kind: 'success',
        output: () => {
          counters.output += 1;
          return { other: true };
        },
      }),
    },
  });

  return defineWorkflow({
    command: () => ({ title: 'Counted' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

test('a reduction failure retries the reduction, never the callback that produced the result', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'counted',
      version: 'broken-reducer',
      definition: countingWorkflow(counters, { reducerThrows: true }),
    });
    const launched = await harness.launch({ workflowKey: 'counted' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'reducer_failed');
    assert.equal(counters.callback, 1);

    // The whole validated result is retained, not just its update: a suspending result would need
    // its wait declaration back too, and neither the discriminant nor the wait is reconstructible.
    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(failed.activeFrameId!));
    const callbackAttempt = attempts.find((attempt) => attempt.segmentKind === 'node_callback')!;
    assert.ok(callbackAttempt.producerOutput, 'the producer operand survives the failed reduction');
    assert.deepEqual(await run(harness.fixture.payloads.resolve(callbackAttempt.producerOutput!)), {
      type: 'complete',
      update: { rounds: 1, notes: 'did the work' },
    });

    // Retry under a version whose only difference is a working reducer.
    harness.publish({
      workflowKey: 'counted',
      version: 'fixed',
      definition: countingWorkflow(counters, {}),
    });
    harness.setCurrent('counted', 'fixed');
    const retried = await run(harness.controls.retry(launched.id));
    assert.equal(retried.accepted, true);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.equal(counters.callback, 1, 'the callback that already succeeded did not run again');

    const repaired = await run(
      harness.fixture.runs.listAttemptsForFrame(finished.activeFrameId ?? failed.activeFrameId!),
    );
    const callbackAttempts = repaired.filter((attempt) => attempt.segmentKind === 'node_callback');
    assert.deepEqual(
      callbackAttempts.map((attempt) => [
        attempt.attemptIndex,
        attempt.status,
        attempt.invocationKind,
      ]),
      [
        [1, 'failed', 'initial'],
        [2, 'succeeded', 'retry'],
      ],
      'the repair is a second attempt at the same segment, not a new visit',
    );
  });
});

test('a third Retry still reuses the saved operand, after an intermediate failure under a bad pin', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'counted',
      version: 'broken-reducer',
      definition: countingWorkflow(counters, { reducerThrows: true }),
    });
    const launched = await harness.launch({ workflowKey: 'counted' });
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).failureCode, 'reducer_failed');
    assert.equal(counters.callback, 1);

    // Retry #1 adopts a pin that *removed* the field the saved update names. That is an ordinary new
    // failure under the new code — never an automatic rollback, and never a reason to re-run the
    // producer.
    harness.publish({
      workflowKey: 'counted',
      version: 'dropped-field',
      definition: countingWorkflow(counters, { dropField: true }),
    });
    harness.setCurrent('counted', 'dropped-field');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    const second = await harness.runOf(launched.id);
    assert.equal(second.status, 'failed');
    assert.equal(second.failureCode, 'unknown_state_field');
    assert.equal(counters.callback, 1, 'still one callback invocation');

    // Retry #2 corrects the pin. The operand is *still* the one the original callback produced:
    // nothing invalidates a producer output except a successful commit.
    harness.publish({
      workflowKey: 'counted',
      version: 'fixed',
      definition: countingWorkflow(counters, {}),
    });
    harness.setCurrent('counted', 'fixed');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.equal(counters.callback, 1, 'the callback never ran a second time across three pins');

    const adoptions = await run(harness.fixture.runs.listVersionAdoptions(launched.id));
    assert.deepEqual(
      adoptions.map((adoption) => adoption.reason),
      ['launch', 'retry', 'retry'],
    );
  });
});

test('a reduction failure after routing reuses the accepted decision rather than re-choosing', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    // The router's update is what fails to reduce, so the decision is recorded and the reduction
    // after it is not.
    const brokenRouterReducer = (options: { readonly chooseTo: string }) => {
      const graph = createGraph<
        { readonly rounds: number; readonly notes: readonly string[] },
        { readonly notes: string },
        Record<string, unknown>
      >({
        key: 'counted',
        title: 'Counted',
        init: () => ({ rounds: 0, notes: [] }),
        state: {
          rounds: reduce.add(),
          notes:
            options.chooseTo === 'finished'
              ? field<readonly string[], string>({
                  reduce: () => {
                    throw new Error('broken');
                  },
                })
              : reduce.append<string>(),
        },
        entry: 'work',
        nodes: {
          work: operation(async () => {
            counters.callback += 1;
            return complete();
          }),
        },
        edges: {
          'work-out': edge({
            from: 'work',
            to: ['finished', 'other'],
            choose: () => {
              counters.choose += 1;
              return { to: options.chooseTo, update: { notes: 'routed' } };
            },
          }),
        },
        outcomes: {
          finished: outcome({ kind: 'success', output: () => ({ which: 'finished' }) }),
          other: outcome({ kind: 'success', output: () => ({ which: 'other' }) }),
        },
      });
      return defineWorkflow({
        command: () => ({ title: 'Counted' }),
        validate: () => {},
        graph,
      }) as AnyWorkflowDefinition;
    };

    harness.publish({
      workflowKey: 'counted',
      version: 'broken',
      definition: brokenRouterReducer({ chooseTo: 'finished' }),
    });
    const launched = await harness.launch({ workflowKey: 'counted' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.failureCode, 'reducer_failed');
    assert.equal(counters.choose, 1);

    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(failed.activeFrameId!));
    const routing = attempts.find((attempt) => attempt.segmentKind === 'routing')!;
    assert.deepEqual(await run(harness.fixture.payloads.resolve(routing.producerOutput!)), {
      to: 'finished',
      update: { notes: 'routed' },
    });

    // The corrected version would choose a *different* destination. It must not get the chance:
    // the run already decided, and re-deciding would silently change where it went.
    harness.publish({
      workflowKey: 'counted',
      version: 'fixed-and-rerouted',
      definition: brokenRouterReducer({ chooseTo: 'other' }),
    });
    harness.setCurrent('counted', 'fixed-and-rerouted');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.equal(counters.choose, 1, 'choose never ran again');
    assert.equal(
      finished.outcomeId,
      'finished',
      'the accepted destination is reused, not re-chosen',
    );
    assert.equal(counters.callback, 1);
  });
});

test('a router that threw does re-run choose, because it never produced a decision', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'counted',
      version: 'broken-router',
      definition: countingWorkflow(counters, { chooseThrows: true }),
    });
    const launched = await harness.launch({ workflowKey: 'counted' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.failureCode, 'edge_choose_failed');
    assert.equal(counters.choose, 1);

    harness.publish({
      workflowKey: 'counted',
      version: 'fixed',
      definition: countingWorkflow(counters, {}),
    });
    harness.setCurrent('counted', 'fixed');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    assert.equal((await harness.runOf(launched.id)).status, 'done');
    assert.equal(counters.choose, 2, 'a producer that failed is re-run; one that succeeded is not');
    assert.equal(counters.callback, 1, 'and the callback upstream of it is still untouched');
  });
});

test('a crash between an accepted decision and its reduction resumes with no failure code at all', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'counted',
      version: '1',
      definition: countingWorkflow(counters, {}),
    });
    const launched = await harness.launch({ workflowKey: 'counted' });

    // Crash the routing commit. The decision was already captured, the commit rolls back, and the
    // attempt is left running — exactly the durable state a killed process leaves.
    harness.crashNext('commitRouting');
    await harness.drain();

    const crashed = await harness.runOf(launched.id);
    assert.equal(crashed.position.kind, 'routing');
    assert.equal(crashed.failureCode, null, 'a crash produces no failure code to key recovery off');
    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(crashed.activeFrameId!));
    const routing = attempts.find((attempt) => attempt.segmentKind === 'routing')!;
    assert.equal(routing.status, 'running');
    assert.ok(routing.producerOutput, 'but the decision it accepted is durable');

    // A restart parks the run and closes the interrupted attempt with an unknown end, then Resume
    // re-enters the segment and reuses the decision.
    await harness.restart();
    const parked = await harness.runOf(launched.id);
    assert.equal(parked.paused, true);
    assert.equal(parked.activeAttemptId, null);
    const closed = (await run(harness.fixture.runs.findAttempt(routing.id)))!;
    assert.equal(closed.status, 'interrupted');
    assert.equal(closed.endCertainty, 'unknown');

    assert.equal((await run(harness.controls.resume(launched.id))).accepted, true);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.equal(counters.choose, 1, 'the router never ran twice');
    assert.equal(counters.callback, 1);
  });
});

test('a graph output keeps the pin that produced it, even when a later pin commits it', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    const pinA = harness.publish({
      workflowKey: 'counted',
      version: 'A',
      definition: countingWorkflow(counters, {}),
    });
    const launched = await harness.launch({ workflowKey: 'counted' });

    // Pin A evaluates the output; the publication then fails.
    harness.crashNext('completeRun');
    await harness.drain();
    const crashed = await harness.runOf(launched.id);
    assert.equal(crashed.position.kind, 'graph_output');
    assert.equal(counters.output, 1);

    await harness.restart();
    const pinB = harness.publish({
      workflowKey: 'counted',
      version: 'B',
      definition: countingWorkflow(counters, {}),
    });
    harness.setCurrent('counted', 'B');
    assert.notEqual(pinA, pinB);
    // Retry requires a failed or blocked run; an interrupted one is resumed instead.
    assert.equal((await run(harness.controls.resume(launched.id))).accepted, true);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.equal(
      counters.output,
      1,
      'the evaluator that already produced a value did not run again',
    );

    const frame = (await run(harness.fixture.runs.findFrame(crashed.activeFrameId!)))!;
    assert.equal(
      frame.outputArtifactHash,
      pinA,
      'the committed completion fact names the version that actually produced the value',
    );
    const attempts = (await run(harness.fixture.runs.listAttemptsForFrame(frame.id))).filter(
      (attempt) => attempt.segmentKind === 'graph_output',
    );
    assert.deepEqual(
      attempts.map((attempt) => [attempt.artifactHash, attempt.producerArtifactHash]),
      [
        [pinA, pinA],
        [pinA, pinA],
      ],
      'the retrying attempt records its own pin and the producing pin separately',
    );
  });
});

test('a throwing output evaluator is repaired by an edited-code Retry, which proves the current pin is used', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'counted',
      version: 'broken-output',
      definition: countingWorkflow(counters, { outputThrows: true }),
    });
    const launched = await harness.launch({ workflowKey: 'counted' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'output_evaluation_failed');
    assert.equal(
      failed.position.kind,
      'graph_output',
      'a root output that throws is a saved, retryable position — not an unrecoverable routing failure',
    );

    harness.publish({
      workflowKey: 'counted',
      version: 'fixed',
      definition: countingWorkflow(counters, {}),
    });
    harness.setCurrent('counted', 'fixed');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    assert.equal((await harness.runOf(launched.id)).status, 'done');
    assert.equal(counters.callback, 1, 'the frame’s nodes were not re-run to fix its output');
  });
});

test('a structural rejection leaves the run byte-identical', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'counted',
      version: 'broken-output',
      definition: countingWorkflow(counters, { outputThrows: true }),
    });
    const launched = await harness.launch({ workflowKey: 'counted' });
    await harness.drain();
    const before = await harness.runOf(launched.id);
    const attemptsBefore = await run(
      harness.fixture.runs.listAttemptsForFrame(before.activeFrameId!),
    );
    const adoptionsBefore = await run(harness.fixture.runs.listVersionAdoptions(launched.id));

    // The candidate version no longer declares the outcome the run is parked on.
    const withoutOutcome = createGraph<{ readonly rounds: number }, {}, Record<string, unknown>>({
      key: 'counted',
      title: 'Counted',
      init: () => ({ rounds: 0 }),
      state: { rounds: reduce.add() },
      entry: 'work',
      nodes: { work: operation(async () => complete()) },
      edges: {
        'work-out': edge({ from: 'work', to: ['other'], choose: () => ({ to: 'other' }) }),
      },
      outcomes: { other: outcome({ kind: 'success', output: () => ({}) }) },
    });
    harness.publish({
      workflowKey: 'counted',
      version: 'no-outcome',
      definition: defineWorkflow({
        command: () => ({ title: 'Counted' }),
        validate: () => {},
        graph: withoutOutcome,
      }) as AnyWorkflowDefinition,
    });
    harness.setCurrent('counted', 'no-outcome');

    const rejected = await Effect.runPromiseExit(harness.controls.retry(launched.id));
    assert.equal(rejected._tag, 'Failure');

    const after = await harness.runOf(launched.id);
    assert.deepEqual(after, before, 'pin, position, status and revisions are all unchanged');
    assert.deepEqual(
      await run(harness.fixture.runs.listAttemptsForFrame(after.activeFrameId!)),
      attemptsBefore,
    );
    assert.deepEqual(
      await run(harness.fixture.runs.listVersionAdoptions(launched.id)),
      adoptionsBefore,
    );
  });
});

/**
 * A node that launches a real effect and then suspends on it, with the reducer for its update
 * switchable between versions.
 *
 * The suspend is what makes this different from the `complete` case above: re-reducing the saved
 * result has to commit the *wait declaration* too, and neither the discriminant nor the wait can be
 * reconstructed from an update. That is the whole reason the operand is the complete result.
 */
function suspendingWorkflow(
  counters: Counters,
  options: { readonly reducerThrows?: boolean } = {},
): AnyWorkflowDefinition {
  const graph = createGraph<
    { readonly launches: number; readonly verdict: string | null },
    { readonly launches: number },
    Record<string, unknown>
  >({
    key: 'suspending',
    title: 'Suspending',
    init: () => ({ launches: 0, verdict: null }),
    state: {
      launches: options.reducerThrows
        ? field<number, number>({
            reduce: () => {
              throw new Error('the reducer for launches is broken in this version');
            },
          })
        : reduce.add(),
      verdict: reduce.replace<string | null>(),
    },
    entry: 'judge',
    nodes: {
      judge: operation(async (ctx) => {
        counters.callback += 1;
        const handle = await ctx.runHeadlessAgent({ harness: 'claude', prompt: 'judge it' });
        return suspend({ update: { launches: 1 }, wait: wait.headlessAgent(handle) });
      }),
    },
    edges: {
      'judge-out': edge({
        from: 'judge',
        to: ['finished'],
        choose: () => {
          counters.choose += 1;
          return { to: 'finished' };
        },
      }),
    },
    outcomes: {
      finished: outcome({
        kind: 'success',
        output: (state) => {
          counters.output += 1;
          return { launches: state.launches };
        },
      }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Suspending' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

test('a reduction failure after a suspend reuses the saved result, wait declaration and all', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'suspending',
      version: 'broken-reducer',
      definition: suspendingWorkflow(counters, { reducerThrows: true }),
    });
    const launched = await harness.launch({ workflowKey: 'suspending' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.failureCode, 'reducer_failed');
    assert.equal(counters.callback, 1);
    assert.equal(harness.adapters.counters.starts, 1, 'the effect really crossed a boundary');
    const operations = await run(harness.fixture.operations.listForRun(launched.id));
    assert.equal(operations.length, 1);
    assert.equal(
      (await run(harness.fixture.runs.listArmedWaits(launched.id))).length,
      0,
      'the suspend never committed, so no wait was armed',
    );

    // The saved operand is the *whole* result: the discriminant, the update and the wait.
    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(failed.activeFrameId!));
    const callbackAttempt = attempts.find((attempt) => attempt.segmentKind === 'node_callback')!;
    const saved = (await run(
      harness.fixture.payloads.resolve(callbackAttempt.producerOutput!),
    )) as {
      readonly type: string;
      readonly wait: {
        readonly kind: string;
        readonly operations: readonly { operationId: string }[];
      };
    };
    assert.equal(saved.type, 'suspend');
    assert.deepEqual(saved.wait.operations, [{ operationId: operations[0]!.operationKey }]);

    harness.publish({
      workflowKey: 'suspending',
      version: 'fixed',
      definition: suspendingWorkflow(counters, {}),
    });
    harness.setCurrent('suspending', 'fixed');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    const waiting = await harness.runOf(launched.id);
    assert.equal(waiting.status, 'waiting', 'the repaired reduction committed the same suspend');
    assert.equal(counters.callback, 1, 'the callback did not run again');
    assert.equal(harness.adapters.counters.starts, 1, 'and its effect was not dispatched again');
    assert.deepEqual(
      (await run(harness.fixture.operations.listForRun(launched.id))).map((record) => record.id),
      operations.map((record) => record.id),
      'the same operation, not a new one',
    );

    // The wait that was finally armed is the one the original callback declared, so the receipt it
    // is waiting on is the effect that actually happened.
    const armed = (await run(harness.fixture.runs.listArmedWaits(launched.id)))[0]!;
    assert.equal(armed.waitKind, 'headless_agent');
    const condition = (await run(harness.fixture.payloads.resolve(armed.condition!))) as {
      readonly operations: readonly { operationId: string }[];
    };
    assert.deepEqual(condition.operations, [{ operationId: operations[0]!.operationKey }]);

    // And it resolves normally from here.
    await harness.settleOperation({
      operationId: operations[0]!.id,
      state: 'completed',
      result: { operationId: operations[0]!.operationKey, status: 'completed' },
    });
    assert.equal(await harness.deliver(launched.id), 1);
    await harness.drain();
    assert.equal((await harness.runOf(launched.id)).status, 'done');
    assert.equal(counters.callback, 1);
  });
});

/**
 * A parent invoking one child, with the parent's mapping reducer and its router switchable.
 *
 * The child's own work is counted too, because the property under test is that a repaired *parent*
 * never reaches back into a completed child.
 */
function mappingWorkflow(
  counters: Counters,
  options: {
    readonly mappingReducerThrows?: boolean;
    readonly routerThrows?: boolean;
  } = {},
): AnyWorkflowDefinition {
  const child = createGraph<
    { readonly verdict: string },
    {},
    { readonly topic: string },
    { readonly verdict: string }
  >({
    key: 'child',
    title: 'Child',
    init: (_destination, parameters) => ({ verdict: `${parameters.topic}-verdict` }),
    state: { verdict: reduce.replace<string>() },
    entry: 'decide',
    nodes: {
      decide: operation(async () => {
        counters.callback += 1;
        return complete();
      }),
    },
    edges: {
      'decide-out': edge({ from: 'decide', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: {
      done: outcome({
        kind: 'success',
        output: (state) => {
          counters.output += 1;
          return { verdict: state.verdict };
        },
      }),
    },
  });

  const parent = createGraph<
    { readonly mappings: number; readonly verdict: string | null },
    { readonly mappings: number },
    Record<string, unknown>
  >({
    key: 'parent',
    title: 'Parent',
    init: () => ({ mappings: 0, verdict: null }),
    state: {
      mappings: options.mappingReducerThrows
        ? field<number, number>({
            reduce: () => {
              throw new Error('the reducer for mappings is broken in this version');
            },
          })
        : reduce.add(),
      verdict: reduce.replace<string | null>(),
    },
    entry: 'review',
    nodes: {
      review: subgraph({
        graph: child,
        parameters: () => ({ topic: 'draft' }),
        onResult: (_parent, result) => {
          counters.mapping += 1;
          return { mappings: 1, verdict: (result.output as { verdict: string }).verdict };
        },
      }),
    },
    edges: {
      'review-out': edge({
        from: 'review',
        to: ['finished'],
        choose: () => {
          counters.choose += 1;
          if (options.routerThrows) throw new Error('the router is broken in this version');
          return { to: 'finished' };
        },
      }),
    },
    outcomes: {
      finished: outcome({
        kind: 'success',
        output: (state) => ({ mappings: state.mappings, verdict: state.verdict }),
      }),
    },
  });

  return defineWorkflow({
    command: () => ({ title: 'Parent' }),
    validate: () => {},
    graph: parent,
  }) as AnyWorkflowDefinition;
}

test('a mapping reduction failure reuses the saved update and never reaches back into the child', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'parent',
      version: 'broken-mapping-reducer',
      definition: mappingWorkflow(counters, { mappingReducerThrows: true }),
    });
    const launched = await harness.launch({ workflowKey: 'parent' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.failureCode, 'reducer_failed');
    assert.equal(failed.position.kind, 'child_output_mapping');
    assert.equal(counters.mapping, 1, 'onResult ran once');
    assert.equal(counters.callback, 1, "and the child's own callback ran once");

    const frames = await run(harness.fixture.runs.listFrames(launched.id));
    const childFrame = frames.find((frame) => frame.depth === 1)!;
    const childBefore = {
      status: childFrame.status,
      outcomeId: childFrame.outcomeId,
      output: await run(harness.fixture.payloads.resolve(childFrame.output!)),
      pin: childFrame.outputArtifactHash,
      completedAt: childFrame.completedAt,
    };

    const parentFrame = frames.find((frame) => frame.depth === 0)!;
    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(parentFrame.id));
    const mappingAttempt = attempts.find((attempt) => attempt.segmentKind === 'output_mapping')!;
    assert.deepEqual(await run(harness.fixture.payloads.resolve(mappingAttempt.producerOutput!)), {
      update: { mappings: 1, verdict: 'draft-verdict' },
    });

    harness.publish({
      workflowKey: 'parent',
      version: 'fixed',
      definition: mappingWorkflow(counters, {}),
    });
    harness.setCurrent('parent', 'fixed');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    assert.equal((await harness.runOf(launched.id)).status, 'done');
    assert.equal(counters.mapping, 1, 'onResult was not called again');
    assert.equal(counters.callback, 1, "the child's callback was not called again");
    assert.equal(counters.output, 1, "and the child's output was not evaluated again");

    // The completed child is untouched: its outcome, its output and the pin that produced them.
    const childAfter = (await run(harness.fixture.runs.findFrame(childFrame.id)))!;
    assert.deepEqual(
      {
        status: childAfter.status,
        outcomeId: childAfter.outcomeId,
        output: await run(harness.fixture.payloads.resolve(childAfter.output!)),
        pin: childAfter.outputArtifactHash,
        completedAt: childAfter.completedAt,
      },
      childBefore,
    );
  });
});

test('a routing failure after a successful mapping does not apply the mapping twice', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'parent',
      version: 'broken-router',
      definition: mappingWorkflow(counters, { routerThrows: true }),
    });
    const launched = await harness.launch({ workflowKey: 'parent' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.failureCode, 'edge_choose_failed');
    assert.equal(
      failed.position.kind,
      'routing',
      'the mapping committed; routing is a separate position',
    );
    assert.equal(counters.mapping, 1);

    const parentFrame = (await run(harness.fixture.runs.findFrame(failed.activeFrameId!)))!;
    assert.deepEqual(await run(harness.fixture.payloads.resolve(parentFrame.state!)), {
      mappings: 1,
      verdict: 'draft-verdict',
    });

    harness.publish({
      workflowKey: 'parent',
      version: 'fixed',
      definition: mappingWorkflow(counters, {}),
    });
    harness.setCurrent('parent', 'fixed');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.equal(counters.mapping, 1, 'onResult was not called a second time');
    assert.deepEqual(
      await run(harness.fixture.payloads.resolve(finished.output!)),
      { mappings: 1, verdict: 'draft-verdict' },
      'and the mapping was reduced into the parent exactly once',
    );

    // Two segments, two attempt lineages: the mapping succeeded once and only routing was retried.
    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(parentFrame.id));
    assert.deepEqual(
      attempts
        .filter((attempt) => attempt.segmentKind === 'output_mapping')
        .map((attempt) => [attempt.attemptIndex, attempt.status]),
      [[1, 'succeeded']],
    );
    assert.deepEqual(
      attempts
        .filter((attempt) => attempt.segmentKind === 'routing')
        .map((attempt) => [attempt.attemptIndex, attempt.status]),
      [
        [1, 'failed'],
        [2, 'succeeded'],
      ],
    );
  });
});
