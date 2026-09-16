import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
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

import { inlinePayloadThresholdBytes } from '../persistence/payload-store.js';
import { run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { makeEngineHarness, type EngineHarness } from './test-support.js';

/**
 * The interpreter, end to end, against real persistence.
 *
 * Every assertion here is about a *committed* fact — a position, an attempt, an execution row — not
 * about a value that happened to flow through memory. That is the point of the segment protocol:
 * what a run will do next is answerable from the database alone, with no surviving process and no
 * replay of history.
 */

interface LinearState {
  readonly rounds: number;
  readonly notes: readonly string[];
}

/** Two visits to one node, so a loop edge and a repeated reducer are both observable. */
function loopingWorkflow(): AnyWorkflowDefinition {
  const graph = createGraph<LinearState, { readonly notes: string }, Record<string, unknown>>({
    key: 'looping',
    title: 'Looping',
    init: () => ({ rounds: 0, notes: [] }),
    state: { rounds: reduce.add(), notes: reduce.append<string>() },
    entry: 'advance',
    nodes: {
      advance: operation(async (_ctx, state) =>
        complete({ update: { rounds: 1, notes: `round-${state.rounds}` } }),
      ),
    },
    edges: {
      'advance-out': edge({
        from: 'advance',
        to: ['advance', 'finished'],
        choose: (state) => ({ to: state.rounds >= 2 ? 'finished' : 'advance' }),
      }),
    },
    outcomes: {
      finished: outcome({ kind: 'success', output: (state) => ({ notes: state.notes }) }),
    },
  });
  return defineWorkflow({
    command: () => ({ title: 'Looping' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}

/** A root invoking a reusable child graph twice, which is what makes frames distinct from nodes. */
function nestedWorkflow(): AnyWorkflowDefinition {
  const child = createGraph<
    { readonly topic: string; readonly verdict: string | null },
    {},
    { readonly topic: string },
    { readonly verdict: string }
  >({
    key: 'child',
    title: 'Child',
    init: (_destination, parameters) => ({ topic: parameters.topic, verdict: null }),
    state: {
      topic: reduce.replace<string>(),
      verdict: reduce.replace<string | null>(),
    },
    entry: 'judge',
    nodes: {
      judge: operation(async (_ctx, state) =>
        complete({ update: { verdict: `${state.topic}-ok` } }),
      ),
    },
    edges: {
      'judge-out': edge({ from: 'judge', to: ['approved'], choose: () => ({ to: 'approved' }) }),
    },
    outcomes: {
      approved: outcome({
        kind: 'success',
        output: (state) => ({ verdict: state.verdict ?? 'unknown' }),
      }),
    },
  });

  const root = createGraph<
    { readonly verdicts: readonly string[]; readonly passes: number },
    { readonly verdicts: string },
    Record<string, unknown>
  >({
    key: 'root',
    title: 'Root',
    init: () => ({ verdicts: [], passes: 0 }),
    state: { verdicts: reduce.append<string>(), passes: reduce.add() },
    entry: 'review',
    nodes: {
      review: subgraph({
        graph: child,
        parameters: (parent) => ({ topic: `pass-${parent.passes}` }),
        onResult: (_parent, result) => ({
          verdicts: (result.output as { verdict: string }).verdict,
          passes: 1,
        }),
      }),
    },
    edges: {
      'review-out': edge({
        from: 'review',
        to: ['review', 'delivered'],
        choose: (state) => ({ to: state.passes >= 2 ? 'delivered' : 'review' }),
      }),
    },
    outcomes: {
      delivered: outcome({ kind: 'success', output: (state) => ({ verdicts: state.verdicts }) }),
    },
  });

  return defineWorkflow({
    command: () => ({ title: 'Nested' }),
    validate: () => {},
    graph: root,
  }) as AnyWorkflowDefinition;
}

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

test('a run advances one segment at a time, from launch to a committed outcome', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'looping', version: '1', definition: loopingWorkflow() });
    const launched = await harness.launch({ workflowKey: 'looping' });

    // Launch creates the run and its uninitialized root frame, and nothing else. `init` has not run:
    // it is the first segment, which is what makes a failed initialization retryable rather than a
    // launch that vanished.
    assert.equal(launched.status, 'ready');
    assert.deepEqual(launched.position, { kind: 'graph_entry', frameId: launched.activeFrameId! });
    const rootFrame = (await run(harness.fixture.runs.findFrame(launched.activeFrameId!)))!;
    assert.equal(rootFrame.status, 'initializing');
    assert.equal(rootFrame.state, null);

    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.deepEqual(finished.position, { kind: 'terminal' });
    assert.equal(finished.outcomeId, 'finished');
    assert.equal(finished.outcomeKind, 'success');

    // Two visits to one node are two executions, never one reopened row — which is what keeps a
    // definition node and an iteration of it distinct in every later read.
    const executions = await run(harness.fixture.runs.listExecutions(rootFrame.id));
    assert.deepEqual(
      executions.map((execution) => [execution.nodeId, execution.visitIndex, execution.status]),
      [
        ['advance', 0, 'completed'],
        ['advance', 1, 'completed'],
      ],
    );

    // One attempt per segment, each committed exactly once.
    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(rootFrame.id));
    assert.deepEqual(
      attempts.map((attempt) => [attempt.segmentKind, attempt.attemptIndex, attempt.status]),
      [
        ['graph_entry', 1, 'succeeded'],
        ['node_callback', 1, 'succeeded'],
        ['routing', 1, 'succeeded'],
        ['node_callback', 1, 'succeeded'],
        ['routing', 1, 'succeeded'],
        ['graph_output', 1, 'succeeded'],
      ],
    );

    const output = await run(harness.fixture.payloads.resolve(finished.output!));
    assert.deepEqual(output, { notes: ['round-0', 'round-1'] });
  });
});

