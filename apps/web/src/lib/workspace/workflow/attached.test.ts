import assert from 'node:assert/strict';
import test from 'node:test';

import { attachedRunForSurface, replaceAttached, upsertAttached } from './attached.js';
import { workflowSummaryFixture } from './test-support.js';

test('the snapshot replaces the list, keeping only runs that occupy a surface', () => {
  const runs = replaceAttached([
    workflowSummaryFixture({ runId: 1, surfaceId: 101 }),
    workflowSummaryFixture({ runId: 2, surfaceId: null }),
  ]);
  assert.deepEqual(
    runs.map((run) => run.runId),
    [1],
  );
  assert.equal(attachedRunForSurface(runs, 101)?.runId, 1);
});

test('the latest summary wins, and a dismissed run leaves the list', () => {
  const initial = [workflowSummaryFixture({ runId: 1, status: 'running' })];
  const updated = upsertAttached(initial, workflowSummaryFixture({ runId: 1, status: 'failed' }));
  assert.equal(updated[0]?.status, 'failed');
  assert.deepEqual(
    upsertAttached(updated, workflowSummaryFixture({ runId: 1, surfaceId: null })),
    [],
  );
  // A detached summary for a run nobody held changes nothing.
  assert.equal(
    upsertAttached(updated, workflowSummaryFixture({ runId: 2, surfaceId: null })),
    updated,
  );
});
