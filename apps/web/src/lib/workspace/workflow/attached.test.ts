import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import { workflowAttachedRunsQueryKey } from '../query-keys.js';
import {
  AttachedRunsSync,
  attachedRunForSurface,
  detachAttached,
  replaceAttached,
  upsertAttached,
  type AttachedRuns,
} from './attached.js';
import { publishWorkflowSignal } from './signals.js';
import { workflowSummaryFixture } from './test-support.js';

const identity = 'http://runtime.test';

test('a snapshot is the baseline, so a run it omits stops occupying its surface', () => {
  const before = [onSurface(1, 101), onSurface(2, 102)];
  assert.deepEqual(
    replaceAttached([onSurface(2, 102)]).map((run) => run.runId),
    [2],
  );
  assert.equal(before.length, 2);
});

test('a snapshot drops a summary that claims no surface at all', () => {
  const detached = workflowSummaryFixture({ runId: 3, attachment: null });
  assert.deepEqual(
    replaceAttached([onSurface(1, 101), detached]).map((run) => run.runId),
    [1],
  );
});

test('an older summary cannot rewind a newer one', () => {
  const current = [onSurface(1, 101, { revision: 5, status: 'waiting' })];
  const stale = onSurface(1, 101, { revision: 4, status: 'running' });
  assert.equal(upsertAttached(current, stale)[0]?.status, 'waiting');
});

test('a run that releases its attachment leaves the list', () => {
  const current = [onSurface(1, 101)];
  const released = workflowSummaryFixture({ runId: 1, revision: 6, attachment: null });
  assert.deepEqual(upsertAttached(current, released), []);
});

test('a stale detach cannot take down the run that replaced it', () => {
  // Run 1 was dismissed and run 2 took the surface. Run 1's detach arrives late.
  const current = [onSurface(2, 101)];
  assert.deepEqual(
    detachAttached(current, { runId: 1, surfaceId: 101 }).map((run) => run.runId),
    [2],
  );
  // And a detach naming a surface this run no longer holds changes nothing either.
  assert.deepEqual(
    detachAttached(current, { runId: 2, surfaceId: 999 }).map((run) => run.runId),
    [2],
  );
  assert.deepEqual(detachAttached(current, { runId: 2, surfaceId: 101 }), []);
});

test('changes that arrive before the snapshot are replayed after it, not lost under it', () => {
  const client = new QueryClient();
  const sync = new AttachedRunsSync(client, identity);
  sync.start();

  publishWorkflowSignal({ type: 'connected' });
  // A run started while the snapshot request was in flight; the snapshot predates it.
  publishWorkflowSignal({ type: 'run_changed', summary: onSurface(9, 109, { revision: 3 }) });
  publishWorkflowSignal({ type: 'snapshot', summaries: [onSurface(1, 101)] });

  assert.deepEqual(
    read(client).map((run) => run.runId),
    [1, 9],
  );
  sync.stop();
});

test('a surface lookup finds the run the runtime says occupies it', () => {
  const runs = [onSurface(1, 101), onSurface(2, 102)];
  assert.equal(attachedRunForSurface(runs, 102)?.runId, 2);
  assert.equal(attachedRunForSurface(runs, 103), undefined);
  assert.equal(attachedRunForSurface(runs, null), undefined);
  assert.equal(attachedRunForSurface(undefined, 101), undefined);
});

function onSurface(
  runId: number,
  surfaceId: number,
  overrides: Parameters<typeof workflowSummaryFixture>[0] = {},
) {
  return workflowSummaryFixture({
    runId,
    attachment: { worktreeId: 10, surfaceId },
    ...overrides,
  });
}

function read(client: QueryClient): AttachedRuns {
  return client.getQueryData<AttachedRuns>(workflowAttachedRunsQueryKey(identity)) ?? [];
}
