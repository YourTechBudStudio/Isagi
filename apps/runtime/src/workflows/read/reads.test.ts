import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  subgraph,
  suspend,
  wait,
  complete,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Schema } from 'effect';

import {
  getWorkflowExecutionOutputSchema,
  getWorkflowOperationOutputSchema,
  getWorkflowRunOutputSchema,
  getWorkflowStructureOutputSchema,
  listWorkflowEventsOutputSchema,
  listWorkflowOperationsOutputSchema,
  listWorkflowRunsOutputSchema,
  runtimeEventSchema,
} from '@isagi/contracts';

import { withEngine } from '../engine/test-support.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';

/**
 * Every read the routes serve, and every event pushed live, decodes against its wire contract.
 * The run exercises a subgraph, an agent turn, a headless job and a user wait so each DTO is filled.
 */
test('reads and live events match the wire contracts', async () => {
  await withEngine(async (harness) => {
    const inner = createGraph<{ n: number }, {}, void, number>({
      key: 'inner',
      title: 'Inner',
      init: () => ({ n: 0 }),
      state: { n: reduce.replace<number>() } as never,
      entry: 'review',
      nodes: {
        review: operation(async (ctx) => {
          const job = await ctx.runHeadlessAgent({ harness: 'codex', prompt: 'Review it.' });
          return suspend({ wait: wait.headlessAgent(job) });
        }),
      },
      edges: { out: edge({ from: 'review', to: ['ok'], choose: () => ({ to: 'ok' }) }) },
      outcomes: { ok: outcome({ kind: 'success', output: () => 1 }) },
    });
    const graph = createGraph<{ n: number }>({
      key: 'outer',
      title: 'Outer',
      init: () => ({ n: 0 }),
      state: { n: reduce.replace<number>() } as never,
      entry: 'write',
      nodes: {
        write: operation(
          async (ctx) => {
            const handle = await ctx.spawnAgentSession({ harness: 'claude', prompt: 'Write.' });
            return suspend({ wait: wait.agentTurn(handle) });
          },
          { label: () => 'Write the draft' },
        ),
        check: subgraph({ graph: inner, parameters: () => undefined, onResult: () => ({}) }),
        confirm: operation(async () => suspend({ wait: wait.userContinue('Looks good?') })),
        close: operation(async () => complete()),
      },
      edges: {
        a: edge({ from: 'write', to: ['check'], choose: () => ({ to: 'check' }) }),
        b: edge({ from: 'check', to: ['confirm'], choose: () => ({ to: 'confirm' }) }),
        c: edge({ from: 'confirm', to: ['close'], choose: () => ({ to: 'close' }) }),
        d: edge({ from: 'close', to: ['done'], choose: () => ({ to: 'done' }) }),
      },
      outcomes: { done: outcome({ kind: 'success', output: () => ({ ok: true }) }) },
    });
    harness.registry.publish(
      'contracts',
      defineWorkflow({
        command: () => ({ title: 'Contracts' }),
        validate: () => undefined,
        graph: graph as never,
      }) as unknown as AnyWorkflowDefinition,
    );
    const runId = await harness.launch('contracts', { inputs: { topic: 'x' } });
    await harness.agents.endTurn(1, 'Draft.');
    await harness.settle();
    await harness.headless.finish(1, 'Fine.');
    await harness.settle();

    const waiting = await harness.run(harness.engine.getRun(runId));
    Schema.decodeUnknownSync(getWorkflowRunOutputSchema)(waiting);
    assert.equal(waiting.run.current?.wait?.kind, 'user_continue');
    await harness.run(
      harness.engine.advance({ runId, executionId: waiting.run.current!.executionId }),
    );

    const detail = await harness.run(harness.engine.getRun(runId));
    Schema.decodeUnknownSync(getWorkflowRunOutputSchema)(detail);
    assert.equal(detail.run.status, 'completed');
    assert.equal(detail.executions[0]?.label, 'Write the draft');
    Schema.decodeUnknownSync(listWorkflowRunsOutputSchema)(
      await harness.run(harness.engine.listRuns({})),
    );
    Schema.decodeUnknownSync(getWorkflowStructureOutputSchema)(
      await harness.run(harness.engine.getStructure(runId)),
    );
    const events = await harness.run(harness.engine.listEvents(runId, { limit: 3 }));
    Schema.decodeUnknownSync(listWorkflowEventsOutputSchema)(events);
    assert.equal(events.items.length, 3);
    assert.equal(events.nextCursor, events.items[2]?.eventId);
    const rest = await harness.run(
      harness.engine.listEvents(runId, { cursor: events.nextCursor ?? undefined }),
    );
    assert.equal(rest.items[0]?.eventId, (events.nextCursor ?? 0) + 1);
    assert.equal(rest.nextCursor, null);

    const operations = await harness.run(harness.engine.listOperations(runId, {}));
    Schema.decodeUnknownSync(listWorkflowOperationsOutputSchema)(operations);
    assert.deepEqual(
      operations.items.map((item) => [item.kind, item.responseText]),
      [
        ['spawn_agent', 'Draft.'],
        ['run_headless', 'Fine.'],
      ],
    );
    Schema.decodeUnknownSync(getWorkflowOperationOutputSchema)(
      await harness.run(harness.engine.getOperation(operations.items[0]!.operationId)),
    );
    for (const execution of detail.executions) {
      Schema.decodeUnknownSync(getWorkflowExecutionOutputSchema)(
        await harness.run(harness.engine.getExecution(execution.executionId)),
      );
    }
    for (const event of harness.events) Schema.decodeUnknownSync(runtimeEventSchema)(event);
  });
});
