import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { workflowExecutions, workflowRuns } from '../../../persistence/schema.js';
import { withEngine } from '../../engine/test-support.js';
import { WorkflowEngineError } from '../../errors.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import { driveRun } from '../drive.js';
import { phaseWiseReviewWorkflow } from './index.js';

/** The phase-wise fixture, including both healing patterns, over the real engine. */

const world = {
  reply: () => 'Done.',
  judge: (prompt: string) => {
    if (prompt.startsWith('Is this phase ready')) return { output: 'ready' };
    if (prompt.startsWith('Does this review')) return { output: 'approve' };
    if (prompt.startsWith('Run the checks')) return { output: 'pass' };
    return { output: 'abc123' };
  },
};

function nodeVisits(harness: Parameters<Parameters<typeof withEngine>[0]>[0], runId: number) {
  return harness.db
    .select()
    .from(workflowExecutions)
    .where(eq(workflowExecutions.runId, runId))
    .all()
    .map((row) => row.nodeId);
}

test('two phases are implemented, reviewed, verified and committed', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'phase-wise',
      phaseWiseReviewWorkflow as unknown as AnyWorkflowDefinition,
    );
    const runId = await harness.launch('phase-wise', { inputs: { phases: 2 } });
    const run = await driveRun(harness, runId, world);
    assert.equal(run.status, 'completed');
    assert.deepEqual(run.outcome?.output, { phases: 2, commits: ['abc123', 'abc123'] });
  });
});

test('a failing check retries itself within its bound, then asks the person, then continues', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'phase-wise',
      phaseWiseReviewWorkflow as unknown as AnyWorkflowDefinition,
    );
    const runId = await harness.launch('phase-wise', { inputs: { phases: 1 } });
    let checks = 0;
    let asked = 0;
    const run = await driveRun(harness, runId, {
      ...world,
      judge: (prompt) => {
        if (!prompt.startsWith('Run the checks')) return world.judge(prompt);
        checks += 1;
        return { output: checks <= 2 ? 'fail' : 'pass' };
      },
      answer: () => {
        asked += 1;
        return undefined;
      },
    });
    assert.equal(run.status, 'completed');
    assert.equal(checks, 3, 'two bounded attempts, then one more after the person continued');
    assert.equal(asked, 1);
    assert.deepEqual(
      nodeVisits(harness, runId).filter(
        (node) => node.startsWith('verify') || node.startsWith('askAboutV'),
      ),
      ['verify', 'verify', 'askAboutVerification', 'verify'],
    );
  });
});

test('a failed implementer turn asks the person, and the turn they ran by hand is what continues it', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'phase-wise',
      phaseWiseReviewWorkflow as unknown as AnyWorkflowDefinition,
    );
    const runId = await harness.launch('phase-wise', { inputs: { phases: 1 } });
    // Pressing Continue without running a turn by hand would find the same failed turn and ask again.
    const run = await driveRun(harness, runId, {
      ...world,
      reply: (prompt) => (prompt.startsWith('Implement') ? 'fail' : 'Done.'),
      // The person continues the implementer by hand, then presses Continue.
      answer: async () => {
        await harness.agents.endTurn(1, 'Implemented by hand.');
        return undefined;
      },
    });
    assert.equal(run.status, 'completed');
    const visits = nodeVisits(harness, runId);
    assert.deepEqual(visits.slice(0, 4), [
      'phase',
      'implement',
      'askAboutImplementer',
      'recheckImplementer',
    ]);
    assert.equal(
      harness.agents.prompts.filter((prompt) => prompt.prompt.startsWith('Implement')).length,
      1,
      'no second implementer was spawned',
    );
  });
});

test('a phase count that is not a whole number refuses the launch with a readable message', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'phase-wise',
      phaseWiseReviewWorkflow as unknown as AnyWorkflowDefinition,
    );
    const refused = await harness.fail(
      harness.engine.launch({
        workflowKey: 'phase-wise',
        inputs: { phases: 'many' },
        origin: { worktreeId: 1, surfaceId: 1 },
      }),
    );
    assert.ok(refused instanceof WorkflowEngineError);
    assert.equal(refused.code, 'workflow_parse_rejected');
    assert.equal(refused.message, 'phases must be a whole number of at least 1.');
    assert.equal(harness.db.select().from(workflowRuns).all().length, 0);
  });
});
