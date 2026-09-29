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
  type OperationContext,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { eq } from 'drizzle-orm';
import { Effect } from 'effect';

import {
  workflowEvents,
  workflowExecutions,
  workflowOperations,
  workflowRuns,
} from '../../persistence/schema.js';
import { WorkflowEngineError } from '../errors.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { withEngine, type EngineHarness } from './test-support.js';

/** Pause, Resume, Retry, Cancel, Dismiss and Advance, and the code reload behind Resume and Retry. */

const workflow = (graph: unknown): AnyWorkflowDefinition =>
  defineWorkflow({
    command: () => ({ title: 'Test workflow' }),
    parse: (_origin, inputs) => inputs,
    graph: graph as never,
  }) as unknown as AnyWorkflowDefinition;

const runRow = (harness: EngineHarness, runId: number) =>
  harness.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()!;
const executions = (harness: EngineHarness, runId: number) =>
  harness.db.select().from(workflowExecutions).where(eq(workflowExecutions.runId, runId)).all();
const eventKinds = (harness: EngineHarness, runId: number) =>
  harness.db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.runId, runId))
    .all()
    .map((event) => event.kind);

function rejection(error: unknown) {
  assert.ok(
    error instanceof WorkflowEngineError,
    `expected a workflow rejection, got ${String(error)}`,
  );
  return error;
}

/** One operation node, `work`, routed by `edgeBody` to the `done` outcome. */
function oneStep(options: {
  readonly work: (ctx: OperationContext) => Promise<unknown>;
  readonly choose?: (state: { value: string }) => { to: string };
  readonly nodeKey?: string;
}) {
  const node = options.nodeKey ?? 'work';
  return workflow(
    createGraph<{ value: string }>({
      key: 'one',
      title: 'One',
      init: () => ({ value: '' }),
      state: { value: reduce.replace<string>() } as never,
      entry: node,
      nodes: {
        [node]: operation(async (ctx) => {
          await options.work(ctx);
          return complete({ update: { value: 'worked' } });
        }),
      },
      edges: {
        out: edge({
          from: node,
          to: ['done'],
          choose: (state: { value: string }) => options.choose?.(state) ?? { to: 'done' },
        }),
      },
      outcomes: {
        done: outcome({ kind: 'success', output: (state: { value: string }) => state.value }),
      },
    }),
  );
}

test('Retry after fixing an edge re-runs the edge with the new code and not the node function', async () => {
  await withEngine(async (harness) => {
    let calls = 0;
    const firstHash = harness.registry.publish(
      'one',
      oneStep({
        work: async () => void (calls += 1),
        choose: () => {
          throw new Error('the old edge is wrong');
        },
      }),
    );
    const runId = await harness.launch('one');
    assert.equal(runRow(harness, runId).status, 'failed');
    const [failed] = executions(harness, runId);
    assert.equal(JSON.parse(failed!.errorJson!).stage, 'edge');

    const fixedHash = harness.registry.publish(
      'one',
      oneStep({ work: async () => void (calls += 1) }),
    );
    const summary = await harness.run(harness.engine.retry(runId));
    assert.equal(summary.artifactHash, fixedHash);

    const run = runRow(harness, runId);
    assert.equal(run.status, 'completed');
    assert.equal(calls, 1, 'the saved result is reused; the function is not run again');
    const rows = executions(harness, runId);
    assert.deepEqual(
      rows.map((row) => [row.status, row.retryOf, row.artifactHash]),
      [
        ['failed', null, firstHash],
        ['completed', failed!.id, fixedHash],
      ],
    );
    assert.equal(rows[1]!.resultJson, rows[0]!.resultJson);
    assert.ok(eventKinds(harness, runId).includes('code_reloaded'));
  });
});

