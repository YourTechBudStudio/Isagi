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
import { eq } from 'drizzle-orm';

import {
  workflowEvents,
  workflowExecutions,
  workflowGraphInvocations,
  workflowOperations,
  workflowRuns,
} from '../../persistence/schema.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { withEngine, type EngineHarness } from './test-support.js';

/**
 * The drive loop: node functions, waits, the pure step, nested subgraphs, and the records they
 * leave. Each test runs the real engine over a real database; only the outside world is faked.
 */

const workflow = (graph: unknown): AnyWorkflowDefinition =>
  defineWorkflow({
    command: () => ({ title: 'Test workflow' }),
    parse: (_origin, inputs) => inputs,
    graph: graph as never,
  }) as unknown as AnyWorkflowDefinition;

function runRow(harness: EngineHarness, runId: number) {
  return harness.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()!;
}
function executions(harness: EngineHarness, runId: number) {
  return harness.db
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.runId, runId))
    .all();
}
function invocations(harness: EngineHarness, runId: number) {
  return harness.db
    .select()
    .from(workflowGraphInvocations)
    .where(eq(workflowGraphInvocations.runId, runId))
    .all();
}
function eventKinds(harness: EngineHarness, runId: number) {
  return harness.db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.runId, runId))
    .all()
    .map((event) => event.kind);
}

test('a complete node routes immediately and a root outcome completes the run', async () => {
  await withEngine(async (harness) => {
    const calls: string[] = [];
    const graph = createGraph<{ count: number }>({
      key: 'counter',
      title: 'Counter',
      init: () => ({ count: 0 }),
      state: { count: reduce.add() } as never,
      entry: 'bump',
      nodes: {
        bump: operation(async (_ctx, state: { count: number }) => {
          calls.push(`bump ${state.count}`);
          return complete({ update: { count: 1 } });
        }),
      },
      edges: {
        out: edge({
          from: 'bump',
          to: ['bump', 'done'],
          choose: (state: { count: number }) => ({ to: state.count < 2 ? 'bump' : 'done' }),
        }),
      },
      outcomes: {
        done: outcome({ kind: 'success', output: (state: { count: number }) => state.count }),
      },
    });
    harness.registry.publish('counter', workflow(graph));
    const runId = await harness.launch('counter');

    const run = runRow(harness, runId);
    assert.equal(run.status, 'completed');
    assert.deepEqual(JSON.parse(run.outcomeJson!), {
      outcomeId: 'done',
      kind: 'success',
      reason: null,
      output: 2,
    });
    assert.deepEqual(calls, ['bump 0', 'bump 1']);
    const rows = executions(harness, runId);
    assert.deepEqual(
      rows.map((row) => [row.nodeId, row.visitIndex, row.status, JSON.parse(row.decisionJson!).to]),
      [
        ['bump', 0, 'completed', 'bump'],
        ['bump', 1, 'completed', 'done'],
      ],
    );
    assert.deepEqual(JSON.parse(rows[1]!.stateAfterJson!), { count: 2 });
    assert.deepEqual(eventKinds(harness, runId), [
      'run_launched',
      'graph_entered',
      'node_started',
      'node_completed',
      'node_started',
      'node_completed',
      'graph_completed',
      'run_completed',
    ]);
  });
});