test('a subgraph node opens a frame with no attempt, and its execution stays open across the child', async () => {
  await withHarness(async (harness) => {
    harness.publish({ workflowKey: 'nested', version: '1', definition: nestedWorkflow() });
    const launched = await harness.launch({ workflowKey: 'nested' });
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    assert.deepEqual(await run(harness.fixture.payloads.resolve(finished.output!)), {
      verdicts: ['pass-0-ok', 'pass-1-ok'],
    });

    const frames = await run(harness.fixture.runs.listFrames(launched.id));
    // One reusable definition, two invocations: two child frames, each one level deeper, each with
    // its own parameters.
    assert.equal(frames.length, 3);
    const children = frames.filter((frame) => frame.depth === 1);
    assert.equal(children.length, 2);
    assert.deepEqual(
      children.map((frame) => frame.graphKey),
      ['child', 'child'],
    );
    for (const child of children) {
      assert.equal(child.status, 'completed');
      assert.equal(child.outcomeId, 'approved');
    }
    assert.deepEqual(
      await Promise.all(
        children.map((frame) => run(harness.fixture.payloads.resolve(frame.parameters!))),
      ),
      [{ topic: 'pass-0' }, { topic: 'pass-1' }],
    );

    const root = frames.find((frame) => frame.depth === 0)!;
    const parents = await run(harness.fixture.runs.listExecutions(root.id));
    assert.deepEqual(
      parents.map((execution) => [execution.nodeId, execution.visitIndex, execution.status]),
      [
        ['review', 0, 'completed'],
        ['review', 1, 'completed'],
      ],
    );

    // Opening a child runs no author code, so it allocated no attempt: the parent frame's attempts
    // are its entry, the two output mappings, the two routings and its own output — never a
    // `node_callback` for the subgraph node.
    const rootAttempts = await run(harness.fixture.runs.listAttemptsForFrame(root.id));
    assert.deepEqual(
      rootAttempts.map((attempt) => attempt.segmentKind),
      ['graph_entry', 'output_mapping', 'routing', 'output_mapping', 'routing', 'graph_output'],
    );
    assert.equal(
      rootAttempts.filter((attempt) => attempt.segmentKind === 'node_callback').length,
      0,
      'a structural subgraph entry never allocates an author-callback attempt',
    );
    assert.equal(
      (await harness.runOf(launched.id)).activeAttemptId,
      null,
      'and it leaves no orphan active attempt behind',
    );
  });
});