test('Retry after a node function threw runs it again in a new row that knows it is a retry', async () => {
  await withEngine(async (harness) => {
    const seen: OperationContext['execution'][] = [];
    let throws = true;
    harness.registry.publish(
      'one',
      oneStep({
        work: async (ctx) => {
          seen.push(ctx.execution);
          if (throws) throw new Error('not yet');
        },
      }),
    );
    const runId = await harness.launch('one');
    const [failed] = executions(harness, runId);
    assert.equal(failed!.status, 'failed');
    assert.deepEqual(JSON.parse(failed!.errorJson!), {
      stage: 'node_function',
      message: 'not yet',
      graphKey: 'one',
      nodeId: 'work',
    });
    assert.equal(failed!.resultJson, null);

    throws = false;
    await harness.run(harness.engine.retry(runId));
    assert.equal(runRow(harness, runId).status, 'completed');
    const rows = executions(harness, runId);
    assert.equal(rows[1]!.retryOf, failed!.id);
    assert.equal(rows[1]!.visitIndex, failed!.visitIndex);
    assert.deepEqual(seen, [
      {
        runId,
        graphInvocationId: failed!.invocationId,
        executionId: failed!.id,
        attempt: 'initial',
      },
      {
        runId,
        graphInvocationId: failed!.invocationId,
        executionId: rows[1]!.id,
        attempt: 'retry',
      },
    ]);
  });
});

test("Retry of a failed return path replays the child's step and the parent's code", async () => {
  await withEngine(async (harness) => {
    const build = (parentEdgeThrows: boolean) => {
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
      return workflow(
        createGraph<{ got: number }>({
          key: 'parent',
          title: 'Parent',
          init: () => ({ got: 0 }),
          state: { got: reduce.add() } as never,
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
                if (parentEdgeThrows) throw new Error('parent edge broke');
                return { to: 'done' };
              },
            }),
          },
          outcomes: {
            done: outcome({ kind: 'success', output: (state: { got: number }) => state.got }),
          },
        }),
      );
    };
    harness.registry.publish('returning', build(true));
    const runId = await harness.launch('returning');
    assert.equal(runRow(harness, runId).status, 'failed');

    harness.registry.publish('returning', build(false));
    await harness.run(harness.engine.retry(runId));
    const run = runRow(harness, runId);
    assert.equal(run.status, 'completed');
    // `add` would double a parent update that had already been applied once.
    assert.equal(JSON.parse(run.outcomeJson!).output, 2);
    const rows = executions(harness, runId);
    const retried = rows.find((row) => row.retryOf !== null)!;
    assert.equal(retried.nodeId, 'work');
  });
});

test('Resume reloads the latest build and routes with it', async () => {
  await withEngine(async (harness) => {
    const gate = (route: 'left' | 'right') =>
      workflow(
        createGraph<{ side: string }>({
          key: 'gate',
          title: 'Gate',
          init: () => ({ side: '' }),
          state: { side: reduce.replace<string>() } as never,
          entry: 'hold',
          nodes: { hold: operation(async () => suspend({ wait: wait.userContinue('Go on') })) },
          edges: {
            out: edge({ from: 'hold', to: ['left', 'right'], choose: () => ({ to: route }) }),
          },
          outcomes: {
            left: outcome({ kind: 'success', output: () => 'left' }),
            right: outcome({ kind: 'success', output: () => 'right' }),
          },
        }),
      );
    harness.registry.publish('gate', gate('left'));
    const runId = await harness.launch('gate');
    assert.equal(runRow(harness, runId).status, 'waiting');

    const paused = await harness.run(harness.engine.pause(runId));
    assert.equal(paused.status, 'paused');
    assert.deepEqual(paused.controls, {
      pause: false,
      resume: true,
      retry: false,
      cancel: true,
      dismiss: false,
    });
    // An answer while paused is stored, but nothing routes until Resume.
    const [hold] = executions(harness, runId);
    await harness.run(harness.engine.advance({ runId, executionId: hold!.id }));
    assert.equal(runRow(harness, runId).status, 'paused');

    const newHash = harness.registry.publish('gate', gate('right'));
    await harness.run(harness.engine.resume(runId));
    const run = runRow(harness, runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.artifactHash, newHash);
    assert.equal(JSON.parse(run.outcomeJson!).output, 'right');
  });
});

