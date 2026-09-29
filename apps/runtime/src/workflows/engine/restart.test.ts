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
  suspend,
  wait,
  type NodeEvent,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import {
  workflowEvents,
  workflowExecutions,
  workflowOperations,
  workflowRuns,
} from '../../persistence/schema.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { withEngine, type EngineHarness } from './test-support.js';

/** What an app restart does to active runs, and how they continue afterwards. */

const runRow = (harness: EngineHarness, runId: number) =>
  harness.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()!;
const executions = (harness: EngineHarness, runId: number) =>
  harness.db.select().from(workflowExecutions).where(eq(workflowExecutions.runId, runId)).all();

const workflow = (graph: unknown): AnyWorkflowDefinition =>
  defineWorkflow({
    command: () => ({ title: 'Test workflow' }),
    parse: (_origin, inputs) => inputs,
    graph: graph as never,
  }) as unknown as AnyWorkflowDefinition;

function oneNode(run: Parameters<typeof operation>[0], seen?: NodeEvent[]) {
  return workflow(
    createGraph<{ n: number }>({
      key: 'one',
      title: 'One',
      init: () => ({ n: 0 }),
      state: { n: reduce.replace<number>() } as never,
      entry: 'work',
      nodes: { work: operation(run) },
      edges: {
        out: edge({
          from: 'work',
          to: ['done'],
          choose: (_state, event) => {
            seen?.push(event);
            return { to: 'done' };
          },
        }),
      },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    }),
  );
}

test('a node function cut off by a restart is interrupted and fails the run; Retry runs it again', async () => {
  await withEngine(async (harness) => {
    let cutOff = true;
    let calls = 0;
    harness.registry.publish(
      'one',
      oneNode(async () => {
        calls += 1;
        if (cutOff) await new Promise(() => undefined);
        return complete();
      }),
    );
    const { runId } = await launchInBackground(harness, 'one');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runRow(harness, runId).status, 'running');

    await harness.restart();
    const run = runRow(harness, runId);
    assert.equal(run.status, 'failed');
    const [cut] = executions(harness, runId);
    assert.equal(cut!.status, 'interrupted');
    assert.equal(JSON.parse(cut!.errorJson!).stage, 'node_function');
    assert.match(JSON.parse(run.errorJson!).message, /app restart/);

    cutOff = false;
    await harness.run(harness.engine.retry(runId));
    assert.equal(runRow(harness, runId).status, 'completed');
    assert.equal(calls, 2);
  });
});

test('a waiting run is paused by a restart, and Resume re-checks its wait against what happened meanwhile', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'one',
      oneNode(async (ctx) => {
        const handle = await ctx.spawnAgentSession({ harness: 'claude', prompt: 'Go.' });
        return suspend({ wait: wait.agentTurn(handle) });
      }),
    );
    const runId = await harness.launch('one');
    assert.equal(runRow(harness, runId).status, 'waiting');
    await harness.restart();
    assert.equal(runRow(harness, runId).status, 'paused');
    const paused = harness.db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.kind, 'run_paused'))
      .all();
    assert.deepEqual(JSON.parse(paused[0]!.dataJson!), { reason: 'app_restart' });

    // The agent finished while the app was down; nothing routes until Resume.
    await harness.agents.endTurn(1, 'Finished offline.');
    await harness.settle();
    assert.equal(runRow(harness, runId).status, 'paused');
    await harness.run(harness.engine.resume(runId));
    assert.equal(runRow(harness, runId).status, 'completed');
  });
});

test('a result saved before a restart but not yet routed is paused and completes on Resume', async () => {
  await withEngine(async (harness) => {
    let calls = 0;
    harness.registry.publish(
      'one',
      oneNode(async () => {
        calls += 1;
        await new Promise(() => undefined);
        return complete();
      }),
    );
    const { runId } = await launchInBackground(harness, 'one');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await harness.restart().catch(() => undefined);
    // Stand in for "the result was saved, then the app stopped before routing it".
    const [work] = executions(harness, runId);
    harness.db
      .update(workflowExecutions)
      .set({ status: 'running', errorJson: null, endedAt: null, resultJson: '{"type":"complete"}' })
      .where(eq(workflowExecutions.id, work!.id))
      .run();
    harness.db
      .update(workflowRuns)
      .set({ status: 'running', errorJson: null, endedAt: null })
      .where(eq(workflowRuns.id, runId))
      .run();
    await harness.restart();
    assert.equal(runRow(harness, runId).status, 'paused');
    await harness.run(harness.engine.resume(runId));
    assert.equal(runRow(harness, runId).status, 'completed');
    assert.equal(calls, 1, 'the saved result is routed without running the function again');
  });
});

test('a headless job running at restart is interrupted and delivered as such on Resume', async () => {
  await withEngine(async (harness) => {
    const seen: NodeEvent[] = [];
    harness.registry.publish(
      'one',
      oneNode(async (ctx) => {
        const job = await ctx.runHeadlessAgent({ harness: 'codex', prompt: 'Review.' });
        return suspend({ wait: wait.headlessAgent(job) });
      }, seen),
    );
    const runId = await harness.launch('one');
    await harness.restart();
    const [headless] = harness.db
      .select()
      .from(workflowOperations)
      .where(eq(workflowOperations.runId, runId))
      .all();
    assert.equal(headless!.status, 'interrupted');
    const finished = harness.db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.kind, 'operation_finished'))
      .all()
      .map((event) => JSON.parse(event.dataJson!));
    assert.deepEqual(finished, [
      { operationId: headless!.id, kind: 'run_headless', status: 'interrupted' },
    ]);
    assert.equal(runRow(harness, runId).status, 'paused');

    await harness.run(harness.engine.resume(runId));
    assert.equal(runRow(harness, runId).status, 'completed');
    const event = seen[0];
    assert.ok(event?.kind === 'headless_agent');
    assert.equal(event.results[0]!.status, 'interrupted');
    assert.deepEqual(event.results[0]!.interruption, {
      reason: 'runtime_restarted',
      launchedAt: headless!.startedAt,
    });
  });
});

/** Launch without waiting for the run to settle: its node function may never return. */
function launchInBackground(harness: EngineHarness, workflowKey: string) {
  return Effect.runPromise(
    harness.engine.launch({ workflowKey, inputs: {}, origin: { worktreeId: 1, surfaceId: 1 } }),
  );
}
