import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import type {
  GetWorkflowRunOutput,
  ListRunExecutionsOutput,
  ListRunExecutionsQuery,
  ListWorkflowEventsOutput,
  ListWorkflowEventsQuery,
  WorkflowRunSummary,
} from '@isagi/contracts';

import { workflowRunStateQueryKey } from '../query-keys.js';
import { RunSynchronizer, type WorkflowReadPort } from './coordinator.js';
import { orderedExecutions, selectOperations, type WorkflowRunState } from './model.js';
import { publishWorkflowSignal } from './signals.js';
import {
  eventsPageFixture,
  executionsPageFixture,
  workflowDeltaFixture,
  workflowExecutionFixture,
  workflowFrameFixture,
  workflowOperationFixture,
  workflowSummaryFixture,
} from './test-support.js';

const identity = 'http://runtime.test';
const runId = 1;

test('a baseline hydrates from one coherent boundary and claims only the coverage it consumed', async () => {
  const reads = scriptedReads({
    executions: [
      executionsPageFixture({
        items: [workflowExecutionFixture({ executionId: 1, startedAt: t(1) })],
        nextCursor: 'page-2',
        highWaterRevision: 9,
        coverageRevision: 4,
        complete: false,
      }),
      executionsPageFixture({
        items: [workflowExecutionFixture({ executionId: 2, startedAt: t(2) })],
        highWaterRevision: 9,
        frames: [workflowFrameFixture({ frameId: 1 })],
        operations: [workflowOperationFixture({ operationKey: 'op-1' })],
      }),
    ],
    events: [eventsPageFixture({ highWaterRevision: 9 })],
  });

  const { state } = await hydrated(reads);

  assert.equal(state.hydrated, true);
  // The first page reported partial coverage; only the last page's watermark is claimable, and
  // claiming the partial one would have made the client skip revisions 5–9 forever.
  assert.equal(state.coverageRevision, 9);
  assert.deepEqual(
    orderedExecutions(state).map((execution) => execution.executionId),
    [1, 2],
  );
  assert.equal(state.frames.size, 1);
  assert.equal(state.operations.size, 1);
});

test('coverage lands on the lower of two watermarks, never their maximum', async () => {
  const reads = scriptedReads({
    executions: [executionsPageFixture({ highWaterRevision: 12 })],
    // The history read was taken a moment earlier and covers less. Acknowledging 12 would claim
    // transitions this client was never given.
    events: [eventsPageFixture({ highWaterRevision: 7 })],
  });

  const { state } = await hydrated(reads);
  assert.equal(state.coverageRevision, 7);
});

test('a contiguous delta is applied; a duplicate and an older one are dropped', async () => {
  const { synchronizer, client } = await started(
    scriptedReads({
      executions: [executionsPageFixture({ highWaterRevision: 5 })],
      events: [eventsPageFixture({ highWaterRevision: 5 })],
    }),
  );

  publishWorkflowSignal({
    type: 'transition',
    delta: workflowDeltaFixture({
      revision: 6,
      executions: [workflowExecutionFixture({ executionId: 1, startedAt: t(1) })],
    }),
  });
  assert.equal(read(client).coverageRevision, 6);

  publishWorkflowSignal({ type: 'transition', delta: workflowDeltaFixture({ revision: 6 }) });
  publishWorkflowSignal({ type: 'transition', delta: workflowDeltaFixture({ revision: 3 }) });
  assert.equal(read(client).coverageRevision, 6);
  assert.equal(read(client).executions.size, 1);

  synchronizer.stop();
});

test('an out-of-order delta is a gap, and recovery fills it from the last covered revision', async () => {
  const reads = scriptedReads({
    executions: [
      executionsPageFixture({ highWaterRevision: 5 }),
      executionsPageFixture({
        items: [workflowExecutionFixture({ executionId: 4, startedAt: t(4) })],
        highWaterRevision: 8,
      }),
    ],
    events: [
      eventsPageFixture({ highWaterRevision: 5 }),
      eventsPageFixture({ highWaterRevision: 8 }),
    ],
  });
  const { synchronizer, client } = await started(reads);

  // Revision 7 with coverage at 5: one revision was lost, so the delta must not be applied.
  publishWorkflowSignal({ type: 'transition', delta: workflowDeltaFixture({ revision: 7 }) });
  await settle();

  assert.equal(read(client).coverageRevision, 8);
  assert.deepEqual(reads.executionQueries[1], { limit: 100, sinceRevision: 5 });
  assert.deepEqual(
    orderedExecutions(read(client)).map((execution) => execution.executionId),
    [4],
  );
  synchronizer.stop();
});

