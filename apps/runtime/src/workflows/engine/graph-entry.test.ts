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
} from '@yourtechbudstudio/isagi-workflow-sdk';

import { run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { makeEngineHarness, type EngineHarness } from './test-support.js';

/**
 * Entering a graph, and what a failure there costs.
 *
 * `init` runs as the root frame's *first segment*, not during launch. That is what makes a failed
 * initialization a retained, inspectable, retryable thing rather than a launch that vanished — and
 * it is what "recovery does not repeat graph initialization" is a statement about, because once the
 * entry commits it is a durable fact rather than something recomputed.
 *
 * The two failure codes belong to different owners and the tests keep them apart: a root has saved
 * launch parameters and no parameter-mapping callback at all, so it can only fail at `init`; a child
 * maps its parameters from the parent first, and that mapping is a separate, separately attributed
 * failure.
 */

interface Counters {
  command: number;
  validate: number;
  init: number;
  mapping: number;
  childInit: number;
}

function makeCounters(): Counters {
  return { command: 0, validate: 0, init: 0, mapping: 0, childInit: 0 };
}

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

function rootWorkflow(
  counters: Counters,
  options: { readonly initThrows?: boolean } = {},
): AnyWorkflowDefinition {
  const graph = createGraph<
    { readonly topic: string; readonly rounds: number },
    {},
    Record<string, unknown>
  >({
    key: 'rooted',
    title: 'Rooted',
    init: (_destination, parameters) => {
      counters.init += 1;
      if (options.initThrows) throw new Error('init is broken in this version');
      return { topic: String(parameters.topic ?? 'none'), rounds: 0 };
    },
    state: { topic: reduce.replace<string>(), rounds: reduce.add() },
    entry: 'work',
    nodes: { work: operation(async () => complete({ update: { rounds: 1 } })) },
    edges: {
      'work-out': edge({ from: 'work', to: ['finished'], choose: () => ({ to: 'finished' }) }),
    },
    outcomes: {
      finished: outcome({ kind: 'success', output: (state) => ({ topic: state.topic }) }),
    },
  });
  return defineWorkflow({
    command: () => {
      counters.command += 1;
      return { title: 'Rooted' };
    },
    validate: () => {
      counters.validate += 1;
    },
    graph,
  }) as AnyWorkflowDefinition;
}

test('a root init failure is a retained, retryable segment — not a launch that vanished', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'rooted',
      version: 'broken-init',
      definition: rootWorkflow(counters, { initThrows: true }),
    });
    const launched = await harness.launch({
      workflowKey: 'rooted',
      inputs: { topic: 'initialization' },
    });
    assert.deepEqual(
      [counters.command, counters.validate, counters.init],
      [1, 1, 0],
      'launch ran the command manifest and validation, and nothing else',
    );

    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'graph_init_failed');
    assert.equal(counters.init, 1);

    // The run, its frame and the failed attempt are all still there to look at.
    const frame = (await run(harness.fixture.runs.findFrame(launched.activeFrameId!)))!;
    assert.deepEqual(failed.position, { kind: 'graph_entry', frameId: frame.id });
    assert.equal(frame.status, 'initializing', 'entry did not commit');
    assert.equal(frame.state, null, 'so no state boundary exists');
    assert.equal(
      (await run(harness.fixture.runs.listExecutions(frame.id))).length,
      0,
      'and no entry execution was created',
    );
    assert.deepEqual(
      await run(harness.fixture.payloads.resolve(frame.parameters!)),
      { topic: 'initialization' },
      'the launch parameters are stored and untouched',
    );

    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(frame.id));
    assert.deepEqual(
      attempts.map((attempt) => [attempt.segmentKind, attempt.attemptIndex, attempt.status]),
      [['graph_entry', 1, 'failed']],
    );
    assert.equal(
      attempts[0]!.producerOutput,
      null,
      'graph entry captures no operand: both its callbacks are pure and commit atomically with it',
    );

    // Repaired code, adopted through Retry. The launch hooks are launch's, not the segment's.
    harness.publish({
      workflowKey: 'rooted',
      version: 'fixed',
      definition: rootWorkflow(counters, {}),
    });
    harness.setCurrent('rooted', 'fixed');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.equal(
      counters.init,
      2,
      'an uncommitted init is re-evaluated, because nothing committed',
    );
    assert.deepEqual(
      [counters.command, counters.validate],
      [1, 1],
      'and neither launch hook ran again',
    );
    assert.deepEqual(await run(harness.fixture.payloads.resolve(finished.output!)), {
      topic: 'initialization',
    });
  });
});

