import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import { Effect } from 'effect';
import { AsyncResult, type Atom, type AtomRegistry } from 'effect/reactivity';

import type { GetWorkflowRunOutput, ListWorkflowEventsOutput } from '@isagi/contracts';

import type { RuntimeApiShape } from '../../runtime/client.js';
import { runApp } from '../../state/runtime.js';
import { advance, controllable, flush, makeTestRegistry } from '../../state/testing.js';
import { mergeEvents, runtimeConnectionPhaseAtom, type WorkflowSignal } from './live.js';
import {
  attachedRunsAtom,
  workflowCheckpointListAtom,
  workflowEventsAtom,
  workflowExecutionAtom,
  workflowRunAtom,
  workflowStructureAtom,
} from './queries.js';
import { receiveWorkflowSignal } from './sync.js';
import {
  workflowEventFixture as event,
  workflowExecutionDetailFixture,
  workflowRunDetailFixture,
  workflowSummaryFixture,
} from './test-support.js';

/**
 * The whole live protocol: an event is appended to its run's list and names what to re-read, once
 * per 250 ms burst; a changed summary replaces the held one. Nothing compares revisions.
 */

/** A fake endpoint answering each call with the next scripted answer (the last one repeats). */
function scripted<Args extends readonly unknown[], A>(
  ...answers: ReadonlyArray<(...args: Args) => Effect.Effect<A, Error>>
) {
  const calls: Args[] = [];
  const endpoint = (...args: Args) =>
    Effect.suspend(() => {
      calls.push(args);
      return answers[Math.min(calls.length, answers.length) - 1]!(...args);
    });
  return { calls, endpoint: endpoint as never };
}

const ok =
  <A>(value: A) =>
  () =>
    Effect.succeed(value);
const unreachable = () => Effect.fail(new Error('unreachable'));
const page = (...ids: number[]): ListWorkflowEventsOutput => ({
  items: ids.map((eventId) => event({ eventId })),
  nextCursor: null,
});

function session(t: TestContext, api: Partial<RuntimeApiShape>) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
  t.after(() => mock.timers.reset());
  const registry = makeTestRegistry({ api });
  t.after(() => registry.dispose());
  const send = (signal: WorkflowSignal) => runApp(registry, receiveWorkflowSignal(signal));
  /** Something on screen reads this atom for the rest of the test. */
  const hold = (atom: Atom.Atom<unknown>) => t.after(registry.mount(atom));
  return { registry, send, hold };
}

/** The ids of the run's held event list (the last good one, also under a failure). */
function eventIds(registry: AtomRegistry.AtomRegistry, runId = 1): number[] {
  const held = AsyncResult.value(registry.get(workflowEventsAtom(runId)));
  if (held._tag === 'None') throw new Error('no events held');
  return held.value.map((row) => row.eventId);
}

test('an event is appended to its run’s list, and the run and the execution it names are refetched', async (t) => {
  const runs = scripted(ok(workflowRunDetailFixture()));
  const events = scripted(ok(page(1)));
  const executions = scripted(
    ok({ execution: workflowExecutionDetailFixture({ executionId: 5 }) }),
  );
  const { registry, send, hold } = session(t, {
    getWorkflowRun: runs.endpoint,
    listWorkflowEvents: events.endpoint,
    getWorkflowExecution: executions.endpoint,
  });
  hold(workflowRunAtom(1));
  hold(workflowEventsAtom(1));
  hold(workflowExecutionAtom(5));
  await flush();

  await send({
    type: 'run_event',
    event: event({ eventId: 2, executionId: 5, kind: 'node_started' }),
  });
  await send({
    type: 'run_event',
    event: event({ eventId: 3, executionId: 5, kind: 'node_waiting' }),
  });

  assert.deepEqual(eventIds(registry), [1, 2, 3]);
  await advance(250);
  assert.equal(runs.calls.length, 2, 'the run is re-read');
  assert.equal(executions.calls.length, 2, 'the execution it names is re-read');
  assert.equal(events.calls.length, 1, 'the appended list is not re-read');
});