test('deltas that arrive during a recovery are buffered and replayed in order', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = scriptedReads({
    executions: [executionsPageFixture({ highWaterRevision: 6 })],
    events: [eventsPageFixture({ highWaterRevision: 6 })],
  });
  const gated: WorkflowReadPort = {
    ...reads,
    listExecutions: async (id, query) => {
      await gate;
      return reads.listExecutions(id, query);
    },
  };

  const { synchronizer, client } = await started(gated, { skipSettle: true });
  // The baseline is in flight. Everything committed meanwhile has to survive it, in order.
  publishWorkflowSignal({
    type: 'transition',
    delta: workflowDeltaFixture({
      revision: 7,
      executions: [workflowExecutionFixture({ executionId: 7, startedAt: t(7) })],
    }),
  });
  publishWorkflowSignal({
    type: 'transition',
    delta: workflowDeltaFixture({
      revision: 8,
      executions: [workflowExecutionFixture({ executionId: 8, startedAt: t(8) })],
    }),
  });
  release();
  await settle();

  assert.equal(read(client).coverageRevision, 8);
  assert.deepEqual(
    orderedExecutions(read(client)).map((execution) => execution.executionId),
    [7, 8],
  );
  // One baseline, not one per buffered delta: buffering is what keeps a burst from becoming a
  // burst of reads.
  assert.equal(reads.executionQueries.length, 1);
  synchronizer.stop();
});

test('reconnect recovers unconditionally, and adopts a pin change missed while disconnected', async () => {
  const repinned = workflowSummaryFixture({ revision: 9, artifactHash: 'sha256:pin-2' });
  const reads = scriptedReads({
    executions: [
      executionsPageFixture({ highWaterRevision: 5 }),
      executionsPageFixture({ highWaterRevision: 9, summary: repinned }),
    ],
    events: [
      eventsPageFixture({ highWaterRevision: 5 }),
      eventsPageFixture({
        highWaterRevision: 9,
        items: [
          workflowDeltaFixture({
            revision: 9,
            transition: { kind: 'retry_pin_adopted', artifactHash: 'sha256:pin-2' },
          }),
        ],
      }),
    ],
  });
  const { synchronizer, client } = await started(reads);

  publishWorkflowSignal({ type: 'disconnected' });
  publishWorkflowSignal({ type: 'connected' });
  await settle();

  const state = read(client);
  assert.equal(state.coverageRevision, 9);
  assert.equal(state.summary?.artifactHash, 'sha256:pin-2');
  // The adoption is recovered as a fact, so a client that never saw the live event still knows the
  // structure it has cached belongs to an older pin.
  assert.deepEqual(state.pinAdoptions, [
    { revision: 9, artifactHash: 'sha256:pin-2', adoptedAt: '2026-09-15T10:00:00.000Z' },
  ]);
  synchronizer.stop();
});

test('an operation settling with no new execution still reaches the cache and its filters', async () => {
  const { synchronizer, client } = await started(
    scriptedReads({
      executions: [
        executionsPageFixture({
          items: [workflowExecutionFixture({ executionId: 1, startedAt: t(1) })],
          highWaterRevision: 5,
          operations: [workflowOperationFixture({ operationKey: 'op-1', state: 'dispatched' })],
        }),
      ],
      events: [eventsPageFixture({ highWaterRevision: 5 })],
    }),
  );

  assert.equal(selectOperations(read(client), { state: 'dispatched' }).length, 1);

  publishWorkflowSignal({
    type: 'transition',
    delta: workflowDeltaFixture({
      revision: 6,
      transition: { kind: 'operation_settled', operationKey: 'op-1' },
      operations: [workflowOperationFixture({ operationKey: 'op-1', state: 'completed' })],
    }),
  });

  const state = read(client);
  // Membership is derived, so the row leaves one filtered view and joins another with no refetch
  // and no second cache to fall out of step.
  assert.equal(selectOperations(state, { state: 'dispatched' }).length, 0);
  assert.equal(selectOperations(state, { state: 'completed' }).length, 1);
  assert.equal(state.executions.size, 1);
  synchronizer.stop();
});