test('an immediate completion routes without an artificial wait, and a suspend arms one', async () => {
  await withHarness(async (harness) => {
    const graph = createGraph<{ readonly gated: boolean }, {}, Record<string, unknown>>({
      key: 'gate',
      title: 'Gate',
      init: () => ({ gated: false }),
      state: { gated: reduce.replace<boolean>() },
      entry: 'ask',
      nodes: {
        ask: operation(async () => suspend({ wait: wait.userContinue('Ready?') })),
      },
      edges: {
        'ask-out': edge({ from: 'ask', to: ['done'], choose: () => ({ to: 'done' }) }),
      },
      outcomes: { done: outcome({ kind: 'success', output: (state) => state }) },
    });
    harness.publish({
      workflowKey: 'gate',
      version: '1',
      definition: defineWorkflow({
        command: () => ({ title: 'Gate' }),
        validate: () => {},
        graph,
      }) as AnyWorkflowDefinition,
    });
    const launched = await harness.launch({ workflowKey: 'gate' });
    await harness.drain();

    const waiting = await harness.runOf(launched.id);
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.position.kind, 'awaiting_wait');
    const waits = await run(harness.fixture.runs.listArmedWaits(launched.id));
    assert.equal(waits.length, 1);
    assert.equal(waits[0]!.waitKind, 'user_continue');

    // A human gate is never satisfied by reconciliation. Somebody has to answer it.
    assert.equal(await run(harness.waits.reconcileWaits(launched.id)), 0);
    assert.equal((await harness.runOf(launched.id)).status, 'waiting');
  });
});