test('events for one key within 250 ms cause one read', async (t) => {
  const runs = scripted(ok(workflowRunDetailFixture()));
  const { registry, send, hold } = session(t, {
    getWorkflowRun: runs.endpoint,
    listWorkflowEvents: scripted(ok(page(1))).endpoint,
  });
  hold(workflowRunAtom(1));
  hold(workflowEventsAtom(1));
  await flush();

  await send({ type: 'run_event', event: event({ eventId: 2 }) });
  await send({ type: 'run_event', event: event({ eventId: 3 }) });
  await advance(100);
  await send({ type: 'run_event', event: event({ eventId: 4 }) });
  assert.deepEqual(eventIds(registry), [1, 2, 3, 4], 'each event is appended at once');
  assert.equal(runs.calls.length, 1);

  await advance(150);
  assert.equal(runs.calls.length, 2, 'one trailing read, 250 ms after the first event');
  await advance(1_000);
  assert.equal(runs.calls.length, 2, 'and nothing after it');

  await send({ type: 'run_event', event: event({ eventId: 5 }) });
  await advance(250);
  assert.equal(runs.calls.length, 3, 'a later event opens a new window');
});

test('an event pushed while the first read is in flight is kept for that read', async (t) => {
  const read = controllable<ListWorkflowEventsOutput>();
  const { registry, send, hold } = session(t, { listWorkflowEvents: () => read.effect });
  hold(workflowEventsAtom(1));
  await flush();

  // The read has already passed event 2 when it is pushed.
  await send({ type: 'run_event', event: event({ eventId: 2 }) });
  read.last().resolve(page(1));
  await flush();

  assert.deepEqual(eventIds(registry), [1, 2]);
});

test('events arriving during an in-flight events read are applied after it', async (t) => {
  const reread = controllable<ListWorkflowEventsOutput>();
  const events = scripted(ok(page(1)), () => reread.effect);
  const { registry, send, hold } = session(t, { listWorkflowEvents: events.endpoint });
  hold(workflowEventsAtom(1));
  await flush();

  // A re-read is in flight (a reconnect asked for it); the held list stays on screen meanwhile.
  await send({ type: 'connected' });
  await flush();
  assert.equal(events.calls.length, 2);
  await send({ type: 'run_event', event: event({ eventId: 3 }) });
  assert.deepEqual(eventIds(registry), [1], 'not appended over a read that may already include it');

  reread.last().resolve(page(1, 2));
  await flush();
  assert.deepEqual(eventIds(registry), [1, 2, 3], 'applied after the read, not lost');
});

test('a push never clears a failed event read; a full re-read is asked for instead', async (t) => {
  const events = scripted(ok(page(1)), unreachable, ok(page(1, 5)));
  const { registry, send, hold } = session(t, { listWorkflowEvents: events.endpoint });
  hold(workflowEventsAtom(1));
  await flush();
  registry.refresh(workflowEventsAtom(1));
  await flush();
  assert.equal(registry.get(workflowEventsAtom(1))._tag, 'Failure');

  await send({ type: 'run_event', event: event({ eventId: 9 }) });
  assert.equal(registry.get(workflowEventsAtom(1))._tag, 'Failure', 'the warning stays');
  assert.deepEqual(eventIds(registry), [1], 'nothing appended to an incomplete list');

  await advance(250);
  // The re-read that succeeds is what clears the warning, and it keeps the pushed event.
  assert.equal(events.calls.length, 3);
  assert.equal(registry.get(workflowEventsAtom(1))._tag, 'Success');
  assert.deepEqual(eventIds(registry), [1, 5, 9]);
});

test('a pushed summary never clears a failed run read', async (t) => {
  const runs = scripted(
    ok(workflowRunDetailFixture()),
    unreachable,
    ok(workflowRunDetailFixture({ run: workflowSummaryFixture({ status: 'paused' }) })),
  );
  const { registry, send, hold } = session(t, { getWorkflowRun: runs.endpoint });
  hold(workflowRunAtom(1));
  await flush();
  registry.refresh(workflowRunAtom(1));
  await flush();

  await send({
    type: 'run_changed',
    summary: workflowSummaryFixture({ runId: 1, status: 'paused' }),
  });
  const failed = registry.get(workflowRunAtom(1));
  assert.equal(failed._tag, 'Failure');
  const previous = AsyncResult.value(failed);
  assert.equal(previous._tag === 'Some' ? previous.value.run.status : null, 'running');

  await advance(250);
  assert.equal(runs.calls.length, 3, 'a re-read is asked for instead');
  const reread = registry.get(workflowRunAtom(1));
  assert.equal(reread._tag === 'Success' ? reread.value.run.status : null, 'paused');
});

