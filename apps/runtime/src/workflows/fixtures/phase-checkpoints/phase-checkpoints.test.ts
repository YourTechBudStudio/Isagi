import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { withEngine } from '../../engine/test-support.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import { driveRun } from '../drive.js';
import { makePhaseCheckpointsWorkflow } from './index.js';

/**
 * Phase-wise work with a checkpoint after each phase and a nested seal, in a real Git repository.
 * Checkpoints do not stack: the seal copies `scratch` as it is at the end, so phase 1's draft,
 * which phase 2 deleted, is only in the phase-1 checkpoint.
 */
test('every checkpoint node records a self-contained checkpoint and the run completes', async () => {
  await withEngine(async (harness) => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: harness.worktreePath, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(harness.worktreePath, 'README.md'), 'base\n');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'base');
    const head = git('rev-parse', 'HEAD');

    harness.registry.publish(
      'phase-checkpoints',
      makePhaseCheckpointsWorkflow() as unknown as AnyWorkflowDefinition,
    );
    const runId = await harness.launch('phase-checkpoints');
    const run = await driveRun(harness, runId, {});
    assert.equal(run.status, 'completed', JSON.stringify(run.error));

    const detail = await harness.run(harness.engine.getRun(runId));
    const saved = detail.executions.filter((execution) => execution.nodeKind === 'checkpoint');
    assert.equal(saved.length, 3);
    assert.equal(new Set(saved.map((execution) => execution.invocationId)).size, 2);

    const listed = await harness.run(harness.engine.listCheckpoints(runId, {}));
    assert.deepEqual(
      listed.items.map((item) => [item.title, item.commitSha, item.scopes.map((s) => s.scope)]),
      [
        ['Phase 1 saved', head, ['phase-1', 'decisions']],
        ['Phase 2 saved', head, ['phase-2', 'decisions']],
        ['Seal', head, ['all']],
      ],
    );
    const decisions = await harness.run(
      harness.engine.listCheckpoints(runId, { scope: 'decisions' }),
    );
    assert.equal(decisions.items.length, 2);

    const files = async (checkpointId: number) =>
      (await harness.run(harness.engine.getCheckpoint(checkpointId))).checkpoint.scopes.flatMap(
        (scope) => scope.files.map((file) => file.path),
      );
    assert.deepEqual(await files(listed.items[0]!.checkpointId), [
      'scratch/phase-1/draft.md',
      'scratch/phase-1/plan.md',
      'decisions.md',
    ]);
    assert.deepEqual(await files(listed.items[2]!.checkpointId), [
      'scratch/phase-1/plan.md',
      'scratch/phase-2/plan.md',
    ]);
  });
});