test('a suspend waits, its update is applied only with the event, and a user answer routes it', async () => {
  await withEngine(async (harness) => {
    const graph = createGraph<{ note: string; answer: string }>({
      key: 'ask',
      title: 'Ask',
      init: () => ({ note: '', answer: '' }),
      state: { note: reduce.replace<string>(), answer: reduce.replace<string>() } as never,
      entry: 'ask',
      nodes: {
        ask: operation(async () =>
          suspend({
            update: { note: 'asked' },
            wait: wait.userInput([{ kind: 'text', key: 'why', label: 'Why?' }]),
          }),
        ),
      },
      edges: {
        out: edge({
          from: 'ask',
          to: ['done'],
          choose: (_state, event) => ({
            to: 'done',
            update: { answer: event.kind === 'user_input' ? String(event.answers.why) : '?' },
          }),
        }),
      },
      outcomes: { done: outcome({ kind: 'success', output: (state: unknown) => state }) },
    });
    harness.registry.publish('ask', workflow(graph));
    const runId = await harness.launch('ask');

    assert.equal(runRow(harness, runId).status, 'waiting');
    const [asking] = executions(harness, runId);
    assert.equal(asking!.status, 'waiting');
    assert.deepEqual(
      JSON.parse(invocations(harness, runId)[0]!.stateJson),
      { note: '', answer: '' },
      'the suspend update waits for the event',
    );

    await harness.run(
      harness.engine.advance({ runId, executionId: asking!.id, answers: { why: 'because' } }),
    );
    const run = runRow(harness, runId);
    assert.equal(run.status, 'completed');
    assert.deepEqual(JSON.parse(run.outcomeJson!).output, { note: 'asked', answer: 'because' });
    assert.deepEqual(JSON.parse(executions(harness, runId)[0]!.eventJson!), {
      kind: 'user_input',
      answers: { why: 'because' },
    });
  });
});

test('subgraphs nest two levels deep and an authored failure outcome reaches the parent edge as data', async () => {
  await withEngine(async (harness) => {
    type Leaf = { attempts: number };
    const leaf = createGraph<Leaf, {}, { limit: number }, { attempts: number }>({
      key: 'leaf',
      title: 'Leaf',
      label: (parameters) => `Leaf up to ${parameters.limit}`,
      init: () => ({ attempts: 0 }),
      state: { attempts: reduce.add() } as never,
      entry: 'try',
      nodes: { try: operation(async () => complete({ update: { attempts: 1 } })) },
      edges: {
        out: edge({ from: 'try', to: ['gaveUp'], choose: () => ({ to: 'gaveUp' }) }),
      },
      outcomes: {
        gaveUp: outcome({
          kind: 'failure',
          reason: 'too hard',
          output: (state: Leaf) => ({ attempts: state.attempts }),
        }),
      },
    });
    type Middle = { seen: string };
    const middle = createGraph<Middle, {}, void, string>({
      key: 'middle',
      title: 'Middle',
      init: () => ({ seen: '' }),
      state: { seen: reduce.replace<string>() } as never,
      entry: 'runLeaf',
      nodes: {
        runLeaf: subgraph({
          graph: leaf,
          parameters: () => ({ limit: 3 }),
          onResult: (_parent, result) => ({ seen: `${result.outcomeKind}:${result.reason}` }),
        }),
      },
      edges: {
        out: edge({
          from: 'runLeaf',
          to: ['passedOn'],
          choose: (_state, event) => {
            assert.equal(event.kind, 'subgraph');
            return { to: 'passedOn' };
          },
        }),
      },
      outcomes: {
        passedOn: outcome({ kind: 'success', output: (state: Middle) => state.seen }),
      },
    });
    type Root = { report: string };
    const root = createGraph<Root>({
      key: 'root',
      title: 'Root',
      init: () => ({ report: '' }),
      state: { report: reduce.replace<string>() } as never,
      entry: 'runMiddle',
      nodes: {
        runMiddle: subgraph({
          graph: middle,
          parameters: () => undefined,
          onResult: (_parent, result) => ({ report: String(result.output) }),
        }),
      },
      edges: {
        out: edge({ from: 'runMiddle', to: ['finished'], choose: () => ({ to: 'finished' }) }),
      },
      outcomes: { finished: outcome({ kind: 'success', output: (state: Root) => state.report }) },
    });
    harness.registry.publish('nested', workflow(root));
    const runId = await harness.launch('nested');

    const run = runRow(harness, runId);
    assert.equal(run.status, 'completed', run.errorJson ?? '');
    assert.equal(JSON.parse(run.outcomeJson!).output, 'failure:too hard');
    const graphs = invocations(harness, runId);
    assert.deepEqual(
      graphs.map((row) => [row.graphKey, row.depth, row.status, row.label]),
      [
        ['root', 0, 'completed', null],
        ['middle', 1, 'completed', null],
        ['leaf', 2, 'completed', 'Leaf up to 3'],
      ],
    );
    assert.deepEqual(JSON.parse(graphs[2]!.outcomeJson!), {
      outcomeId: 'gaveUp',
      kind: 'failure',
      reason: 'too hard',
      output: { attempts: 1 },
    });
    const rows = executions(harness, runId);
    const middleNode = rows.find((row) => row.nodeId === 'runLeaf')!;
    assert.equal(middleNode.status, 'completed');
    assert.equal(middleNode.childInvocationId, graphs[2]!.id);
    assert.equal(JSON.parse(middleNode.eventJson!).result.outcomeKind, 'failure');
    assert.deepEqual(JSON.parse(middleNode.stateAfterJson!), { seen: 'failure:too hard' });
  });
});