test('Resume and Retry are refused, leaving the run unchanged, when the parked node no longer exists', async () => {
  await withEngine(async (harness) => {
    const waitHere = (node: string) =>
      workflow(
        createGraph<{ n: number }>({
          key: 'parked',
          title: 'Parked',
          init: () => ({ n: 0 }),
          state: { n: reduce.replace<number>() } as never,
          entry: node,
          nodes: { [node]: operation(async () => suspend({ wait: wait.userContinue() })) },
          edges: { out: edge({ from: node, to: ['done'], choose: () => ({ to: 'done' }) }) },
          outcomes: { done: outcome({ kind: 'success', output: () => null }) },
        }),
      );
    const hash = harness.registry.publish('parked', waitHere('hold'));
    const runId = await harness.launch('parked');
    await harness.run(harness.engine.pause(runId));
    harness.registry.publish('parked', waitHere('renamed'));

    const refused = rejection(await harness.fail(harness.engine.resume(runId)));
    assert.equal(refused.code, 'workflow_code_incompatible');
    assert.equal(refused.diagnostics?.[0]?.code, 'node_missing');
    const run = runRow(harness, runId);
    assert.equal(run.status, 'paused');
    assert.equal(run.artifactHash, hash);

    // Retry checks the same way against the execution it would repeat.
    let failNow = true;
    const failing = (node: string) =>
      oneStep({
        nodeKey: node,
        work: async () => {
          if (failNow) throw new Error('boom');
        },
      });
    await harness.run(harness.engine.cancel(runId));
    await harness.run(harness.engine.dismiss(runId));
    harness.registry.publish('one', failing('work'));
    const failedRun = await harness.launch('one');
    harness.registry.publish('one', failing('elsewhere'));
    failNow = false;
    const retryRefused = rejection(await harness.fail(harness.engine.retry(failedRun)));
    assert.equal(retryRefused.code, 'workflow_code_incompatible');
    assert.equal(runRow(harness, failedRun).status, 'failed');
  });
});

test('a surface holds one run: a second launch is refused until the first is dismissed', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'gate',
      workflow(
        createGraph<{ n: number }>({
          key: 'gate',
          title: 'Gate',
          init: () => ({ n: 0 }),
          state: { n: reduce.replace<number>() } as never,
          entry: 'hold',
          nodes: { hold: operation(async () => suspend({ wait: wait.userContinue() })) },
          edges: { out: edge({ from: 'hold', to: ['done'], choose: () => ({ to: 'done' }) }) },
          outcomes: { done: outcome({ kind: 'success', output: () => null }) },
        }),
      ),
    );
    const first = await harness.launch('gate');
    const busy = rejection(
      await harness.fail(
        harness.engine.launch({
          workflowKey: 'gate',
          inputs: {},
          origin: { worktreeId: 1, surfaceId: 1 },
        }),
      ),
    );
    assert.equal(busy.code, 'workflow_surface_busy');
    assert.equal(busy.activeWorkflowRunId, first);

    const refusedDismiss = rejection(await harness.fail(harness.engine.dismiss(first)));
    assert.equal(refusedDismiss.code, 'workflow_control_unavailable');
    const [hold] = executions(harness, first);
    await harness.run(harness.engine.advance({ runId: first, executionId: hold!.id }));
    assert.equal(runRow(harness, first).status, 'completed');
    const dismissed = await harness.run(harness.engine.dismiss(first));
    assert.equal(dismissed.surfaceId, null);
    assert.ok(eventKinds(harness, first).includes('run_dismissed'));
    await harness.launch('gate');
  });
});

test('advance validates what it answers', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'ask',
      workflow(
        createGraph<{ n: number }>({
          key: 'ask',
          title: 'Ask',
          init: () => ({ n: 0 }),
          state: { n: reduce.replace<number>() } as never,
          entry: 'ask',
          nodes: {
            ask: operation(async () =>
              suspend({
                wait: wait.userInput([
                  { kind: 'select', key: 'pick', label: 'Pick', options: [{ value: 'a' }] },
                ]),
              }),
            ),
          },
          edges: { out: edge({ from: 'ask', to: ['done'], choose: () => ({ to: 'done' }) }) },
          outcomes: { done: outcome({ kind: 'success', output: () => null }) },
        }),
      ),
    );
    const runId = await harness.launch('ask');
    const [ask] = executions(harness, runId);
    const invalid = rejection(
      await harness.fail(
        harness.engine.advance({ runId, executionId: ask!.id, answers: { pick: 'zzz' } }),
      ),
    );
    assert.equal(invalid.code, 'workflow_user_input_invalid');
    const stale = rejection(
      await harness.fail(harness.engine.advance({ runId, executionId: ask!.id + 99, answers: {} })),
    );
    assert.equal(stale.code, 'workflow_wait_not_found');
    await harness.run(
      harness.engine.advance({ runId, executionId: ask!.id, answers: { pick: 'a' } }),
    );
    assert.equal(runRow(harness, runId).status, 'completed');
  });
});