test('a committed init never runs again, whatever later fails', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    // The callback after entry fails, so the run has a committed entry and a later failure.
    const brokenAfterEntry = (fail: boolean): AnyWorkflowDefinition => {
      const graph = createGraph<{ readonly rounds: number }, {}, Record<string, unknown>>({
        key: 'rooted',
        title: 'Rooted',
        init: () => {
          counters.init += 1;
          return { rounds: 0 };
        },
        state: { rounds: reduce.add() },
        entry: 'work',
        nodes: {
          work: operation(async () => {
            if (fail) throw new Error('the callback is broken in this version');
            return complete({ update: { rounds: 1 } });
          }),
        },
        edges: {
          'work-out': edge({ from: 'work', to: ['finished'], choose: () => ({ to: 'finished' }) }),
        },
        outcomes: { finished: outcome({ kind: 'success', output: () => ({}) }) },
      });
      return defineWorkflow({
        command: () => ({ title: 'Rooted' }),
        validate: () => {},
        graph,
      }) as AnyWorkflowDefinition;
    };

    harness.publish({
      workflowKey: 'rooted',
      version: 'broken-callback',
      definition: brokenAfterEntry(true),
    });
    const launched = await harness.launch({ workflowKey: 'rooted' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.failureCode, 'node_callback_failed');
    assert.equal(counters.init, 1);
    const frame = (await run(harness.fixture.runs.findFrame(failed.activeFrameId!)))!;
    assert.equal(frame.status, 'active');
    const committedState = await run(harness.fixture.payloads.resolve(frame.state!));

    // A restart parks it, and Resume re-enters only the uncommitted segment.
    await harness.restart();
    assert.equal(counters.init, 1, 'startup recovery re-executes nothing');

    // Then an edited-code Retry, which is the other way back in.
    harness.publish({
      workflowKey: 'rooted',
      version: 'fixed',
      definition: brokenAfterEntry(false),
    });
    harness.setCurrent('rooted', 'fixed');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    assert.equal((await harness.runOf(launched.id)).status, 'done');
    assert.equal(counters.init, 1, 'a committed entry is a fact, never recomputed');
    assert.deepEqual(
      (await run(harness.fixture.runs.listAttemptsForFrame(frame.id)))
        .filter((attempt) => attempt.segmentKind === 'graph_entry')
        .map((attempt) => attempt.status),
      ['succeeded'],
      'and it kept the one attempt that committed it',
    );
    assert.notEqual(committedState, null);
  });
});

