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
} from '@yourtechbudstudio/isagi-workflow-sdk';

import { run } from '../persistence/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { captureLabel } from './labels.js';
import { makeEngineHarness, type EngineHarness } from './test-support.js';

/**
 * Display names are cosmetic, and every rule here exists to keep them that way.
 *
 * A name is a fact about what the run was doing *then*, captured once at the commit that created
 * the record it names. It is never recomputed, never identity, and above all never load-bearing: a
 * label that throws must not be able to break a run, which is why `label_failed` is deliberately
 * absent from the segment failure codes.
 */

async function withHarness(body: (harness: EngineHarness) => Promise<void>) {
  const harness = await makeEngineHarness();
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

type LabelKind =
  | 'throws'
  | 'non-string'
  | 'empty'
  | 'none'
  | ((state: { rounds: number }) => string);

/** One node, one router, one outcome — with the node's label switchable between versions. */
function labelledWorkflow(options: {
  readonly nodeLabel: LabelKind;
  readonly graphLabel?: LabelKind;
  readonly callbackThrows?: boolean;
}): AnyWorkflowDefinition {
  // A graph is named from its *parameters* and a node from its *state*, so the two resolvers are
  // separate rather than one signature standing in for both.
  const resolve = <Argument>(
    kind: LabelKind | undefined,
  ): ((argument: Argument) => string) | undefined => {
    if (kind === undefined || kind === 'none') return undefined;
    if (typeof kind === 'function') return kind as (argument: Argument) => string;
    if (kind === 'throws') {
      return () => {
        throw new Error('the label is broken in this version');
      };
    }
    // An authoring mistake the runtime has to tolerate, written as the mistake it is rather than as
    // a value the signature would accept.
    if (kind === 'non-string') return (() => 42) as unknown as (argument: Argument) => string;
    return () => '';
  };
  const graphLabel = resolve<Record<string, unknown>>(options.graphLabel);
  const nodeLabel = resolve<{ readonly rounds: number }>(options.nodeLabel);

  const graph = createGraph<{ readonly rounds: number }, {}, Record<string, unknown>>({
    key: 'labelled',
    title: 'Labelled',
    ...(graphLabel ? { label: graphLabel } : {}),
    init: () => ({ rounds: 0 }),
    state: { rounds: reduce.add() },
    entry: 'work',
    nodes: {
      work: operation(
        async () => {
          if (options.callbackThrows) throw new Error('the callback is broken in this version');
          return complete({ update: { rounds: 1 } });
        },
        nodeLabel ? { label: nodeLabel } : {},
      ),
    },
    edges: {
      'work-out': edge({ from: 'work', to: ['finished'], choose: () => ({ to: 'finished' }) }),
    },
    outcomes: { finished: outcome({ kind: 'success', output: () => ({}) }) },
  });
  return defineWorkflow({
    command: () => ({ title: 'Labelled' }),
    validate: () => {},
    graph,
  }) as AnyWorkflowDefinition;
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

test('captureLabel classifies every way a label can fail to produce a name', () => {
  assert.deepEqual(captureLabel({ what: "node 'a'", label: undefined, argument: () => ({}) }), {
    displayName: null,
    diagnostic: null,
  });

  const cases: readonly { readonly label: () => unknown; readonly reason: RegExp }[] = [
    {
      label: () => {
        throw new Error('boom');
      },
      reason: /threw: boom/,
    },
    { label: () => 42, reason: /returned number/ },
    { label: () => null, reason: /returned null/ },
    { label: () => '', reason: /empty string/ },
    { label: () => Promise.resolve('later'), reason: /promise/ },
  ];
  for (const testCase of cases) {
    const captured = captureLabel({
      what: "node 'a'",
      label: testCase.label as (argument: never) => string,
      argument: () => ({}),
    });
    assert.equal(captured.displayName, null);
    assert.match(captured.diagnostic?.reason ?? '', testCase.reason);
  }

  // A label that mutates its input throws, because the input is isolated — and that is still only a
  // failed capture, never a thrown error the caller has to handle.
  const mutating = captureLabel({
    what: "node 'a'",
    label: ((state: { items: string[] }) => {
      state.items.push('x');
      return 'named';
    }) as unknown as (argument: never) => string,
    argument: () => ({ items: [] }),
  });
  assert.equal(mutating.displayName, null);
  assert.ok(mutating.diagnostic);

  assert.deepEqual(
    captureLabel({
      what: "node 'a'",
      label: ((state: { rounds: number }) => `round ${state.rounds}`) as (
        argument: never,
      ) => string,
      argument: () => ({ rounds: 3 }),
    }),
    { displayName: 'round 3', diagnostic: null },
  );
});

test('a failing label leaves the name null, records label_failed, and does not fail the run', async () => {
  for (const kind of ['throws', 'non-string', 'empty'] as const) {
    await withHarness(async (harness) => {
      harness.publish({
        workflowKey: 'labelled',
        version: '1',
        definition: labelledWorkflow({ nodeLabel: kind, graphLabel: kind }),
      });
      const launched = await harness.launch({ workflowKey: 'labelled' });
      await harness.drain();

      const finished = await harness.runOf(launched.id);
      assert.equal(finished.status, 'done', `${kind}: a cosmetic name cannot break a run`);
      assert.equal(finished.failureCode, null);

      const frames = await run(harness.fixture.runs.listFrames(launched.id));
      assert.equal(frames[0]!.displayName, null, `${kind}: no name was stored`);
      const executions = await run(harness.fixture.runs.listExecutions(frames[0]!.id));
      assert.equal(executions[0]!.displayName, null);

      // The record it names exists regardless; only the name is missing.
      assert.equal(executions[0]!.nodeId, 'work');
      const logged = diagnostics(harness, launched.id);
      assert.equal(
        logged.filter((detail) => detail.includes('label_failed')).length,
        2,
        `${kind}: one diagnostic for the frame's label and one for the node's`,
      );
      assert.ok(logged.some((detail) => detail.includes("graph 'labelled'")));
      assert.ok(logged.some((detail) => detail.includes("node 'work'")));
    });
  }
});

test('a captured name is never recomputed, by Retry or by restart', async () => {
  await withHarness(async (harness) => {
    harness.publish({
      workflowKey: 'labelled',
      version: 'first',
      definition: labelledWorkflow({
        nodeLabel: () => 'named when the visit began',
        graphLabel: () => 'the original graph name',
        callbackThrows: true,
      }),
    });
    const launched = await harness.launch({ workflowKey: 'labelled' });
    await harness.drain();

    const failed = await harness.runOf(launched.id);
    assert.equal(failed.failureCode, 'node_callback_failed');
    const frame = (await run(harness.fixture.runs.findFrame(failed.activeFrameId!)))!;
    const before = (await run(harness.fixture.runs.listExecutions(frame.id)))[0]!;
    assert.equal(before.displayName, 'named when the visit began');
    assert.equal(frame.displayName, 'the original graph name');

    // A restart re-runs startup recovery and creates no record, so there is nothing to rename. (A
    // failed run is not parked and not resumable — Retry is the control that repairs it.)
    await harness.restart();
    assert.equal(
      (await run(harness.fixture.runs.findExecution(before.id)))!.displayName,
      'named when the visit began',
    );

    // Edited code with different labels, adopted through a real Retry. The records these named
    // already exist, so their names are facts about what the run was doing then.
    harness.publish({
      workflowKey: 'labelled',
      version: 'renamed',
      definition: labelledWorkflow({
        nodeLabel: () => 'a completely different name',
        graphLabel: () => 'a completely different graph name',
      }),
    });
    harness.setCurrent('labelled', 'renamed');
    assert.equal((await run(harness.controls.retry(launched.id))).accepted, true);
    await harness.drain();

    assert.equal((await harness.runOf(launched.id)).status, 'done');
    assert.equal(
      (await run(harness.fixture.runs.findExecution(before.id)))!.displayName,
      'named when the visit began',
      'Retry re-ran the segment, not the naming of a record that already existed',
    );
    assert.equal(
      (await run(harness.fixture.runs.findFrame(frame.id)))!.displayName,
      'the original graph name',
    );
  });
});

test('identical names stay distinguishable, because the stable reference is the identity', async () => {
  await withHarness(async (harness) => {
    const graph = createGraph<{ readonly rounds: number }, {}, Record<string, unknown>>({
      key: 'labelled',
      title: 'Labelled',
      init: () => ({ rounds: 0 }),
      state: { rounds: reduce.add() },
      entry: 'work',
      nodes: {
        // Deliberately constant: two visits get the same name, and must still be two visits.
        work: operation(async () => complete({ update: { rounds: 1 } }), {
          label: () => 'the same name every time',
        }),
      },
      edges: {
        'work-out': edge({
          from: 'work',
          to: ['work', 'finished'],
          choose: (state) => ({ to: state.rounds >= 2 ? 'finished' : 'work' }),
        }),
      },
      outcomes: { finished: outcome({ kind: 'success', output: () => ({}) }) },
    });
    harness.publish({
      workflowKey: 'labelled',
      version: '1',
      definition: defineWorkflow({
        command: () => ({ title: 'Labelled' }),
        validate: () => {},
        graph,
      }) as AnyWorkflowDefinition,
    });
    const launched = await harness.launch({ workflowKey: 'labelled' });
    await harness.drain();

    const frames = await run(harness.fixture.runs.listFrames(launched.id));
    const executions = await run(harness.fixture.runs.listExecutions(frames[0]!.id));
    assert.equal(executions.length, 2);
    assert.deepEqual(
      executions.map((execution) => execution.displayName),
      ['the same name every time', 'the same name every time'],
    );
    assert.equal(new Set(executions.map((execution) => execution.id)).size, 2);
    assert.deepEqual(
      executions.map((execution) => execution.visitIndex),
      [0, 1],
      'identity is the row and its visit index; the name is decoration on top of it',
    );
  });
});
