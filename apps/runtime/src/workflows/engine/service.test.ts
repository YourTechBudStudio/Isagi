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
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { workflowEvents, workflowExecutions, workflowOperations, workflowRuns } from '../tables.js';
import { withEngine, type EngineHarness } from './test-support.js';

/** The engine's own lifecycle: its background work, and what shutting it down does to that work. */

const runRow = (harness: EngineHarness, runId: number) =>
  harness.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()!;
const executions = (harness: EngineHarness, runId: number) =>
  harness.db.select().from(workflowExecutions).where(eq(workflowExecutions.runId, runId)).all();
const operations = (harness: EngineHarness, runId: number) =>
  harness.db.select().from(workflowOperations).where(eq(workflowOperations.runId, runId)).all();

const workflow = (graph: unknown): AnyWorkflowDefinition =>
  defineWorkflow({
    command: () => ({ title: 'Test workflow' }),
    parse: (_origin, inputs) => inputs,
    graph: graph as never,
  }) as unknown as AnyWorkflowDefinition;

function oneNode(run: Parameters<typeof operation>[0]) {
  return workflow(
    createGraph<{ n: number }>({
      key: 'one',
      title: 'One',
      init: () => ({ n: 0 }),
      state: { n: reduce.replace<number>() } as never,
      entry: 'work',
      nodes: { work: operation(run) },
      edges: {
        out: edge({ from: 'work', to: ['done'], choose: () => ({ to: 'done' }) }),
      },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    }),
  );
}

/** Launch without waiting for the run to settle: its node function may be held. */
function launchInBackground(harness: EngineHarness, workflowKey: string) {
  return Effect.runPromise(
    harness.engine.launch({ workflowKey, inputs: {}, origin: { worktreeId: 1, surfaceId: 1 } }),
  );
}

/** Polls a condition the engine reaches asynchronously, with a bound so a regression fails fast. */
async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting until ${what}.`);
}

test('engine shutdown interrupts running workflow fibers and records the runs as interrupted, not failed', async () => {
  await withEngine(async (harness) => {
    let rejection: unknown = null;
    harness.registry.publish(
      'one',
      oneNode(async (ctx) => {
        try {
          // Held in flight: the headless launch never returns until the engine stops.
          const job = await ctx.runHeadlessAgent({ harness: 'codex', prompt: 'Hold.' });
          return suspend({ wait: wait.headlessAgent(job) });
        } catch (error) {
          rejection = error;
          throw error;
        }
      }),
    );
    harness.headless.launchGate = new Promise(() => undefined);
    const { runId } = await launchInBackground(harness, 'one');
    await until(() => harness.headless.started.length === 1, 'the headless launch is in flight');
    assert.ok((await Effect.runPromise(harness.engine.inFlight)) > 0, 'the run is being driven');

    await harness.stop();

    // The bridged call was interrupted with the engine, so the author's promise rejected...
    await until(() => rejection !== null, "the author's promise rejects");
    // ...and nothing was recorded as a failure on the way down: the run, its execution and its
    // operation are left exactly where shutdown found them.
    assert.equal(runRow(harness, runId).status, 'running');
    assert.deepEqual(
      executions(harness, runId).map((execution) => execution.status),
      ['running'],
    );
    assert.deepEqual(
      operations(harness, runId).map((row) => row.status),
      ['running'],
    );
    const failures = harness.db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.kind, 'run_failed'))
      .all();
    assert.deepEqual(failures, [], 'an interrupted step is not a failed one');

    // The next start records what the shutdown cut off as interrupted.
    await harness.restart();
    assert.deepEqual(
      executions(harness, runId).map((execution) => execution.status),
      ['interrupted'],
    );
    const [held] = operations(harness, runId);
    assert.equal(held!.status, 'interrupted');
    assert.equal(JSON.parse(held!.resultJson!).error, 'runtime_restarted');
    assert.match(JSON.parse(runRow(harness, runId).errorJson!).message, /app restart/);
  });
});

test('busy reflects in-flight work and returns to idle', async () => {
  await withEngine(async (harness) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.registry.publish(
      'one',
      oneNode(async () => {
        await held;
        return complete();
      }),
    );
    assert.equal(await Effect.runPromise(harness.engine.inFlight), 0, 'idle before any launch');

    const { runId } = await launchInBackground(harness, 'one');
    await until(() => runRow(harness, runId).status === 'running', 'the run is driven');
    assert.ok((await Effect.runPromise(harness.engine.inFlight)) > 0, 'the driver is in flight');
    const idle = Effect.runPromise(harness.engine.awaitIdle).then(() => 'idle' as const);
    const early = await Promise.race([
      idle,
      new Promise<'busy'>((resolve) => setTimeout(() => resolve('busy'), 50)),
    ]);
    assert.equal(early, 'busy', 'awaitIdle waits while the node function is held');

    release();
    assert.equal(await idle, 'idle');
    assert.equal(await Effect.runPromise(harness.engine.inFlight), 0);
    assert.equal(runRow(harness, runId).status, 'completed');
  });
});

test('a headless job that ends before its timeout is never timed out', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'one',
      oneNode(async (ctx) => {
        const job = await ctx.runHeadlessAgent({
          harness: 'codex',
          prompt: 'Quick.',
          timeoutMs: 40,
        });
        return suspend({ wait: wait.headlessAgent(job) });
      }),
    );
    const runId = await harness.launch('one');
    await harness.headless.finish(1, 'done in time', 0);
    await harness.settle();
    assert.equal(runRow(harness, runId).status, 'completed');

    // Past the deadline the settled job's timer is gone: nothing is stopped or re-recorded.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await harness.settle();
    assert.deepEqual(harness.headless.terminated, []);
    const [job] = operations(harness, runId);
    assert.equal(job!.status, 'completed');
    assert.equal(job!.responseText, 'done in time');
  });
});