test('a pushed summary may not rewind the run, and never advances delta coverage', async () => {
  const reads = scriptedReads({
    executions: [executionsPageFixture({ highWaterRevision: 5, summary: summaryAt(5) })],
    events: [eventsPageFixture({ highWaterRevision: 5 })],
  });
  const { synchronizer, client } = await started(reads);

  publishWorkflowSignal({ type: 'run_changed', summary: summaryAt(4, 'waiting') });
  assert.equal(read(client).summary?.revision, 5);

  publishWorkflowSignal({ type: 'run_changed', summary: summaryAt(11, 'waiting') });
  const state = read(client);
  assert.equal(state.summary?.revision, 11);
  // The summary is a surface-level fact. Letting it move the watermark would make the coordinator
  // skip every delta between 6 and 11 as already covered.
  assert.equal(state.coverageRevision, 5);
  synchronizer.stop();
});

test('applying a delta costs no list read', async () => {
  const reads = scriptedReads({
    executions: [executionsPageFixture({ highWaterRevision: 5 })],
    events: [eventsPageFixture({ highWaterRevision: 5 })],
  });
  const { synchronizer, client } = await started(reads);
  const before = reads.executionQueries.length + reads.eventQueries.length;

  for (let revision = 6; revision <= 20; revision += 1) {
    publishWorkflowSignal({
      type: 'transition',
      delta: workflowDeltaFixture({
        revision,
        executions: [workflowExecutionFixture({ executionId: revision, startedAt: t(revision) })],
      }),
    });
  }
  await settle();

  assert.equal(reads.executionQueries.length + reads.eventQueries.length, before);
  assert.equal(read(client).coverageRevision, 20);
  assert.equal(read(client).executions.size, 15);
  synchronizer.stop();
});

test('a stopped synchronizer ignores everything that follows', async () => {
  const { synchronizer, client } = await started(
    scriptedReads({
      executions: [executionsPageFixture({ highWaterRevision: 5 })],
      events: [eventsPageFixture({ highWaterRevision: 5 })],
    }),
  );
  synchronizer.stop();

  publishWorkflowSignal({ type: 'transition', delta: workflowDeltaFixture({ revision: 6 }) });
  await settle();
  assert.equal(read(client).coverageRevision, 5);
});

test('a run under a second runtime identity gets its own cache, and the old one cannot reach it', async () => {
  const client = new QueryClient();
  const first = scriptedReads({
    executions: [
      executionsPageFixture({
        items: [workflowExecutionFixture({ executionId: 1, startedAt: t(1) })],
        highWaterRevision: 5,
      }),
    ],
    events: [eventsPageFixture({ highWaterRevision: 5 })],
  });
  const firstSync = new RunSynchronizer({
    queryClient: client,
    runtimeIdentity: identity,
    runId,
    reads: first,
  });
  firstSync.start();
  await settle();
  // The old coordinator is disposed exactly as a runtime switch would dispose it.
  firstSync.stop();

  const otherIdentity = 'http://other-runtime.test';
  const second = scriptedReads({
    executions: [
      executionsPageFixture({
        items: [workflowExecutionFixture({ executionId: 9, startedAt: t(9) })],
        highWaterRevision: 2,
      }),
    ],
    events: [eventsPageFixture({ highWaterRevision: 2 })],
  });
  const secondSync = new RunSynchronizer({
    queryClient: client,
    runtimeIdentity: otherIdentity,
    runId,
    reads: second,
  });
  secondSync.start();
  await settle();

  // Same run id, different runtime: revisions and execution ids from one runtime mean nothing in
  // the other, so the two caches must not be the same entry.
  const carried = read(client, identity);
  const fresh = read(client, otherIdentity);
  assert.equal(carried.coverageRevision, 5);
  assert.equal(fresh.coverageRevision, 2);
  assert.deepEqual(
    orderedExecutions(fresh).map((execution) => execution.executionId),
    [9],
  );

  // A late event from the old runtime reaches no live subscriber, and cannot enter the new
  // namespace even though the run id matches.
  publishWorkflowSignal({
    type: 'transition',
    delta: workflowDeltaFixture({
      revision: 6,
      executions: [workflowExecutionFixture({ executionId: 6, startedAt: t(6) })],
    }),
  });
  await settle();
  assert.equal(read(client, identity).coverageRevision, 5);
  // The new coordinator is live, so a revision that is contiguous *for it* still applies.
  assert.equal(read(client, otherIdentity).coverageRevision, 2);

  secondSync.stop();
});

