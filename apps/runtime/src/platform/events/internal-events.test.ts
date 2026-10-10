import assert from 'node:assert/strict';
import test from 'node:test';

import { Context, Deferred, Effect, Layer, Stream } from 'effect';

import { runScoped } from '@isagi/testing';

import { InternalEvents, type InternalEvent } from './internal-events.js';
import { tapInternalEvents } from './testing.js';

test('a subscriber receives only the event types it subscribed to, in publish order', async () => {
  const received = await runScoped(
    Effect.gen(function* () {
      const bus = yield* InternalEvents;
      const tap = yield* tapInternalEvents(['pty_process_exited', 'worktree_deleted']);
      yield* bus.publish({ type: 'agent_session_changed', agentSessionId: 9 });
      yield* bus.publish(exited(1));
      yield* bus.publish({ type: 'agent_session_changed', agentSessionId: 10 });
      yield* bus.publish({ type: 'worktree_deleted', worktreeId: 3, projectId: 4 });
      yield* bus.publish(exited(2));
      return yield* Effect.all([tap.take, tap.take, tap.take]);
    }).pipe(Effect.provide(InternalEvents.layer)),
  );

  assert.deepEqual(
    received.map((event) => event.type),
    ['pty_process_exited', 'worktree_deleted', 'pty_process_exited'],
  );
});

test('a subscription taken during layer construction sees events published before its consumer first runs', async () => {
  // The invariant every subscribing module relies on: it subscribes while its layer is built and forks the consumer,
  // and nothing published after construction is lost, even before the forked consumer has run once.
  const received: InternalEvent[] = [];
  await runScoped(
    Effect.gen(function* () {
      const twoReceived = yield* Deferred.make<void>();
      const Consumer = Layer.effectDiscard(
        Effect.gen(function* () {
          const bus = yield* InternalEvents;
          const events = yield* bus.subscribe(['pty_process_exited']);
          yield* events.pipe(
            Stream.runForEach((event) =>
              Effect.suspend(() => {
                received.push(event);
                return received.length === 2
                  ? Deferred.succeed(twoReceived, undefined)
                  : Effect.void;
              }),
            ),
            Effect.forkScoped,
          );
        }),
      );
      const context = yield* Layer.build(Consumer.pipe(Layer.provideMerge(InternalEvents.layer)));
      const bus = Context.get(context, InternalEvents);
      // Synchronously after construction: the consumer fiber has not run yet.
      yield* bus.publish(exited(1));
      yield* bus.publish(exited(2));
      yield* Deferred.await(twoReceived);
    }),
  );

  assert.deepEqual(
    received.map((event) => ('ptyProcessId' in event ? event.ptyProcessId : null)),
    [1, 2],
  );
});

test('unsubscribing stops delivery to that subscriber only', async () => {
  const result = await runScoped(
    Effect.gen(function* () {
      const bus = yield* InternalEvents;
      const leaving = yield* tapInternalEvents(['pty_process_exited']);
      const staying = yield* tapInternalEvents(['pty_process_exited']);
      yield* bus.publish(exited(1));
      const leavingFirst = yield* leaving.take;
      yield* leaving.unsubscribe;
      yield* bus.publish(exited(2));
      return { leavingFirst, staying: yield* Effect.all([staying.take, staying.take]) };
    }).pipe(Effect.provide(InternalEvents.layer)),
  );

  assert.equal(result.leavingFirst.ptyProcessId, 1);
  assert.deepEqual(
    result.staying.map((event) => event.ptyProcessId),
    [1, 2],
  );
});

function exited(ptyProcessId: number) {
  return {
    type: 'pty_process_exited',
    ptyProcessId,
    status: 'exited',
    exitCode: 0,
    signal: null,
  } satisfies InternalEvent;
}
