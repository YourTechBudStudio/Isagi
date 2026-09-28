import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { workflowExecutions } from '../../../persistence/schema.js';
import { withEngine } from '../../engine/test-support.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import { driveRun } from '../drive.js';
import { makePhaseCheckpointsWorkflow } from './index.js';

/**
 * Phase-wise work with a checkpoint after each phase and a nested seal.
 *
 * Expected to fail until checkpoints are implemented (phase 03 of the graph-workflow
 * simplification): today the first checkpoint node fails its execution with "Checkpoint nodes are
 * not implemented yet". Phase 03 captures real Git state here and extends these assertions.
 */
test('every checkpoint node records a checkpoint and the run completes', async () => {
  await withEngine(async (harness) => {
    harness.registry.publish(
      'phase-checkpoints',
      makePhaseCheckpointsWorkflow() as unknown as AnyWorkflowDefinition,
    );
    const runId = await harness.launch('phase-checkpoints');
    const run = await driveRun(harness, runId, {});
    assert.equal(run.status, 'completed', JSON.stringify(run.error));

    const checkpoints = harness.db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.runId, runId))
      .all()
      .filter((row) => row.nodeKind === 'checkpoint');
    assert.equal(checkpoints.length, 3);
    for (const row of checkpoints) assert.notEqual(row.checkpointId, null);
    const listed = await harness.run(harness.engine.getRun(runId));
    assert.equal(listed.run.status, 'completed');
  });
});