test('gap recovery restores capability names and frame output facts, not just execution rows', async () => {
  const completedFrame = workflowFrameFixture({
    frameId: 2,
    status: 'completed',
    completedAt: t(8),
    output: {
      outcomeId: 'approved',
      outcomeKind: 'success',
      outcomeReason: null,
      producedRef: { payloadRef: 'sha256:produced', byteSize: 120, mediaType: 'application/json' },
      producerArtifactHash: 'sha256:pin-1',
    },
  });
  const calledOperation = workflowOperationFixture({
    operationKey: 'op-7',
    capability: 'run_headless_agent',
    state: 'completed',
    settledAt: t(8),
  });

  const reads = scriptedReads({
    executions: [
      executionsPageFixture({ highWaterRevision: 5 }),
      executionsPageFixture({
        items: [
          workflowExecutionFixture({
            executionId: 7,
            startedAt: t(7),
            operationSummary: { count: 1, unresolved: 0, capabilities: ['run_headless_agent'] },
          }),
        ],
        highWaterRevision: 9,
        frames: [completedFrame],
        operations: [calledOperation],
      }),
    ],
    events: [
      eventsPageFixture({ highWaterRevision: 5 }),
      eventsPageFixture({ highWaterRevision: 9 }),
    ],
  });
  const { synchronizer, client } = await started(reads);

  publishWorkflowSignal({ type: 'transition', delta: workflowDeltaFixture({ revision: 8 }) });
  await settle();

  const state = read(client);
  assert.equal(state.coverageRevision, 9);
  // The capabilities a visit actually called are recorded facts, and a dock that lost them would
  // report a step that called nothing.
  assert.deepEqual(state.executions.get(7)?.operationSummary.capabilities, ['run_headless_agent']);
  assert.equal(state.operations.get('op-7')?.capability, 'run_headless_agent');
  // The frame's published output, its producing pin and its payload slot all survive, so an outcome
  // pill needs no second read.
  const output = state.frames.get(2)?.output;
  assert.equal(output?.outcomeId, 'approved');
  assert.equal(output?.producerArtifactHash, 'sha256:pin-1');
  assert.deepEqual(output?.producedRef, {
    payloadRef: 'sha256:produced',
    byteSize: 120,
    mediaType: 'application/json',
  });
  synchronizer.stop();
});

test('a client that streamed through dropped, duplicated and reordered events converges on the direct baseline', async () => {
  const rows = [1, 2, 3, 4].map((id) =>
    workflowExecutionFixture({ executionId: id, startedAt: t(id) }),
  );
  const frame = workflowFrameFixture({ frameId: 1, executionCount: 4 });
  const operation = workflowOperationFixture({ operationKey: 'op-1', state: 'completed' });
  const finalSummary = workflowSummaryFixture({ revision: 8, status: 'done', endedAt: t(8) });

  // One client reads everything directly, at the end.
  const direct = await started(
    scriptedReads({
      executions: [
        executionsPageFixture({
          items: rows,
          highWaterRevision: 8,
          frames: [frame],
          operations: [operation],
          summary: finalSummary,
        }),
      ],
      events: [eventsPageFixture({ highWaterRevision: 8 })],
    }),
  );
  await settle();
  const baseline = read(direct.client);
  direct.synchronizer.stop();

  // The other hydrates early and then survives a hostile stream: a duplicate, a reordering, and a
  // dropped revision that forces REST recovery.
  const streamed = await started(
    scriptedReads({
      executions: [
        executionsPageFixture({
          items: [rows[0]!, rows[1]!],
          highWaterRevision: 6,
          frames: [workflowFrameFixture({ frameId: 1, executionCount: 2 })],
        }),
        executionsPageFixture({
          items: rows,
          highWaterRevision: 8,
          frames: [frame],
          operations: [operation],
          summary: finalSummary,
        }),
      ],
      events: [
        eventsPageFixture({ highWaterRevision: 6 }),
        eventsPageFixture({ highWaterRevision: 8 }),
      ],
    }),
  );
  for (const delta of [
    workflowDeltaFixture({ revision: 6 }),
    workflowDeltaFixture({ revision: 7, executions: [rows[2]!] }),
    workflowDeltaFixture({ revision: 7, executions: [rows[2]!] }),
    workflowDeltaFixture({ revision: 5 }),
    // 8 never arrives as a contiguous delta — the gap is what sends this client to REST.
    workflowDeltaFixture({ revision: 10 }),
  ]) {
    publishWorkflowSignal({ type: 'transition', delta });
  }
  await settle();
  const converged = read(streamed.client);
  streamed.synchronizer.stop();

  assert.deepEqual(
    orderedExecutions(converged).map((execution) => execution.executionId),
    orderedExecutions(baseline).map((execution) => execution.executionId),
  );
  assert.deepEqual([...converged.frames.keys()], [...baseline.frames.keys()]);
  assert.deepEqual([...converged.operations.keys()], [...baseline.operations.keys()]);
  assert.deepEqual(converged.summary, baseline.summary);
  assert.equal(converged.coverageRevision, baseline.coverageRevision);
  assert.equal(converged.hydrated, baseline.hydrated);
});