test('Cancel stops the run and its headless processes; a process that will not stop is reported', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'review',
      workflow(
        createGraph<{ n: number }>({
          key: 'review',
          title: 'Review',
          init: () => ({ n: 0 }),
          state: { n: reduce.replace<number>() } as never,
          entry: 'review',
          nodes: {
            review: operation(async (ctx) => {
              const first = await ctx.runHeadlessAgent({ harness: 'claude', prompt: 'Review A' });
              const second = await ctx.runHeadlessAgent({ harness: 'claude', prompt: 'Review B' });
              return suspend({ wait: wait.headlessAgent([first, second]) });
            }),
          },
          edges: { out: edge({ from: 'review', to: ['done'], choose: () => ({ to: 'done' }) }) },
          outcomes: { done: outcome({ kind: 'success', output: () => null }) },
        }),
      ),
    );
    const runId = await harness.launch('review');
    assert.equal(runRow(harness, runId).status, 'waiting');
    harness.headless.terminateFails = true;

    const cancelled = await harness.run(harness.engine.cancel(runId));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(executions(harness, runId)[0]!.status, 'cancelled');
    const operations = harness.db
      .select()
      .from(workflowOperations)
      .where(eq(workflowOperations.runId, runId))
      .all();
    assert.deepEqual(
      operations.map((row) => row.status),
      ['interrupted', 'interrupted'],
    );
    assert.equal(eventKinds(harness, runId).filter((kind) => kind === 'stop_failed').length, 2);
    assert.equal(cancelled.controls.dismiss, true);
  });
});

test('headless results reach the edge in declared order once every operation has finished', async () => {
  await withEngine(async (harness) => {
    let seen: unknown = null;
    harness.registry.publish(
      'review',
      workflow(
        createGraph<{ n: number }>({
          key: 'review',
          title: 'Review',
          init: () => ({ n: 0 }),
          state: { n: reduce.replace<number>() } as never,
          entry: 'review',
          nodes: {
            review: operation(async (ctx) => {
              const first = await ctx.runHeadlessAgent({ harness: 'claude', prompt: 'Review A' });
              const second = await ctx.runHeadlessAgent({ harness: 'claude', prompt: 'Review B' });
              return suspend({ wait: wait.headlessAgent([first, second]) });
            }),
          },
          edges: {
            out: edge({
              from: 'review',
              to: ['done'],
              choose: (_state, event) => {
                seen = event;
                return { to: 'done' };
              },
            }),
          },
          outcomes: { done: outcome({ kind: 'success', output: () => null }) },
        }),
      ),
    );
    const runId = await harness.launch('review');
    await harness.headless.finish(2, 'B looks fine');
    await harness.settle();
    assert.equal(runRow(harness, runId).status, 'waiting', 'one result is not enough');
    await harness.headless.finish(1, 'A has a bug', 1);
    await harness.settle();
    assert.equal(runRow(harness, runId).status, 'completed');
    const results = (seen as { results: { operationId: string; status: string; output: string }[] })
      .results;
    assert.deepEqual(
      results.map((result) => [result.status, result.output]),
      [
        ['failed', 'A has a bug'],
        ['completed', 'B looks fine'],
      ],
    );
    const operations = harness.db
      .select()
      .from(workflowOperations)
      .where(eq(workflowOperations.runId, runId))
      .all();
    assert.equal(operations[1]!.responseText, 'B looks fine');
  });
});

