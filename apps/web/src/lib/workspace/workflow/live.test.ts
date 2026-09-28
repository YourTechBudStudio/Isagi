import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import type { GetWorkflowRunOutput, WorkflowEventDto } from '@isagi/contracts';

import {
  workflowAttachedRunsQueryKey,
  workflowCheckpointListQueryKey,
  workflowEventsQueryKey,
  workflowExecutionQueryKey,
  workflowRunQueryKey,
} from '../query-keys.js';
import type { AttachedRuns } from './attached.js';
import { loadWorkflowEvents, mergeEvents, WorkflowLiveSync } from './live.js';
import {
  workflowEventFixture as event,
  workflowRunDetailFixture,
  workflowSummaryFixture,
} from './test-support.js';

/**
 * The whole live protocol: an event is appended to its run's list and names what to refetch; a
 * changed summary replaces the cached one. Nothing compares revisions.
 */

const identity = 'http://runtime.test';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const sync = new WorkflowLiveSync({ queryClient: client, runtimeIdentity: identity, delayMs: 0 });
  return { client, sync };
}

const invalidated = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryState(key)?.isInvalidated === true;

test('an event is appended to its run’s list, and the run and the execution it names are refetched', async () => {
  const { client, sync } = setup();
  client.setQueryData(workflowEventsQueryKey(identity, 1), [event({ eventId: 1 })]);
  client.setQueryData(workflowRunQueryKey(identity, 1), workflowRunDetailFixture());
  client.setQueryData(workflowExecutionQueryKey(identity, 5), { executionId: 5 });

  sync.receive({
    type: 'run_event',
    event: event({ eventId: 2, executionId: 5, kind: 'node_started' }),
  });
  sync.receive({
    type: 'run_event',
    event: event({ eventId: 3, executionId: 5, kind: 'node_waiting' }),
  });

  assert.deepEqual(
    client
      .getQueryData<readonly WorkflowEventDto[]>(workflowEventsQueryKey(identity, 1))
      ?.map((row) => row.eventId),
    [1, 2, 3],
  );
  await tick();
  assert.equal(invalidated(client, workflowRunQueryKey(identity, 1)), true);
  assert.equal(invalidated(client, workflowExecutionQueryKey(identity, 5)), true);
  sync.stop();
});

test('an event pushed while the first read is in flight is kept for that read', async () => {
  const { client, sync } = setup();
  let pushed = false;
  const read = client.fetchQuery({
    queryKey: workflowEventsQueryKey(identity, 1),
    queryFn: () =>
      loadWorkflowEvents({
        queryClient: client,
        runtimeIdentity: identity,
        runId: 1,
        list: async () => {
          if (!pushed) {
            pushed = true;
            // The read has already passed event 2 when it is pushed.
            await Promise.resolve();
            sync.receive({ type: 'run_event', event: event({ eventId: 2 }) });
          }
          return { items: [event({ eventId: 1 })], nextCursor: null };
        },
      }),
  });
  const events = await read;
  assert.deepEqual(
    events.map((row) => row.eventId),
    [1, 2],
  );
  sync.stop();
});

function failRead(client: QueryClient, queryKey: readonly unknown[], data?: unknown) {
  client
    .getQueryCache()
    .build(client, { queryKey })
    .setState({
      status: 'error',
      error: new Error('unreachable'),
      fetchStatus: 'idle',
      ...(data === undefined ? {} : { data, dataUpdatedAt: Date.now() }),
    });
}

test('a push never clears a failed event read; a full re-read is asked for instead', async () => {
  const { client, sync } = setup();
  const key = workflowEventsQueryKey(identity, 1);
  failRead(client, key, [event({ eventId: 1 })]);

  sync.receive({ type: 'run_event', event: event({ eventId: 9 }) });
  assert.equal(client.getQueryState(key)?.status, 'error');
  assert.deepEqual(
    client.getQueryData<readonly WorkflowEventDto[]>(key)?.map((row) => row.eventId),
    [1],
  );
  await tick();
  assert.equal(invalidated(client, key), true);

  // The re-read that succeeds is what clears the warning, and it keeps the pushed event.
  const events = await loadWorkflowEvents({
    queryClient: client,
    runtimeIdentity: identity,
    runId: 1,
    list: async () => ({ items: [event({ eventId: 1 }), event({ eventId: 5 })], nextCursor: null }),
  });
  assert.deepEqual(
    events.map((row) => row.eventId),
    [1, 5, 9],
  );
  sync.stop();
});

