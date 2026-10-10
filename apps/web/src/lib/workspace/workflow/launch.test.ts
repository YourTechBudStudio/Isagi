import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { StartWorkflowInput } from '@isagi/contracts';

import type { AppRun } from '../../state/registry.js';
import { runApp } from '../../state/runtime.js';
import { makeTestRegistry } from '../../state/testing.js';
import { makeWorkflowLaunchDeps } from './launch.js';
import { workflowRunDetailFixture, workflowSummaryFixture } from './test-support.js';

test('the palette’s launch calls run against the app session, each its own runtime call', async (t) => {
  const calls: string[] = [];
  const registry = makeTestRegistry({
    api: {
      startWorkflow: (input) =>
        Effect.sync(() => {
          calls.push(`start:${input.workflowKey}`);
          return { runId: 7 } as never;
        }),
      retryWorkflow: (runId) =>
        Effect.sync(() => {
          calls.push(`retry:${runId}`);
          return { runId } as never;
        }),
      getWorkflowRun: (runId) =>
        Effect.sync(() => {
          calls.push(`read:${runId}`);
          return workflowRunDetailFixture({ run: workflowSummaryFixture({ runId }) });
        }),
    },
  });
  t.after(() => registry.dispose());
  const app: AppRun = (effect) => runApp(registry, effect);
  const deps = makeWorkflowLaunchDeps(app);

  const started = await deps.start({ workflowKey: 'review' } as StartWorkflowInput);
  await deps.retry(started.runId);
  const prepared = await deps.awaitPrepared(started.runId);

  assert.deepEqual(calls, ['start:review', 'retry:7', 'read:7']);
  assert.equal(prepared.status, 'running');
});