test('a throwing reducer or edge fails the execution with its stage and leaves state unchanged', async () => {
  await withEngine(async (harness) => {
    const build = (failAt: 'reducer' | 'edge') =>
      createGraph<{ total: number }>({
        key: 'fragile',
        title: 'Fragile',
        init: () => ({ total: 5 }),
        state: {
          total: field<number, number>({
            reduce: (current, update) => {
              if (failAt === 'reducer') throw new Error('reducer broke');
              return current + update;
            },
          }),
        } as never,
        entry: 'step',
        nodes: { step: operation(async () => complete({ update: { total: 1 } })) },
        edges: {
          out: edge({
            from: 'step',
            to: ['done'],
            choose: () => {
              if (failAt === 'edge') throw new Error('edge broke');
              return { to: 'done' };
            },
          }),
        },
        outcomes: { done: outcome({ kind: 'success', output: () => null }) },
      });

    for (const failAt of ['reducer', 'edge'] as const) {
      harness.registry.publish(`fragile-${failAt}`, workflow(build(failAt)));
      const runId = await harness.launch(`fragile-${failAt}`);
      const run = runRow(harness, runId);
      assert.equal(run.status, 'failed');
      const [step] = executions(harness, runId);
      assert.equal(step!.status, 'failed');
      const error = JSON.parse(step!.errorJson!);
      assert.equal(error.stage, failAt);
      assert.equal(error.graphKey, 'fragile');
      assert.equal(error.nodeId, 'step');
      assert.match(error.message, failAt === 'reducer' ? /reducer broke/ : /edge broke/);
      assert.ok(
        step!.resultJson,
        'the result is saved, so a Retry does not run the function again',
      );
      assert.equal(step!.stateAfterJson, null);
      assert.deepEqual(JSON.parse(invocations(harness, runId)[0]!.stateJson), { total: 5 });
      assert.deepEqual(JSON.parse(run.errorJson!), error);
      await harness.run(harness.engine.dismiss(runId));
    }
  });
});

test('operations record the request and the agent reply, and an unreadable reply only logs', async () => {
  await withEngine(async (harness) => {
    const graph = createGraph<{ session: number; sentAt: string }>({
      key: 'dialogue',
      title: 'Dialogue',
      init: () => ({ session: 0, sentAt: '' }),
      state: { session: reduce.replace<number>(), sentAt: reduce.replace<string>() } as never,
      entry: 'spawn',
      nodes: {
        spawn: operation(async (ctx) => {
          const handle = await ctx.spawnAgentSession({ harness: 'claude', prompt: 'Write it.' });
          return suspend({
            update: { session: handle.agentSessionId },
            wait: wait.agentTurn(handle),
          });
        }),
        ask: operation(async (ctx, state: { session: number }) => {
          const target = await ctx.sendAgentPrompt({
            agentSessionId: state.session,
            prompt: 'Again.',
          });
          return suspend({ wait: wait.agentTurn(target) });
        }),
      },
      edges: {
        first: edge({ from: 'spawn', to: ['ask'], choose: () => ({ to: 'ask' }) }),
        second: edge({ from: 'ask', to: ['done'], choose: () => ({ to: 'done' }) }),
      },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    });
    harness.registry.publish('dialogue', workflow(graph));
    const runId = await harness.launch('dialogue');
    assert.equal(runRow(harness, runId).status, 'waiting');

    await harness.agents.endTurn(1, 'Here is the draft.');
    await harness.settle();
    // The second turn ends, but its conversation cannot be read: the run still continues.
    await harness.agents.endTurn(1, null);
    await harness.settle();

    const operations = harness.db
      .select()
      .from(workflowOperations)
      .where(eq(workflowOperations.runId, runId))
      .all();
    assert.deepEqual(
      operations.map((row) => [row.kind, row.status, row.agentSessionId]),
      [
        ['spawn_agent', 'completed', 1],
        ['send_prompt', 'completed', 1],
      ],
    );
    assert.equal(JSON.parse(operations[0]!.requestJson).prompt, 'Write it.');
    assert.equal(operations[0]!.responseText, 'Here is the draft.');
    assert.equal(JSON.parse(operations[1]!.requestJson).prompt, 'Again.');
    assert.equal(operations[1]!.responseText, null);
    assert.equal(
      runRow(harness, runId).status,
      'completed',
      runRow(harness, runId).errorJson ?? '',
    );
    const logs = harness.db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.kind, 'log'))
      .all();
    assert.equal(logs.length, 1);
    assert.match(logs[0]!.message, /could not be read/);
  });
});

