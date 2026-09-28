import assert from 'node:assert/strict';
import test from 'node:test';

import { awaitPreparation } from './preparation.js';
import { publishWorkflowSignal } from './signals.js';
import { workflowSummaryFixture } from './test-support.js';

test('preparation that already finished resolves from the first read', async () => {
  const summary = await awaitPreparation(1, async () =>
    workflowSummaryFixture({ runId: 1, status: 'running' }),
  );
  assert.equal(summary.status, 'running');
});

test('a run still preparing resolves on the pushed summary that leaves preparing', async () => {
  const waiting = awaitPreparation(1, async () =>
    workflowSummaryFixture({ runId: 1, status: 'preparing' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Another run's change, and this run still preparing, do not settle it.
  publishWorkflowSignal({
    type: 'run_changed',
    summary: workflowSummaryFixture({ runId: 2, status: 'failed' }),
  });
  publishWorkflowSignal({
    type: 'run_changed',
    summary: workflowSummaryFixture({ runId: 1, status: 'preparing' }),
  });
  publishWorkflowSignal({
    type: 'run_changed',
    summary: workflowSummaryFixture({
      runId: 1,
      status: 'failed',
      error: { stage: 'environment', message: 'git said no' },
    }),
  });
  const summary = await waiting;
  assert.equal(summary.error?.stage, 'environment');
});

test('a failed read rejects, so the palette can say it could not read the run', async () => {
  await assert.rejects(
    awaitPreparation(1, async () => {
      throw new Error('offline');
    }),
    /offline/,
  );
});
