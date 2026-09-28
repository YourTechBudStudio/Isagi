import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import {
  workflowExecutions,
  workflowGraphInvocations,
  workflowOperations,
  workflowRuns,
} from '../../../persistence/schema.js';
import { withEngine } from '../../engine/test-support.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import { driveRun } from '../drive.js';
import { makeReviewedDocumentWorkflow } from './index.js';

/**
 * The reviewed-document fixture end to end: three graph layers, agent turns, headless judgments, a
 * user decision and authored failure outcomes, over the real engine.
 */

const publish = (harness: Parameters<Parameters<typeof withEngine>[0]>[0], variant = {}) =>
  harness.registry.publish(
    'reviewed-document',
    makeReviewedDocumentWorkflow(variant) as unknown as AnyWorkflowDefinition,
  );

test('an approved document is delivered, with every graph invocation and prompt on record', async () => {
  await withEngine(async (harness) => {
    publish(harness);
    const runId = await harness.launch('reviewed-document', { inputs: { topic: 'tides' } });
    const run = await driveRun(harness, runId, {
      reply: (prompt) => (prompt.startsWith('Review') ? 'Looks great, approve.' : 'A draft.'),
      judge: (prompt) => ({ output: prompt.includes('ready for review') ? 'ready' : 'approve' }),
    });

    assert.equal(run.status, 'completed');
    assert.equal(run.outcome?.outcomeId, 'delivered');
    const graphs = harness.db
      .select()
      .from(workflowGraphInvocations)
      .where(eq(workflowGraphInvocations.runId, runId))
      .all();
    assert.deepEqual(
      graphs.map((row) => [row.graphKey, row.depth, row.label]),
      [
        ['story', 0, null],
        ['reviewed-document', 1, 'document: tides'],
        ['review', 2, 'review round 0'],
      ],
    );
    const operations = harness.db
      .select()
      .from(workflowOperations)
      .where(eq(workflowOperations.runId, runId))
      .all();
    assert.deepEqual(
      operations.map((row) => [row.kind, row.responseText]),
      [
        ['spawn_agent', 'A draft.'],
        ['run_headless', 'ready'],
        ['spawn_agent', 'Looks great, approve.'],
        ['run_headless', 'approve'],
      ],
    );
  });
});

test('reviewers that never approve end in a person deciding, whose answer is routed on', async () => {
  await withEngine(async (harness) => {
    publish(harness);
    const runId = await harness.launch('reviewed-document', { inputs: { topic: 'tides' } });
    const run = await driveRun(harness, runId, {
      judge: (prompt) => ({ output: prompt.includes('ready for review') ? 'ready' : 'revise' }),
      answer: () => ({ decision: 'abandon' }),
    });
    assert.equal(run.status, 'completed');
    assert.equal(run.outcome?.outcomeId, 'abandoned');
    assert.equal(run.outcome?.kind, 'failure');
  });
});

test('a broken outcome discovered at the very end is fixed and retried without redoing any work', async () => {
  await withEngine(async (harness) => {
    publish(harness, { deliveredReadsMissingSummary: true });
    const runId = await harness.launch('reviewed-document', { inputs: { topic: 'tides' } });
    const world = {
      reply: (prompt: string) => (prompt.startsWith('Review') ? 'approve' : 'A draft.'),
      judge: (prompt: string) => ({
        output: prompt.includes('ready for review') ? 'ready' : 'approve',
      }),
    };
    const failed = await driveRun(harness, runId, world);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.stage, 'graph_output');
    assert.equal(failed.error?.nodeId, 'delivered');
    const spawnsBefore = harness.agents.prompts.length;
    const judgmentsBefore = harness.headless.started.length;

    publish(harness);
    await harness.run(harness.engine.retry(runId));
    const run = harness.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()!;
    assert.equal(run.status, 'completed');
    assert.equal(harness.agents.prompts.length, spawnsBefore);
    assert.equal(harness.headless.started.length, judgmentsBefore);
    const retried = harness.db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.runId, runId))
      .all()
      .filter((row) => row.retryOf !== null);
    assert.equal(retried.length, 1);
  });
});