test('every appended event is pushed live once, with the run summary after it', async () => {
  await withEngine(async (harness) => {
    const graph = createGraph<{ n: number }>({
      key: 'live',
      title: 'Live',
      init: () => ({ n: 0 }),
      state: { n: reduce.replace<number>() } as never,
      entry: 'say',
      nodes: {
        say: operation(async (ctx) => {
          await ctx.log('info', 'hello');
          await ctx.setUiFeedback({ phase: 'saying', message: 'hi' });
          return complete();
        }),
      },
      edges: { out: edge({ from: 'say', to: ['done'], choose: () => ({ to: 'done' }) }) },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    });
    harness.registry.publish('live', workflow(graph));
    const runId = await harness.launch('live');

    const stored = harness.db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, runId))
      .all();
    const pushed = harness.events.filter((event) => event.type === 'workflow_run_event');
    assert.deepEqual(
      pushed.map((event) => (event.payload as { eventId: number }).eventId),
      stored.map((event) => event.id),
    );
    const changed = harness.events.filter((event) => event.type === 'workflow_run_changed');
    assert.ok(changed.length > 0);
    const last = changed.at(-1)!.payload as { status: string; uiFeedback: unknown };
    assert.equal(last.status, 'completed');
    assert.deepEqual(last.uiFeedback, { kind: 'info', phase: 'saying', message: 'hi' });
    assert.ok(stored.some((event) => event.kind === 'log' && event.message === 'hello'));
  });
});

test("a parent's code that throws while a child returns fails the child's last execution and leaves the parent unchanged", async () => {
  await withEngine(async (harness) => {
    const child = createGraph<{ v: number }, {}, void, number>({
      key: 'child',
      title: 'Child',
      init: () => ({ v: 1 }),
      state: { v: reduce.replace<number>() } as never,
      entry: 'work',
      nodes: { work: operation(async () => complete({ update: { v: 2 } })) },
      edges: { out: edge({ from: 'work', to: ['ok'], choose: () => ({ to: 'ok' }) }) },
      outcomes: { ok: outcome({ kind: 'success', output: (state: { v: number }) => state.v }) },
    });
    const parent = createGraph<{ got: number }>({
      key: 'parent',
      title: 'Parent',
      init: () => ({ got: 0 }),
      state: { got: reduce.replace<number>() } as never,
      entry: 'call',
      nodes: {
        call: subgraph({
          graph: child,
          parameters: () => undefined,
          onResult: (_state, result) => ({ got: result.output as number }),
        }),
      },
      edges: {
        out: edge({
          from: 'call',
          to: ['done'],
          choose: () => {
            throw new Error('parent edge broke');
          },
        }),
      },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    });
    harness.registry.publish('returning', workflow(parent));
    const runId = await harness.launch('returning');

    assert.equal(runRow(harness, runId).status, 'failed');
    const rows = executions(harness, runId);
    const work = rows.find((row) => row.nodeId === 'work')!;
    const call = rows.find((row) => row.nodeId === 'call')!;
    assert.equal(work.status, 'failed');
    assert.deepEqual(
      { ...JSON.parse(work.errorJson!), message: undefined },
      { stage: 'edge', graphKey: 'parent', nodeId: 'call', message: undefined },
    );
    assert.equal(call.status, 'waiting', 'nothing is written to the parent on failure');
    const graphs = invocations(harness, runId);
    assert.deepEqual(JSON.parse(graphs[0]!.stateJson), { got: 0 });
    assert.equal(graphs[1]!.status, 'running');
    assert.deepEqual(JSON.parse(graphs[1]!.stateJson), { v: 1 });
  });
});