test('a pushed summary never clears a failed run read', async () => {
  const { client, sync } = setup();
  const key = workflowRunQueryKey(identity, 1);
  failRead(client, key, workflowRunDetailFixture());
  sync.receive({
    type: 'run_changed',
    summary: workflowSummaryFixture({ runId: 1, status: 'paused' }),
  });
  assert.equal(client.getQueryState(key)?.status, 'error');
  assert.equal(client.getQueryData<GetWorkflowRunOutput>(key)?.run.status, 'running');
  await tick();
  assert.equal(invalidated(client, key), true);
  sync.stop();
});

test('a captured checkpoint refetches the run’s checkpoint list', async () => {
  const { client, sync } = setup();
  client.setQueryData(workflowCheckpointListQueryKey(identity, 1), []);
  sync.receive({
    type: 'run_event',
    event: event({
      eventId: 2,
      executionId: 4,
      kind: 'checkpoint_captured',
      data: { checkpointId: 1 },
    }),
  });
  await tick();
  assert.equal(invalidated(client, workflowCheckpointListQueryKey(identity, 1)), true);
  sync.stop();
});

test('a changed summary replaces the cached one wherever it is held; the latest write wins', () => {
  const { client, sync } = setup();
  sync.receive({ type: 'snapshot', summaries: [workflowSummaryFixture({ runId: 1 })] });
  client.setQueryData(workflowRunQueryKey(identity, 1), workflowRunDetailFixture());

  sync.receive({
    type: 'run_changed',
    summary: workflowSummaryFixture({ runId: 1, status: 'paused' }),
  });
  assert.equal(
    client.getQueryData<AttachedRuns>(workflowAttachedRunsQueryKey(identity))?.[0]?.status,
    'paused',
  );
  assert.equal(
    client.getQueryData<GetWorkflowRunOutput>(workflowRunQueryKey(identity, 1))?.run.status,
    'paused',
  );

  sync.receive({
    type: 'run_changed',
    summary: workflowSummaryFixture({ runId: 1, surfaceId: null }),
  });
  assert.deepEqual(client.getQueryData<AttachedRuns>(workflowAttachedRunsQueryKey(identity)), []);
  sync.stop();
});

test('a reconnect re-reads live run data but not immutable reads', () => {
  const { client, sync } = setup();
  client.setQueryData(workflowRunQueryKey(identity, 1), workflowRunDetailFixture());
  client.setQueryData(['workflows', identity, 'structure', 1, 'sha256:x'], { artifactHash: 'x' });
  sync.receive({ type: 'connected' });
  assert.equal(invalidated(client, workflowRunQueryKey(identity, 1)), true);
  assert.equal(invalidated(client, ['workflows', identity, 'structure', 1, 'sha256:x']), false);
  sync.stop();
});

test('the event log is read from the beginning and merged with what is already held', async () => {
  const client = new QueryClient();
  const key = workflowEventsQueryKey(identity, 1);
  // Event 5 was pushed; 3 and 4 were missed while the socket was down.
  client.setQueryData(key, [event({ eventId: 1 }), event({ eventId: 2 }), event({ eventId: 5 })]);
  const cursors: (number | null)[] = [];
  const result = await loadWorkflowEvents({
    queryClient: client,
    runtimeIdentity: identity,
    runId: 1,
    list: async (cursor) => {
      cursors.push(cursor);
      return cursor === null
        ? {
            items: [event({ eventId: 1 }), event({ eventId: 2 }), event({ eventId: 3 })],
            nextCursor: 3,
          }
        : { items: [event({ eventId: 4 }), event({ eventId: 5 })], nextCursor: null };
    },
  });
  assert.deepEqual(cursors, [null, 3]);
  assert.deepEqual(
    result.map((row) => row.eventId),
    [1, 2, 3, 4, 5],
  );
});

test('merging keeps each event once, in id order', () => {
  const merged = mergeEvents(
    [event({ eventId: 1 }), event({ eventId: 3 })],
    [event({ eventId: 2 }), event({ eventId: 3 })],
  );
  assert.deepEqual(
    merged.map((row) => row.eventId),
    [1, 2, 3],
  );
});