test('an undeclared destination is rejected before any state is committed', async () => {
  await withHarness(async (harness) => {
    const graph = createGraph<{ readonly seen: number }, {}, Record<string, unknown>>({
      key: 'stray',
      title: 'Stray',
      init: () => ({ seen: 0 }),
      state: { seen: reduce.replace<number>() },
      entry: 'node',
      nodes: { node: operation(async () => complete({ update: { seen: 1 } })) },
      edges: {
        'node-out': edge({
          from: 'node',
          to: ['finished'],
          // Chooses somewhere it never declared, which is the case the runtime has to refuse.
          choose: () => ({ to: 'elsewhere', update: { seen: 99 } }),
        }),
      },
      outcomes: {
        finished: outcome({ kind: 'success', output: () => ({}) }),
        elsewhere: outcome({ kind: 'success', output: () => ({}) }),
      },
    });
    harness.publish({
      workflowKey: 'stray',
      version: '1',
      definition: defineWorkflow({
        command: () => ({ title: 'Stray' }),
        validate: () => {},
        graph,
      }) as AnyWorkflowDefinition,
    });
    const launched = await harness.launch({ workflowKey: 'stray' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'undeclared_destination');
    assert.equal(failed.position.kind, 'routing', 'the run stays parked where it can be retried');

    const frame = (await run(harness.fixture.runs.findFrame(failed.activeFrameId!)))!;
    const state = await run(harness.fixture.payloads.resolve(frame.state!));
    assert.deepEqual(
      state,
      { seen: 1 },
      'the rejected decision reduced nothing: the boundary is the callback’s, untouched',
    );

    const attempts = await run(harness.fixture.runs.listAttemptsForFrame(frame.id));
    const routing = attempts.find((attempt) => attempt.segmentKind === 'routing')!;
    assert.equal(routing.status, 'failed');
    assert.equal(
      routing.producerOutput,
      null,
      'no decision was accepted, so none was saved for a later attempt to reuse',
    );
  });
});

test('a payload the interpreter needs but cannot read parks the run instead of inventing empty state', async () => {
  await withHarness(async (harness) => {
    // Large enough to be stored as a reference rather than inline, which is what gives the test a
    // file to take away.
    const bulky = 'x'.repeat(inlinePayloadThresholdBytes + 1024);
    const graph = createGraph<{ readonly blob: string }, {}, Record<string, unknown>>({
      key: 'bulky',
      title: 'Bulky',
      init: () => ({ blob: bulky }),
      state: { blob: reduce.replace<string>() },
      entry: 'work',
      nodes: { work: operation(async () => complete()) },
      edges: {
        'work-out': edge({ from: 'work', to: ['finished'], choose: () => ({ to: 'finished' }) }),
      },
      outcomes: { finished: outcome({ kind: 'success', output: () => ({}) }) },
    });
    harness.publish({
      workflowKey: 'bulky',
      version: '1',
      definition: defineWorkflow({
        command: () => ({ title: 'Bulky' }),
        validate: () => {},
        graph,
      }) as AnyWorkflowDefinition,
    });
    const launched = await harness.launch({ workflowKey: 'bulky' });

    // Advance exactly one segment, so the state boundary is committed as a reference and the run is
    // parked at the callback that will need to read it.
    await run(harness.dispatcher.advanceRun(launched.id));
    const parked = await harness.runOf(launched.id);
    assert.equal(parked.position.kind, 'node_callback');
    const frame = (await run(harness.fixture.runs.findFrame(parked.activeFrameId!)))!;
    assert.ok(frame.state?.ref, 'the state boundary is a reference');

    rmSync(harness.fixture.payloads.pathOf(frame.state!.ref!));

    await harness.drain();
    const failed = await harness.runOf(launched.id);
    assert.equal(failed.status, 'failed');
    assert.equal(
      failed.failureCode,
      'payload_unavailable',
      'the run says what it could not read rather than continuing against empty state',
    );
    assert.equal(failed.position.kind, 'node_callback', 'and stays where it can be repaired');
  });
});

/**
 * A parent and a reusable child that both declare a field called `notes`.
 *
 * The shared name is the point: if state were not private per frame, the two would collide, and a
 * test using distinct names could not tell the difference.
 */
function privateStateWorkflow(counters: { childSaw: unknown[] }): AnyWorkflowDefinition {
  const child = createGraph<
    { readonly notes: readonly string[]; readonly label: string },
    { readonly notes: string },
    { readonly label: string },
    { readonly notes: readonly string[] }
  >({
    key: 'child',
    title: 'Child',
    init: (_destination, parameters) => ({ notes: [], label: parameters.label }),
    state: { notes: reduce.append<string>(), label: reduce.replace<string>() },
    entry: 'note',
    nodes: {
      note: operation(async (_ctx, state) => {
        // Everything the child can see is its own frame's boundary, handed over isolated.
        counters.childSaw.push(structuredClone(state));
        return complete({ update: { notes: `${state.label}-note` } });
      }),
    },
    edges: {
      'note-out': edge({ from: 'note', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: {
      done: outcome({ kind: 'success', output: (state) => ({ notes: state.notes }) }),
    },
  });

  const parent = createGraph<
    { readonly notes: readonly string[]; readonly passes: number },
    { readonly notes: string },
    Record<string, unknown>
  >({
    key: 'parent',
    title: 'Parent',
    init: () => ({ notes: ['parent-only'], passes: 0 }),
    state: { notes: reduce.append<string>(), passes: reduce.add() },
    entry: 'review',
    nodes: {
      review: subgraph({
        graph: child,
        parameters: (state) => ({ label: `pass-${state.passes}` }),
        // Only the child's declared output crosses back, and only through this mapping.
        onResult: (_state, result) => ({
          notes: (result.output as { notes: readonly string[] }).notes.join(','),
          passes: 1,
        }),
      }),
    },
    edges: {
      'review-out': edge({
        from: 'review',
        to: ['review', 'finished'],
        choose: (state) => ({ to: state.passes >= 2 ? 'finished' : 'review' }),
      }),
    },
    outcomes: {
      finished: outcome({ kind: 'success', output: (state) => ({ notes: state.notes }) }),
    },
  });

  return defineWorkflow({
    command: () => ({ title: 'Parent' }),
    validate: () => {},
    graph: parent,
  }) as AnyWorkflowDefinition;
}

test('a child frame has its own private state, and can reach the parent only through its output', async () => {
  await withHarness(async (harness) => {
    const counters = { childSaw: [] as unknown[] };
    harness.publish({
      workflowKey: 'parent',
      version: '1',
      definition: privateStateWorkflow(counters),
    });
    const launched = await harness.launch({ workflowKey: 'parent' });
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');

    // Each invocation saw only its own boundary — never the parent's `notes`, which held
    // 'parent-only' the whole time, and never the other invocation's.
    assert.deepEqual(counters.childSaw, [
      { notes: [], label: 'pass-0' },
      { notes: [], label: 'pass-1' },
    ]);

    const frames = await run(harness.fixture.runs.listFrames(launched.id));
    const children = frames.filter((frame) => frame.depth === 1);
    assert.equal(children.length, 2, 'one reusable definition, two invocations');
    const childStates = await Promise.all(
      children.map((frame) => run(harness.fixture.payloads.resolve(frame.state!))),
    );
    assert.deepEqual(childStates, [
      { notes: ['pass-0-note'], label: 'pass-0' },
      { notes: ['pass-1-note'], label: 'pass-1' },
    ]);
    assert.notDeepEqual(childStates[0], childStates[1], 'two frames, two independent boundaries');

    // The parent's own `notes` accumulated only what its mapping let through — never the child's
    // internal values by some other route, and never the other child's.
    const parentFrame = frames.find((frame) => frame.depth === 0)!;
    assert.deepEqual(await run(harness.fixture.payloads.resolve(parentFrame.state!)), {
      notes: ['parent-only', 'pass-0-note', 'pass-1-note'],
      passes: 2,
    });
  });
});

test('a child that mutates the state it was handed cannot corrupt the boundary', async () => {
  await withHarness(async (harness) => {
    const child = createGraph<
      { readonly notes: readonly string[] },
      { readonly notes: string },
      { readonly seed: string },
      { readonly notes: readonly string[] }
    >({
      key: 'child',
      title: 'Child',
      init: (_destination, parameters) => ({ notes: [parameters.seed] }),
      state: { notes: reduce.append<string>() },
      entry: 'meddle',
      nodes: {
        meddle: operation(async (_ctx, state) => {
          // The callback is handed an isolated, frozen copy, so this throws rather than reaching
          // the committed boundary.
          assert.throws(() => {
            (state.notes as string[]).push('smuggled');
          });
          return complete({ update: { notes: 'declared' } });
        }),
      },
      edges: {
        'meddle-out': edge({ from: 'meddle', to: ['done'], choose: () => ({ to: 'done' }) }),
      },
      outcomes: {
        done: outcome({ kind: 'success', output: (state) => ({ notes: state.notes }) }),
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
          parameters: () => ({ seed: 'seeded' }),
          onResult: (_state, result) => ({
            seen: (result.output as { notes: readonly string[] }).notes.join(','),
          }),
        }),
      },
      edges: {
        'review-out': edge({
          from: 'review',
          to: ['finished'],
          choose: () => ({ to: 'finished' }),
        }),
      },
      outcomes: {
        finished: outcome({ kind: 'success', output: (state) => ({ seen: state.seen }) }),
      },
    });

    harness.publish({
      workflowKey: 'parent',
      version: '1',
      definition: defineWorkflow({
        command: () => ({ title: 'Parent' }),
        validate: () => {},
        graph: parent,
      }) as AnyWorkflowDefinition,
    });
    const launched = await harness.launch({ workflowKey: 'parent' });
    await harness.drain();

    const finished = await harness.runOf(launched.id);
    assert.equal(finished.status, 'done');
    const childFrame = (await run(harness.fixture.runs.listFrames(launched.id))).find(
      (frame) => frame.depth === 1,
    )!;
    assert.deepEqual(
      await run(harness.fixture.payloads.resolve(childFrame.state!)),
      { notes: ['seeded', 'declared'] },
      'only the declared update reached the boundary',
    );
    assert.deepEqual(await run(harness.fixture.payloads.resolve(finished.output!)), {
      seen: ['seeded,declared'],
    });
  });
});

test('a restart does not let one invocation resume with another invocation’s state', async () => {
  await withHarness(async (harness) => {
    const counters = { childSaw: [] as unknown[] };
    harness.publish({
      workflowKey: 'parent',
      version: '1',
      definition: privateStateWorkflow(counters),
    });
    const launched = await harness.launch({ workflowKey: 'parent' });

    // Stop after the first invocation has published and the second is under way, then restart.
    for (let step = 0; step < 6; step += 1) {
      await run(harness.dispatcher.advanceRun(launched.id));
    }
    const midway = await harness.runOf(launched.id);
    assert.notEqual(midway.status, 'done', 'the run is genuinely still in flight');
    await harness.restart();
    assert.equal((await run(harness.controls.resume(launched.id))).accepted, true);
    await harness.drain();

    assert.equal((await harness.runOf(launched.id)).status, 'done');
    const children = (await run(harness.fixture.runs.listFrames(launched.id))).filter(
      (frame) => frame.depth === 1,
    );
    assert.deepEqual(
      await Promise.all(
        children.map((frame) => run(harness.fixture.payloads.resolve(frame.state!))),
      ),
      [
        { notes: ['pass-0-note'], label: 'pass-0' },
        { notes: ['pass-1-note'], label: 'pass-1' },
      ],
      'each frame resumed with its own boundary',
    );
    assert.deepEqual(
      counters.childSaw,
      [
        { notes: [], label: 'pass-0' },
        { notes: [], label: 'pass-1' },
      ],
      'and no callback ran twice or saw the wrong frame',
    );
  });
});

test('a producer operand that cannot be stored fails the segment, rather than the claim', async () => {
  // The operand is recorded *before* reduction, so it reaches the payload boundary first. Left
  // unchecked, a value that boundary refuses surfaces as an infrastructure fault out of the claim —
  // and the run sits `running` with an open attempt instead of showing a failure somebody can read.
  const cases: readonly {
    readonly name: string;
    readonly build: () => AnyWorkflowDefinition;
  }[] = [
    {
      name: 'an update in a completing result',
      build: () => unstorableWorkflow({ where: 'complete' }),
    },
    {
      name: 'a wait declaration in a suspending result',
      build: () => unstorableWorkflow({ where: 'suspend' }),
    },
    {
      name: 'an update in a routing decision',
      build: () => unstorableWorkflow({ where: 'decision' }),
    },
  ];

  for (const testCase of cases) {
    await withHarness(async (harness) => {
      harness.publish({ workflowKey: 'unstorable', version: '1', definition: testCase.build() });
      const launched = await harness.launch({ workflowKey: 'unstorable' });
      await harness.drain();

      const failed = await harness.runOf(launched.id);
      assert.equal(failed.status, 'failed', testCase.name);
      assert.equal(failed.failureCode, 'unserializable_state', testCase.name);
      assert.equal(failed.activeAttemptId, null, `${testCase.name}: the claim was released`);
      assert.equal(failed.owner, null);

      const attempts = await run(harness.fixture.runs.listAttemptsForFrame(failed.activeFrameId!));
      const failing = attempts.at(-1)!;
      assert.equal(failing.status, 'failed', testCase.name);
      assert.equal(
        failing.producerOutput,
        null,
        `${testCase.name}: nothing partial was recorded as a reusable operand`,
      );
      assert.equal(failing.failureCode, 'unserializable_state');
    });
  }
});

/** A workflow that returns a value the payload boundary refuses, at a chosen seam. */
function unstorableWorkflow(options: {
  readonly where: 'complete' | 'suspend' | 'decision';
}): AnyWorkflowDefinition {
  // A `Date` round-trips through `structuredClone` but not through JSON, which is exactly the class
  // of value the serialization gate exists to catch.
  const unstorable = new Date('2026-01-01T00:00:00.000Z');
  const graph = createGraph<
    { readonly note: string },
    { readonly note: unknown },
    Record<string, unknown>
  >({
    key: 'unstorable',
    title: 'Unstorable',
    init: () => ({ note: 'start' }),
    state: { note: reduce.replace<string>() as never },
    entry: 'work',
    nodes: {
      work: operation(async () => {
        if (options.where === 'complete') return complete({ update: { note: unstorable } });
        if (options.where === 'suspend') {
          return suspend({
            wait: wait.userInput([
              // A declaration the runtime must persist verbatim, carrying a value it cannot store.
              { kind: 'text', key: 'note', label: 'Note', default: unstorable as never },
            ]),
          });
        }
        return complete();
      }),
    },
    edges: {
      'work-out': edge({
        from: 'work',
        to: ['finished'],
        choose: () =>
          options.where === 'decision'
            ? { to: 'finished', update: { note: unstorable } }
            : { to: 'finished' },
      }),
    },
    outcomes: { finished: outcome({ kind: 'success', output: () => ({}) }) },
  });
  return defineWorkflow({
    command: () => ({ title: 'Unstorable' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
}