test('nothing fetches a payload until somebody asks to see one', async () => {
  const payloadReads: string[] = [];
  const reads = scriptedReads({
    executions: [
      executionsPageFixture({
        items: [
          workflowExecutionFixture({
            executionId: 1,
            startedAt: t(1),
            // Every slot the dock offers is a reference, and none of them may be followed on its
            // own: opening a run must not drag its whole retained history across the wire.
            stateInRef: {
              payloadRef: 'sha256:state-in',
              byteSize: 900,
              mediaType: 'application/json',
            },
            updateRef: {
              payloadRef: 'sha256:update',
              byteSize: 900,
              mediaType: 'application/json',
            },
          }),
        ],
        highWaterRevision: 5,
        operations: [
          workflowOperationFixture({
            operationKey: 'op-1',
            requestRef: {
              payloadRef: 'sha256:prompt',
              byteSize: 40_000,
              mediaType: 'application/json',
            },
          }),
        ],
      }),
    ],
    events: [eventsPageFixture({ highWaterRevision: 5 })],
  });
  const { synchronizer, client } = await started({
    ...reads,
    // A payload read would have to go through the client boundary, and the coordinator is given no
    // way to make one. Recording here proves the assertion is about behaviour, not about a missing
    // dependency: nothing in this pass can reach a payload at all.
    getRun: (id) => {
      payloadReads.push(`run:${id}`);
      return reads.getRun(id);
    },
  });

  publishWorkflowSignal({
    type: 'transition',
    delta: workflowDeltaFixture({ revision: 6, summary: workflowSummaryFixture({ revision: 6 }) }),
  });
  await settle();

  assert.deepEqual(payloadReads, ['run:1']);
  // The list and delta traffic is exactly the baseline's: one executions batch, one events batch.
  assert.equal(reads.executionQueries.length, 1);
  assert.equal(reads.eventQueries.length, 1);
  // The references are held as references. Following one is the caller's explicit act.
  const stateInRef = read(client).executions.get(1)?.stateInRef;
  assert.ok(stateInRef && 'payloadRef' in stateInRef);
  assert.equal(stateInRef.payloadRef, 'sha256:state-in');
  synchronizer.stop();
});

test('a pass abandoned mid-flight commits nothing, and cannot overwrite what replaced it', async () => {
  const client = new QueryClient();
  const gate = deferred();
  const abandoned = scriptedReads({
    executions: [
      executionsPageFixture({
        items: [workflowExecutionFixture({ executionId: 1, startedAt: t(1) })],
        highWaterRevision: 3,
      }),
    ],
    events: [eventsPageFixture({ highWaterRevision: 3 })],
  });
  const first = new RunSynchronizer({
    queryClient: client,
    runtimeIdentity: identity,
    runId,
    reads: {
      ...abandoned,
      listExecutions: async (id, query) => {
        await gate.promise;
        return abandoned.listExecutions(id, query);
      },
    },
  });
  first.start();

  // The consumer unmounts while the baseline is still in flight.
  first.stop();

  const replacement = await started(
    scriptedReads({
      executions: [
        executionsPageFixture({
          items: [workflowExecutionFixture({ executionId: 9, startedAt: t(9) })],
          highWaterRevision: 11,
        }),
      ],
      events: [eventsPageFixture({ highWaterRevision: 11 })],
    }),
    { client },
  );

  // Only now does the abandoned pass's read resolve. Entity rows carry no revision of their own, so
  // if it were allowed to commit, nothing downstream could tell it was describing a dead world.
  gate.resolve();
  await settle();

  const state = read(client);
  assert.equal(state.coverageRevision, 11);
  assert.deepEqual(
    orderedExecutions(state).map((execution) => execution.executionId),
    [9],
  );
  replacement.synchronizer.stop();
});

