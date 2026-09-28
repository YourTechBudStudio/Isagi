import assert from 'node:assert/strict';
import test from 'node:test';

import {
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

import { workflowExecutions, workflowRuns } from '../../persistence/schema.js';
import { WorkflowEngineError } from '../errors.js';
import type { AnyWorkflowDefinition } from '../structure/loader.js';
import { withEngine, type EngineHarness } from './test-support.js';

/** Agent-turn waits through the engine: the latest-turn rule for waiting, Resume and Retry. */

const runRow = (harness: EngineHarness, runId: number) =>
  harness.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()!;
const executions = (harness: EngineHarness, runId: number) =>
  harness.db.select().from(workflowExecutions).where(eq(workflowExecutions.runId, runId)).all();

/**
 * Spawns an agent and waits for its turn. The edge fails the run on anything but an ended turn, the
 * old workaround; the latest-turn rule is what lets a Retry recover from it.
 */
function spawnAndWait(seen: NodeEvent[]): AnyWorkflowDefinition {
  return defineWorkflow({
    command: () => ({ title: 'Agent' }),
    validate: () => undefined,
    graph: createGraph<{ n: number }>({
      key: 'agent',
      title: 'Agent',
      init: () => ({ n: 0 }),
      state: { n: reduce.replace<number>() } as never,
      entry: 'write',
      nodes: {
        write: operation(async (ctx) => {
          const handle = await ctx.spawnAgentSession({ harness: 'claude', prompt: 'Write.' });
          return suspend({ wait: wait.agentTurn(handle) });
        }),
      },
      edges: {
        out: edge({
          from: 'write',
          to: ['done'],
          choose: (_state, event) => {
            seen.push(event);
            if (event.kind === 'agent_turn' && event.outcome !== 'ended') {
              throw new Error(`the agent turn ${event.outcome}`);
            }
            return { to: 'done' };
          },
        }),
      },
      outcomes: { done: outcome({ kind: 'success', output: () => null }) },
    }) as never,
  }) as unknown as AnyWorkflowDefinition;
}

test('a turn that fails, then a manual continue, is recovered by Retry taking the latest turn', async () => {
  await withEngine(async (harness) => {
    const seen: NodeEvent[] = [];
    harness.registry.publish('agent', spawnAndWait(seen));
    const runId = await harness.launch('agent');
    assert.equal(runRow(harness, runId).status, 'waiting');

    await harness.agents.failTurn(1);
    await harness.settle();
    assert.equal(runRow(harness, runId).status, 'failed');
    const [failed] = executions(harness, runId);
    assert.equal(JSON.parse(failed!.errorJson!).stage, 'edge');

    // The person continues the agent by hand; its new turn ends.
    await harness.agents.endTurn(1, 'Fixed it by hand.');
    await harness.run(harness.engine.retry(runId));

    assert.equal(runRow(harness, runId).status, 'completed');
    assert.equal(harness.agents.prompts.length, 1, 'the saved result is reused: no new spawn');
    assert.deepEqual(
      seen.map((event) => (event.kind === 'agent_turn' ? event.outcome : event.kind)),
      ['failed', 'ended'],
    );
    const retried = executions(harness, runId)[1]!;
    assert.equal(retried.retryOf, failed!.id);
  });
});

test('a turn started while the wait is open is the one followed', async () => {
  await withEngine(async (harness) => {
    const seen: NodeEvent[] = [];
    harness.registry.publish('agent', spawnAndWait(seen));
    const runId = await harness.launch('agent');
    await harness.agents.startTurn(1);
    await harness.agents.startTurn(1);
    await harness.settle();
    assert.equal(runRow(harness, runId).status, 'waiting', 'the latest turn is still running');
    await harness.agents.endTurn(1, 'second');
    await harness.settle();
    assert.equal(runRow(harness, runId).status, 'completed');
  });
});

test('Retry refuses, leaving the run failed, when the agent session cannot be observed again', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish('agent', spawnAndWait([]));
    const runId = await harness.launch('agent');
    await harness.agents.failTurn(1);
    await harness.settle();
    harness.agents.refreshFails = true;
    const refused = await harness.fail(harness.engine.retry(runId));
    assert.ok(refused instanceof WorkflowEngineError);
    assert.equal(refused.code, 'workflow_agent_observation_unavailable');
    assert.equal(runRow(harness, runId).status, 'failed');
    assert.equal(executions(harness, runId).length, 1);
  });
});