test('Resume and Retry need a surface: a run whose surface was deleted cannot continue', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'gate',
      workflow(
        createGraph<{ n: number }>({
          key: 'gate',
          title: 'Gate',
          init: () => ({ n: 0 }),
          state: { n: reduce.replace<number>() } as never,
          entry: 'hold',
          nodes: { hold: operation(async () => suspend({ wait: wait.userContinue() })) },
          edges: { out: edge({ from: 'hold', to: ['done'], choose: () => ({ to: 'done' }) }) },
          outcomes: { done: outcome({ kind: 'success', output: () => null }) },
        }),
      ),
    );
    const surfaceId = harness.places.addSurface(1);
    const { runId } = await harness.run(
      harness.engine.launch({
        workflowKey: 'gate',
        inputs: {},
        origin: { worktreeId: 1, surfaceId },
      }),
    );
    await harness.run(harness.engine.pause(runId));
    harness.places.deleteSurface(surfaceId);
    const summary = await harness.run(harness.engine.getRun(runId));
    assert.equal(summary.run.surfaceId, null);
    assert.equal(summary.run.controls.resume, false);
    const refused = rejection(await harness.fail(harness.engine.resume(runId)));
    assert.equal(refused.code, 'workflow_control_unavailable');
    assert.equal(refused.control, 'resume');
  });
});

/** One headless job, with the edge recording what it received. */
function oneJob(seen: unknown[], timeoutMs?: number) {
  return workflow(
    createGraph<{ n: number }>({
      key: 'job',
      title: 'Job',
      init: () => ({ n: 0 }),
      state: { n: reduce.replace<number>() } as never,
      entry: 'run',
      nodes: {
        run: operation(async (ctx) => {
          const job = await ctx.runHeadlessAgent({
            harness: 'codex',
            prompt: 'Check.',
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          });
          return suspend({ wait: wait.headlessAgent(job) });
        }),
      },
      edges: {
        out: edge({
          from: 'run',
          to: ['done'],
          choose: (_state, event) => {
            seen.push(event);
            return { to: 'done' };
          },
        }),
      },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    }),
  );
}

const jobRow = (harness: EngineHarness, runId: number) =>
  harness.db.select().from(workflowOperations).where(eq(workflowOperations.runId, runId)).get()!;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a job whose output cannot be read fails with the reason instead of completing empty', async () => {
  await withEngine(async (harness) => {
    const seen: unknown[] = [];
    harness.registry.publish('job', oneJob(seen));
    const runId = await harness.launch('job');
    harness.headless.captureFails = true;
    await harness.headless.finish(1, 'lost', 0);
    await harness.settle();

    const job = jobRow(harness, runId);
    assert.equal(job.status, 'failed');
    assert.equal(job.responseText, null);
    assert.match(JSON.parse(job.resultJson!).error, /^output_unavailable: .*unreadable/);
    const [event] = seen as { results: { status: string }[] }[];
    assert.equal(event!.results[0]!.status, 'failed');
  });
});

test('a timed-out job is stopped and recorded as a timeout', async () => {
  await withEngine(async (harness) => {
    const seen: unknown[] = [];
    harness.registry.publish('job', oneJob(seen, 20));
    const runId = await harness.launch('job');
    await sleep(60);
    await harness.settle();

    assert.deepEqual(harness.headless.terminated, [1]);
    const job = jobRow(harness, runId);
    assert.equal(job.status, 'failed');
    assert.equal(JSON.parse(job.resultJson!).error, 'timeout');
    assert.equal(runRow(harness, runId).status, 'completed');
  });
});

test('a timed-out job that will not stop stays owned, and its eventual exit settles it as a timeout', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish('job', oneJob([], 20));
    harness.headless.terminateFails = true;
    const runId = await harness.launch('job');
    await sleep(60);
    await harness.settle();

    assert.equal(jobRow(harness, runId).status, 'running', 'nothing is settled while it runs');
    assert.equal(runRow(harness, runId).status, 'waiting');
    const stopFailed = harness.db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.kind, 'stop_failed'))
      .all();
    assert.equal(stopFailed.length, 1);
    assert.equal(JSON.parse(stopFailed[0]!.dataJson!).reason, 'timeout');

    await harness.headless.finish(1, 'finished late', 0);
    await harness.settle();
    const job = jobRow(harness, runId);
    assert.equal(job.status, 'failed');
    assert.equal(JSON.parse(job.resultJson!).error, 'timeout');
    assert.equal(runRow(harness, runId).status, 'completed');
  });
});