test('a pass that fails midway commits nothing and records the failure', async () => {
  const client = new QueryClient();
  const failing = scriptedReads({
    executions: [executionsPageFixture({ highWaterRevision: 5 })],
    events: [eventsPageFixture({ highWaterRevision: 5 })],
  });
  const synchronizer = new RunSynchronizer({
    queryClient: client,
    runtimeIdentity: identity,
    runId,
    reads: {
      ...failing,
      // The history half fails after the executions half succeeded — the exact shape that used to
      // leave half a boundary in the cache with coverage still claiming the old revision.
      listEvents: () => Promise.reject(new Error('the runtime went away mid-pass')),
    },
  });
  synchronizer.start();
  await settle();

  const state = read(client);
  assert.equal(state.hydrated, false, 'a half-read boundary is not a baseline');
  assert.equal(state.coverageRevision, 0);
  assert.equal(state.executions.size, 0);
  // Recorded where a consumer can see it, rather than swallowed: the cache is behind the runtime
  // and anything drawing it should be able to say so.
  assert.match(String((state.recoveryError as Error).message), /went away mid-pass/);
  synchronizer.stop();
});

test('observers never see a partially applied recovery', async () => {
  const client = new QueryClient();
  const gate = deferred();
  const reads = scriptedReads({
    executions: [
      executionsPageFixture({
        items: [workflowExecutionFixture({ executionId: 1, startedAt: t(1) })],
        nextCursor: 'page-2',
        highWaterRevision: 7,
        coverageRevision: 3,
        complete: false,
      }),
      executionsPageFixture({
        items: [workflowExecutionFixture({ executionId: 2, startedAt: t(2) })],
        highWaterRevision: 7,
      }),
    ],
    events: [eventsPageFixture({ highWaterRevision: 7 })],
  });
  const synchronizer = new RunSynchronizer({
    queryClient: client,
    runtimeIdentity: identity,
    runId,
    reads: {
      ...reads,
      listExecutions: async (id, query) => {
        const page = await reads.listExecutions(id, query);
        if (reads.executionQueries.length === 1) await gate.promise;
        return page;
      },
    },
  });
  synchronizer.start();
  await settle();

  // Mid-pass: the first page has been read, the second has not. Nothing may be visible yet.
  assert.equal(client.getQueryData(workflowRunStateQueryKey(identity, runId)), undefined);

  gate.resolve();
  await settle();

  const state = read(client);
  assert.equal(state.coverageRevision, 7);
  assert.deepEqual(
    orderedExecutions(state).map((execution) => execution.executionId),
    [1, 2],
  );
  synchronizer.stop();
});

test('a remount replays a full baseline without inheriting facts the runtime no longer reports', async () => {
  const client = new QueryClient();
  const withPause = [
    workflowDeltaFixture({ revision: 2, transition: { kind: 'pause_opened', recordedAt: t(2) } }),
    workflowDeltaFixture({ revision: 3, transition: { kind: 'pause_closed', recordedAt: t(3) } }),
  ];
  const first = await started(
    scriptedReads({
      executions: [
        executionsPageFixture({
          items: [workflowExecutionFixture({ executionId: 1, startedAt: t(1) })],
          highWaterRevision: 4,
        }),
      ],
      events: [eventsPageFixture({ highWaterRevision: 4, items: withPause })],
    }),
    { client },
  );
  assert.equal(read(client).pauseIntervals.length, 1);
  first.synchronizer.stop();

  // The consumer remounts against the retained cache. The runtime now reports a run with no pause
  // at all — a Retry adopted a new pin and the old history is gone from this listing.
  const second = await started(
    scriptedReads({
      executions: [
        executionsPageFixture({
          items: [workflowExecutionFixture({ executionId: 5, startedAt: t(5) })],
          highWaterRevision: 6,
        }),
      ],
      events: [eventsPageFixture({ highWaterRevision: 6 })],
    }),
    { client },
  );

  const state = read(client);
  // A fresh baseline is what the runtime says now, not a merge with what it used to say.
  assert.deepEqual(state.pauseIntervals, []);
  assert.deepEqual(
    orderedExecutions(state).map((execution) => execution.executionId),
    [5],
  );
  second.synchronizer.stop();
});