/** A parent whose child mapping and child init can each be broken independently. */
function nestedWorkflow(
  counters: Counters,
  options: { readonly mappingThrows?: boolean; readonly childInitThrows?: boolean } = {},
): AnyWorkflowDefinition {
  const child = createGraph<
    { readonly topic: string; readonly notes: readonly string[] },
    {},
    { readonly topic: string },
    { readonly topic: string }
  >({
    key: 'child',
    title: 'Child',
    init: (_destination, parameters) => {
      counters.childInit += 1;
      if (options.childInitThrows) throw new Error('child init is broken in this version');
      return { topic: parameters.topic, notes: [] };
    },
    state: { topic: reduce.replace<string>(), notes: reduce.replace<readonly string[]>() },
    entry: 'decide',
    nodes: { decide: operation(async () => complete()) },
    edges: {
      'decide-out': edge({ from: 'decide', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: {
      done: outcome({ kind: 'success', output: (state) => ({ topic: state.topic }) }),
    },
  });

  const parent = createGraph<
    { readonly seen: readonly string[] },
    { readonly seen: string },
    Record<string, unknown>
  >({
    key: 'parent',
    title: 'Parent',
    init: () => ({ seen: [] }),
    state: { seen: reduce.append<string>() },
    entry: 'review',
    nodes: {
      review: subgraph({
        graph: child,
        parameters: () => {
          counters.mapping += 1;
          if (options.mappingThrows) throw new Error('the mapping is broken in this version');
          return { topic: 'mapped' };
        },
        onResult: (_parent, result) => ({ seen: (result.output as { topic: string }).topic }),
      }),
    },
    edges: {
      'review-out': edge({ from: 'review', to: ['finished'], choose: () => ({ to: 'finished' }) }),
    },
    outcomes: {
      finished: outcome({ kind: 'success', output: (state) => ({ seen: state.seen }) }),
    },
  });

  return defineWorkflow({
    command: () => ({ title: 'Parent' }),
    validate: () => {},
    graph: parent,
  }) as AnyWorkflowDefinition;
}

test('a child parameter mapping failure is attributed to the mapping, and leaves the parent alone', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'parent',
      version: 'broken-mapping',
      definition: nestedWorkflow(counters, { mappingThrows: true }),
    });
    const launched = await harness.launch({ workflowKey: 'parent' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.status, 'failed');
    assert.equal(
      failed.failureCode,
      'parameter_mapping_failed',
      "the mapping is the child's entry segment, and is attributed as such",
    );
    assert.equal(counters.mapping, 1);
    assert.equal(counters.childInit, 0, 'init never ran, because there were no parameters');

    // The child frame exists — it was opened structurally — but it is not falsely active.
    const frames = await run(harness.fixture.runs.listFrames(launched.id));
    const childFrame = frames.find((frame) => frame.depth === 1)!;
    assert.deepEqual(failed.position, { kind: 'graph_entry', frameId: childFrame.id });
    assert.equal(childFrame.status, 'initializing');
    assert.equal(childFrame.state, null, 'no state boundary was invented for it');
    assert.equal(childFrame.parameters, null, 'and no parameters were stored');

    // The parent is untouched: its state is the one its own entry committed.
    const parentFrame = frames.find((frame) => frame.depth === 0)!;
    assert.equal(parentFrame.status, 'active');
    assert.deepEqual(await run(harness.fixture.payloads.resolve(parentFrame.state!)), { seen: [] });

    harness.publish({
      workflowKey: 'parent',
      version: 'fixed',
      definition: nestedWorkflow(counters, {}),
    });
    harness.setCurrent('parent', 'fixed');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.equal(counters.mapping, 2, 'the uncommitted mapping was re-evaluated');
    assert.equal(counters.childInit, 1);
    assert.equal(
      (await run(harness.fixture.runs.listFrames(launched.id))).length,
      2,
      'and no second child frame was opened',
    );
  });
});

test('a child init failure repeats both pure callbacks, because neither committed', async () => {
  await withHarness(async (harness) => {
    const counters = makeCounters();
    harness.publish({
      workflowKey: 'parent',
      version: 'broken-child-init',
      definition: nestedWorkflow(counters, { childInitThrows: true }),
    });
    const launched = await harness.launch({ workflowKey: 'parent' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.failureCode, 'graph_init_failed');
    assert.deepEqual(
      [counters.mapping, counters.childInit],
      [1, 1],
      'both callbacks ran inside the one attempt',
    );

    harness.publish({
      workflowKey: 'parent',
      version: 'fixed',
      definition: nestedWorkflow(counters, {}),
    });
    harness.setCurrent('parent', 'fixed');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    assert.equal((await harness.runOf(launched.id)).status, 'done');
    // Neither performed operational work, so repeating both is free — which is exactly why this is
    // the one segment that saves no producer operand.
    assert.deepEqual([counters.mapping, counters.childInit], [2, 2]);
    const childFrame = (await run(harness.fixture.runs.listFrames(launched.id))).find(
      (frame) => frame.depth === 1,
    )!;
    assert.deepEqual(await run(harness.fixture.payloads.resolve(childFrame.parameters!)), {
      topic: 'mapped',
    });
  });
});