test('each operation is announced when it starts and when it finishes, and pushed live', async () => {
  await withEngine(async (harness) => {
    const graph = createGraph<{ session: number }>({
      key: 'announced',
      title: 'Announced',
      init: () => ({ session: 0 }),
      state: { session: reduce.replace<number>() } as never,
      entry: 'spawn',
      nodes: {
        spawn: operation(async (ctx) => {
          const handle = await ctx.spawnAgentSession({ harness: 'claude', prompt: 'Write.' });
          return suspend({
            update: { session: handle.agentSessionId },
            wait: wait.agentTurn(handle),
          });
        }),
        send: operation(async (ctx, state: { session: number }) => {
          const target = await ctx.sendAgentPrompt({
            agentSessionId: state.session,
            prompt: 'More.',
          });
          return suspend({ wait: wait.agentTurn(target) });
        }),
        review: operation(async (ctx) => {
          const job = await ctx.runHeadlessAgent({ harness: 'codex', prompt: 'Review.' });
          return suspend({ wait: wait.headlessAgent(job) });
        }),
      },
      edges: {
        a: edge({ from: 'spawn', to: ['send'], choose: () => ({ to: 'send' }) }),
        b: edge({ from: 'send', to: ['review'], choose: () => ({ to: 'review' }) }),
        c: edge({ from: 'review', to: ['done'], choose: () => ({ to: 'done' }) }),
      },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    });
    harness.registry.publish('announced', workflow(graph));
    const runId = await harness.launch('announced');
    await harness.agents.endTurn(1);
    await harness.settle();
    await harness.agents.endTurn(1);
    await harness.settle();
    await harness.headless.finish(1, 'fine');
    await harness.settle();
    assert.equal(runRow(harness, runId).status, 'completed');

    const announced = harness.db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, runId))
      .all()
      .filter((event) => event.kind === 'operation_started' || event.kind === 'operation_finished');
    const operations = harness.db
      .select()
      .from(workflowOperations)
      .where(eq(workflowOperations.runId, runId))
      .all();
    assert.deepEqual(
      announced.map((event) => [event.kind, event.category, JSON.parse(event.dataJson!)]),
      [
        ['operation_started', 'node', { operationId: operations[0]!.id, kind: 'spawn_agent' }],
        [
          'operation_finished',
          'node',
          { operationId: operations[0]!.id, kind: 'spawn_agent', status: 'completed' },
        ],
        ['operation_started', 'node', { operationId: operations[1]!.id, kind: 'send_prompt' }],
        [
          'operation_finished',
          'node',
          { operationId: operations[1]!.id, kind: 'send_prompt', status: 'completed' },
        ],
        ['operation_started', 'node', { operationId: operations[2]!.id, kind: 'run_headless' }],
        [
          'operation_finished',
          'node',
          { operationId: operations[2]!.id, kind: 'run_headless', status: 'completed' },
        ],
      ],
    );
    for (const [index, event] of announced.entries()) {
      assert.equal(event.executionId, operations[Math.floor(index / 2)]!.executionId);
    }
    const pushed = new Set(
      harness.events
        .filter((event) => event.type === 'workflow_run_event')
        .map((event) => (event.payload as { eventId: number }).eventId),
    );
    for (const event of announced) assert.ok(pushed.has(event.id));
  });
});