test('a summary pushed during a pass survives the commit that follows it', async () => {
  const client = new QueryClient();
  const gate = deferred();
  const reads = scriptedReads({
    executions: [executionsPageFixture({ highWaterRevision: 5, summary: summaryAt(5) })],
    events: [eventsPageFixture({ highWaterRevision: 5 })],
  });
  const synchronizer = new RunSynchronizer({
    queryClient: client,
    runtimeIdentity: identity,
    runId,
    reads: {
      ...reads,
      listEvents: async (id, query) => {
        await gate.promise;
        return reads.listEvents(id, query);
      },
    },
  });
  synchronizer.start();
  await settle();

  // The surface bookkeeping runs ahead of the pass: the run finished while the history read was in
  // flight, so this summary is newer than anything the candidate can contain.
  publishWorkflowSignal({ type: 'run_changed', summary: summaryAt(12, 'done') });
  gate.resolve();
  await settle();

  const state = read(client);
  // The candidate replaces the whole state, so without preserving the newer summary the commit
  // would rewind it — briefly, but an authoritative cache that goes backwards at all is one an
  // observer can catch doing it.
  assert.equal(state.summary?.revision, 12);
  assert.equal(state.summary?.status, 'done');
  assert.equal(state.coverageRevision, 5);
  synchronizer.stop();
});

// --- harness -----------------------------------------------------------------

interface ScriptedReads extends WorkflowReadPort {
  readonly executionQueries: ListRunExecutionsQuery[];
  readonly eventQueries: ListWorkflowEventsQuery[];
}

/**
 * Pages are handed out in order, one per request, and the last one repeats once the script runs
 * out. A page that carries a `nextCursor` simply continues into the next entry, so a multi-page
 * batch and a second pass are written the same way.
 */
function scriptedReads(script: {
  readonly executions: readonly ListRunExecutionsOutput[];
  readonly events: readonly ListWorkflowEventsOutput[];
  readonly run?: GetWorkflowRunOutput;
}): ScriptedReads {
  const executionQueries: ListRunExecutionsQuery[] = [];
  const eventQueries: ListWorkflowEventsQuery[] = [];
  let executionIndex = 0;
  let eventIndex = 0;
  return {
    executionQueries,
    eventQueries,
    getRun: () => Promise.resolve(script.run ?? { run: workflowSummaryFixture() }),
    listExecutions: (_runId, query) => {
      executionQueries.push(query);
      const index = Math.min(executionIndex, script.executions.length - 1);
      executionIndex += 1;
      return Promise.resolve(script.executions[index]!);
    },
    listEvents: (_runId, query) => {
      eventQueries.push(query);
      const index = Math.min(eventIndex, script.events.length - 1);
      eventIndex += 1;
      return Promise.resolve(script.events[index]!);
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settleIt) => {
    resolve = settleIt;
  });
  return { promise, resolve };
}

async function started(
  reads: WorkflowReadPort,
  options: { skipSettle?: boolean; client?: QueryClient } = {},
) {
  const client = options.client ?? new QueryClient();
  const synchronizer = new RunSynchronizer({
    queryClient: client,
    runtimeIdentity: identity,
    runId,
    reads,
  });
  synchronizer.start();
  if (!options.skipSettle) await settle();
  return { synchronizer, client };
}

async function hydrated(reads: WorkflowReadPort) {
  const { synchronizer, client } = await started(reads);
  const state = read(client);
  synchronizer.stop();
  return { state };
}

function read(client: QueryClient, runtimeIdentity: string = identity): WorkflowRunState {
  const state = client.getQueryData<WorkflowRunState>(
    workflowRunStateQueryKey(runtimeIdentity, runId),
  );
  assert.ok(state, 'the coordinator should have written run state');
  return state;
}

function summaryAt(revision: number, status: WorkflowRunSummary['status'] = 'running') {
  return workflowSummaryFixture({ revision, status });
}

function t(seconds: number): string {
  return new Date(Date.UTC(2026, 8, 15, 10, 0, seconds)).toISOString();
}

/** Lets every already-resolved promise in the coordinator's chain run to completion. */
async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}