test('a failed settlement write leaves the job owned, and the next check of the wait settles it', async () => {
  await withEngine(async (harness) => {
    const seen: unknown[] = [];
    harness.registry.publish('job', oneJob(seen));
    const runId = await harness.launch('job');
    harness.failNextWrite('workflow_headless_settled');
    await harness.headless.finish(1, 'all good', 0);
    await harness.settle();
    assert.equal(jobRow(harness, runId).status, 'running', 'the write rolled back');
    assert.equal(runRow(harness, runId).status, 'waiting');

    // Any later check of the wait recovers it; here, a person pausing and resuming.
    await harness.run(harness.engine.pause(runId));
    await harness.run(harness.engine.resume(runId));
    const job = jobRow(harness, runId);
    assert.equal(job.status, 'completed');
    assert.equal(job.responseText, 'all good');
    assert.equal(runRow(harness, runId).status, 'completed');
    assert.equal(seen.length, 1);
  });
});

test('Cancel ends the run and its headless jobs in one write: a failed write changes nothing', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish('job', oneJob([]));
    const runId = await harness.launch('job');
    harness.failNextWrite('workflow_cancel');
    const failed = await harness.fail(harness.engine.cancel(runId));
    assert.ok(failed, 'the failed write reaches the caller');
    assert.equal(runRow(harness, runId).status, 'waiting');
    assert.equal(jobRow(harness, runId).status, 'running');
    assert.deepEqual(
      harness.headless.terminated,
      [],
      'nothing is stopped before the write commits',
    );

    const cancelled = await harness.run(harness.engine.cancel(runId));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(jobRow(harness, runId).status, 'interrupted');
    assert.deepEqual(harness.headless.terminated, [1]);
  });
});

test('a headless launch that returns after Cancel is stopped, and the function can start nothing new', async () => {
  await withEngine(async (harness) => {
    let secondCall: unknown = null;
    harness.registry.publish(
      'late',
      workflow(
        createGraph<{ n: number }>({
          key: 'late',
          title: 'Late',
          init: () => ({ n: 0 }),
          state: { n: reduce.replace<number>() } as never,
          entry: 'run',
          nodes: {
            run: operation(async (ctx) => {
              const job = await ctx.runHeadlessAgent({ harness: 'codex', prompt: 'First.' });
              secondCall = await ctx
                .runHeadlessAgent({ harness: 'codex', prompt: 'Second.' })
                .catch((error: unknown) => error);
              return suspend({ wait: wait.headlessAgent(job) });
            }),
          },
          edges: { out: edge({ from: 'run', to: ['done'], choose: () => ({ to: 'done' }) }) },
          outcomes: { done: outcome({ kind: 'success', output: () => null }) },
        }),
      ),
    );
    let releaseLaunch = () => {};
    harness.headless.launchGate = new Promise<void>((resolve) => (releaseLaunch = resolve));
    const { runId } = await Effect.runPromise(
      harness.engine.launch({
        workflowKey: 'late',
        inputs: {},
        origin: { worktreeId: 1, surfaceId: 1 },
      }),
    );
    while (harness.headless.started.length === 0) await sleep(5);

    // Cancel lands while the first launch is still in flight.
    await Effect.runPromise(harness.engine.cancel(runId));
    assert.deepEqual(harness.headless.terminated, [], 'nothing was tracked to stop yet');
    releaseLaunch();
    await harness.settle();

    assert.deepEqual(harness.headless.terminated, [1], 'the late process is stopped');
    assert.equal(harness.headless.started.length, 1, 'the second launch never happened');
    assert.match(String(secondCall), /was cancelled/);
    const operations = harness.db
      .select()
      .from(workflowOperations)
      .where(eq(workflowOperations.runId, runId))
      .all();
    assert.deepEqual(
      operations.map((row) => row.status),
      ['interrupted'],
    );
    assert.equal(runRow(harness, runId).status, 'cancelled');
  });
});
