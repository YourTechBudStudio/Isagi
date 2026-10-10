import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Effect } from 'effect';

import type { GetWorkflowRunOutput, WorkflowRunSummary } from '@isagi/contracts';

import { runApp } from '../../state/runtime.js';
import { controllable, flush, makeTestRegistry } from '../../state/testing.js';
import type { WorkflowSignal } from './live.js';
import { awaitPreparation } from './preparation.js';
import { receiveWorkflowSignal } from './sync.js';
import { workflowRunDetailFixture, workflowSummaryFixture } from './test-support.js';

/** A session whose `getWorkflowRun` answers each read with `read(n)` (`n` counts from 1). */
function session(t: TestContext, read: (n: number) => Effect.Effect<WorkflowRunSummary, Error>) {
  let reads = 0;
  const registry = makeTestRegistry({
    api: {
      getWorkflowRun: () =>
        Effect.suspend(() => {
          reads += 1;
          return Effect.map(
            read(reads),
            (run): GetWorkflowRunOutput => workflowRunDetailFixture({ run }),
          );
        }) as never,
    },
  });
  t.after(() => registry.dispose());
  return {
    reads: () => reads,
    wait: (runId: number) => runApp(registry, awaitPreparation(runId)),
    send: (signal: WorkflowSignal) => runApp(registry, receiveWorkflowSignal(signal)),
  };
}

test('preparation that already finished resolves from the first read', async (t) => {
  const { wait } = session(t, () =>
    Effect.succeed(workflowSummaryFixture({ runId: 1, status: 'running' })),
  );
  const summary = await wait(1);
  assert.equal(summary.status, 'running');
});

test('a run still preparing resolves on the pushed summary that leaves preparing', async (t) => {
  const { wait, send } = session(t, () =>
    Effect.succeed(workflowSummaryFixture({ runId: 1, status: 'preparing' })),
  );
  const waiting = wait(1);
  await flush();
  // Another run's change, and this run still preparing, do not settle it.
  await send({
    type: 'run_changed',
    summary: workflowSummaryFixture({ runId: 2, status: 'failed' }),
  });
  await send({
    type: 'run_changed',
    summary: workflowSummaryFixture({ runId: 1, status: 'preparing' }),
  });
  await send({
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

test('a failed read rejects, so the palette can say it could not read the run', async (t) => {
  const { wait } = session(t, () => Effect.fail(new Error('offline')));
  await assert.rejects(wait(1), /offline/);
});

test('a push that raced the first read is not missed', async (t) => {
  const first = controllable<WorkflowRunSummary, Error>();
  const { wait, send } = session(t, () => first.effect);
  const waiting = wait(1);
  await flush();
  // The run left preparing while the first read was still in flight, and that read is stale.
  await send({ type: 'run_changed', summary: workflowSummaryFixture({ runId: 1 }) });
  first.last().resolve(workflowSummaryFixture({ runId: 1, status: 'preparing' }));
  const summary = await waiting;
  assert.equal(summary.status, 'running');
});

test('after a reconnect the run is read again, since a push may have been missed', async (t) => {
  const { wait, send, reads } = session(t, (n) =>
    Effect.succeed(workflowSummaryFixture({ runId: 1, status: n === 1 ? 'preparing' : 'paused' })),
  );
  const waiting = wait(1);
  await flush();
  assert.equal(reads(), 1);
  await send({ type: 'connected' });
  const summary = await waiting;
  assert.equal(reads(), 2);
  assert.equal(summary.status, 'paused');
});