test('a captured checkpoint refetches the run’s checkpoint list', async (t) => {
  const lists = scripted(ok({ items: [], nextCursor: null }));
  const { send, hold } = session(t, { listWorkflowCheckpoints: lists.endpoint });
  hold(workflowCheckpointListAtom(1));
  await flush();

  await send({
    type: 'run_event',
    event: event({
      eventId: 2,
      executionId: 4,
      kind: 'checkpoint_captured',
      data: { checkpointId: 1 },
    }),
  });
  await advance(250);

  assert.equal(lists.calls.length, 2);
});

test('a changed summary replaces the cached one wherever it is held; the latest write wins', async (t) => {
  const { registry, send, hold } = session(t, {
    getWorkflowRun: scripted(ok(workflowRunDetailFixture())).endpoint,
  });
  await send({ type: 'snapshot', summaries: [workflowSummaryFixture({ runId: 1 })] });
  hold(workflowRunAtom(1));
  await flush();

  await send({
    type: 'run_changed',
    summary: workflowSummaryFixture({ runId: 1, status: 'paused' }),
  });
  assert.equal(registry.get(attachedRunsAtom)?.[0]?.status, 'paused');
  const run = registry.get(workflowRunAtom(1)) as AsyncResult.AsyncResult<GetWorkflowRunOutput>;
  assert.equal(run._tag === 'Success' ? run.value.run.status : null, 'paused');

  await send({
    type: 'run_changed',
    summary: workflowSummaryFixture({ runId: 1, surfaceId: null }),
  });
  assert.deepEqual(registry.get(attachedRunsAtom), []);
});

test('a reconnect re-reads live run data but not immutable reads', async (t) => {
  const runs = scripted(ok(workflowRunDetailFixture()));
  const structures = scripted(ok({ artifactHash: 'sha256:x' }));
  const { registry, send, hold } = session(t, {
    getWorkflowRun: runs.endpoint,
    getWorkflowStructure: structures.endpoint,
  });
  hold(workflowRunAtom(1));
  hold(workflowStructureAtom([1, 'sha256:x']));
  await flush();

  await send({ type: 'disconnected' });
  assert.equal(registry.get(runtimeConnectionPhaseAtom), 'disconnected');
  await send({ type: 'connected' });
  await flush();

  assert.equal(registry.get(runtimeConnectionPhaseAtom), 'connected');
  assert.equal(runs.calls.length, 2);
  assert.equal(structures.calls.length, 1);
});

test('an event for a run nobody holds starts no read', async (t) => {
  const runs = scripted(ok(workflowRunDetailFixture()));
  const events = scripted(ok(page(1)));
  const { send } = session(t, {
    getWorkflowRun: runs.endpoint,
    listWorkflowEvents: events.endpoint,
  });

  await send({ type: 'run_event', event: event({ eventId: 1, runId: 42 }) });
  await send({ type: 'run_changed', summary: workflowSummaryFixture({ runId: 42 }) });
  await advance(250);

  assert.equal(runs.calls.length, 0);
  assert.equal(events.calls.length, 0);
});

test('the event log is read from the beginning and merged with what is already held', async (t) => {
  const cursors: (number | null)[] = [];
  const events = scripted<[number, { readonly cursor?: number }], ListWorkflowEventsOutput>(
    ok(page(1, 2)),
    (_runId, query) => {
      cursors.push(query.cursor ?? null);
      return Effect.succeed(
        query.cursor === undefined
          ? { items: [1, 2, 3].map((eventId) => event({ eventId })), nextCursor: 3 }
          : { items: [4, 5].map((eventId) => event({ eventId })), nextCursor: null },
      );
    },
  );
  const { registry, send, hold } = session(t, { listWorkflowEvents: events.endpoint });
  hold(workflowEventsAtom(1));
  await flush();
  // Event 5 was pushed; 3 and 4 were missed while the socket was down.
  await send({ type: 'run_event', event: event({ eventId: 5 }) });
  assert.deepEqual(eventIds(registry), [1, 2, 5]);

  await send({ type: 'connected' });
  await flush();

  assert.deepEqual(cursors, [null, 3]);
  assert.deepEqual(eventIds(registry), [1, 2, 3, 4, 5]);
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
