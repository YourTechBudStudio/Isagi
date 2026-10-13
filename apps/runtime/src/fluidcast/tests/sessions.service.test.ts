import assert from 'node:assert/strict';
import test from 'node:test';

import { Context, Effect, Exit, Fiber, Layer, Scope } from 'effect';

import { makeLogCapture } from '../../../test/test-support.js';
import {
  FluidcastSessionNotFound,
  FluidcastSessionUnreadable,
  FluidcastUnavailable,
} from '../errors.js';
import type { FluidcastSessionId } from '../ids.js';
import { FluidcastSessions } from '../sessions.service.js';
import { fakeBuiltSession, fakeSessionsLayer, fluidcastConfig } from './support.js';

const startInput = {
  agentSessionId: 7,
  harness: 'claude',
  cwd: '/repo',
  harnessSessionId: null,
} as const;

interface Harness {
  readonly sessions: FluidcastSessions['Service'];
  readonly fixture: ReturnType<typeof fakeSessionsLayer>;
  readonly logs: ReturnType<typeof makeLogCapture>['lines'];
}

/** Runs `body` against `FluidcastSessions` over the given fakes, with logs captured. */
function withSessions<A, E>(
  options: Parameters<typeof fakeSessionsLayer>[0],
  body: (harness: Harness) => Effect.Effect<A, E>,
) {
  const fixture = fakeSessionsLayer(options);
  const capture = makeLogCapture();
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(fixture.layer), (context) =>
        body({ sessions: Context.get(context, FluidcastSessions), fixture, logs: capture.lines }),
      ),
    ).pipe(Effect.provide(capture.layer)),
  );
}

/** Polls `condition` until it holds, or dies after `ms`. */
const eventually = (condition: () => boolean, ms = 2_000) =>
  Effect.gen(function* () {
    for (let waited = 0; !condition(); waited += 5) {
      if (waited >= ms) return yield* Effect.die(new Error('condition never held'));
      yield* Effect.sleep('5 millis');
    }
  });

test('a new session records the native ID its worker reports', async () => {
  const fake = fakeBuiltSession();
  await withSessions({ fakes: [fake] }, ({ sessions, fixture }) =>
    Effect.gen(function* () {
      yield* sessions.start(startInput);
      fake.reportNativeId('native-9');
      yield* eventually(() => fixture.writes.length > 0);
      assert.deepEqual(fixture.writes, [{ agentSessionId: 7, harnessSessionId: 'native-9' }]);
    }),
  );
});

test('a resumed session does not rewrite its native ID', async () => {
  const fake = fakeBuiltSession();
  await withSessions({ fakes: [fake] }, ({ sessions, fixture }) =>
    Effect.gen(function* () {
      yield* sessions.start({ ...startInput, harnessSessionId: 'native-1' });
      fake.reportNativeId('native-1');
      yield* Effect.sleep('30 millis');
      assert.deepEqual(fixture.writes, []);
    }),
  );
});

test('a failed native-ID write is a warning and leaves the session live', async () => {
  const fake = fakeBuiltSession();
  await withSessions({ fakes: [fake], writeFails: true }, ({ sessions, logs }) =>
    Effect.gen(function* () {
      const { fluidcastSessionId } = yield* sessions.start(startInput);
      fake.reportNativeId('native-9');
      yield* eventually(() =>
        logs.some(
          (line) =>
            line.level === 'Warn' && line.message.includes('native session id not recorded'),
        ),
      );
      assert.equal(sessions.execution(fluidcastSessionId)?.worker.state, 'live');
    }),
  );
});

test('stop returns the final native ID, including one reported just before the stop', async () => {
  const fresh = fakeBuiltSession();
  const resumed = fakeBuiltSession();
  const silent = fakeBuiltSession();
  await withSessions({ fakes: [fresh, resumed, silent] }, ({ sessions }) =>
    Effect.gen(function* () {
      const never = yield* sessions.start(startInput);
      assert.deepEqual(yield* sessions.stop(never.fluidcastSessionId), { harnessSessionId: null });

      const known = yield* sessions.start({ ...startInput, harnessSessionId: 'native-1' });
      resumed.reportNativeIdSilently('native-1');
      assert.deepEqual(yield* sessions.stop(known.fluidcastSessionId), {
        harnessSessionId: 'native-1',
      });

      // Reported to the worker, but its status (and so the native-ID fiber) has not caught up.
      const late = yield* sessions.start(startInput);
      silent.reportNativeIdSilently('native-late');
      assert.deepEqual(yield* sessions.stop(late.fluidcastSessionId), {
        harnessSessionId: 'native-late',
      });
    }),
  );
});

test('a worker fault ends the execution and publishes a health change', async () => {
  const fake = fakeBuiltSession();
  await withSessions({ fakes: [fake] }, ({ sessions, fixture, logs }) =>
    Effect.gen(function* () {
      const { fluidcastSessionId, since } = yield* sessions.start(startInput);
      assert.deepEqual(sessions.execution(fluidcastSessionId), {
        since,
        worker: { state: 'live' },
      });
      fake.faultWith('ClaudeExited');
      yield* eventually(() => fixture.events.length > 0);
      assert.deepEqual(sessions.execution(fluidcastSessionId), {
        since,
        worker: { state: 'ended', reason: 'ClaudeExited' },
      });
      assert.deepEqual(fixture.events, [
        { type: 'agent_session_execution_changed', agentSessionId: 7, change: { _tag: 'health' } },
      ]);
      assert.ok(
        logs.some(
          (line) =>
            line.message.includes('fluidcast worker faulted') &&
            line.annotations.reason === 'ClaudeExited',
        ),
      );
      // The session itself stays until it is stopped.
      assert.ok(Exit.isSuccess(yield* Effect.exit(sessions.current(fluidcastSessionId))));
    }),
  );
});

test('stop ends the session streams, closes its scope and forgets it', async () => {
  const fake = fakeBuiltSession();
  await withSessions({ fakes: [fake] }, ({ sessions }) =>
    Effect.gen(function* () {
      const { fluidcastSessionId } = yield* sessions.start(startInput);
      const live = yield* sessions.current(fluidcastSessionId);
      const waiting = yield* Effect.forkChild(live.ended);
      assert.equal(fake.state.closed, false);

      yield* sessions.stop(fluidcastSessionId);

      yield* Fiber.join(waiting);
      assert.equal(fake.state.closed, true);
      assert.equal(sessions.execution(fluidcastSessionId), undefined);
      const after = yield* Effect.flip(sessions.current(fluidcastSessionId));
      assert.ok(after instanceof FluidcastSessionNotFound);
      // Stopping again is a no-op.
      assert.deepEqual(yield* sessions.stop(fluidcastSessionId), { harnessSessionId: null });
    }),
  );
});

test('an unknown session is not found', async () => {
  await withSessions({ fakes: [] }, ({ sessions }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(sessions.current('nope'));
      assert.ok(error instanceof FluidcastSessionNotFound);
      assert.equal(error.fluidcastSessionId, 'nope');
      assert.equal(sessions.execution('nope' as FluidcastSessionId), undefined);
    }),
  );
});

test('two sessions are independent', async () => {
  const first = fakeBuiltSession();
  const second = fakeBuiltSession();
  await withSessions({ fakes: [first, second] }, ({ sessions }) =>
    Effect.gen(function* () {
      const a = yield* sessions.start(startInput);
      const b = yield* sessions.start({ ...startInput, agentSessionId: 8 });
      assert.notEqual(a.fluidcastSessionId, b.fluidcastSessionId);

      first.faultWith('ClaudeExited');
      yield* eventually(() => sessions.execution(a.fluidcastSessionId)?.worker.state === 'ended');
      assert.equal(sessions.execution(b.fluidcastSessionId)?.worker.state, 'live');

      yield* sessions.stop(a.fluidcastSessionId);
      assert.equal(first.state.closed, true);
      assert.equal(second.state.closed, false);
      const live = yield* sessions.current(b.fluidcastSessionId);
      assert.equal(live.agentSessionId, 8);
    }),
  );
});

test('a disabled or invalid section refuses to start', async () => {
  for (const [state, reason] of [
    [{ status: 'disabled' }, 'disabled'],
    [{ status: 'invalid', issuePaths: ['fluidcast.speech'] }, 'invalid_config'],
  ] as const) {
    await withSessions({ fakes: [fakeBuiltSession()], state }, ({ sessions, fixture }) =>
      Effect.gen(function* () {
        assert.equal(sessions.availability, state.status);
        const error = yield* Effect.flip(sessions.start(startInput));
        assert.ok(error instanceof FluidcastUnavailable);
        assert.equal(error.reason, reason);
        assert.equal(fixture.built.length, 0);
      }),
    );
  }
  await withSessions(
    { fakes: [], state: { status: 'ready', config: fluidcastConfig() } },
    ({ sessions }) => Effect.sync(() => assert.equal(sessions.availability, 'ready')),
  );
});

test('a failed start leaves no session behind', async () => {
  await withSessions({ fakes: ['unreadable'] }, ({ sessions, fixture, logs }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(sessions.start(startInput));
      assert.ok(error instanceof FluidcastSessionUnreadable);
      const [built] = fixture.built;
      assert.ok(built);
      const missing = yield* Effect.flip(sessions.current(built.fluidcastSessionId));
      assert.ok(missing instanceof FluidcastSessionNotFound);
      assert.ok(logs.some((line) => line.message.includes('fluidcast session start failed')));
    }),
  );
});

test('shutting down the layer closes every session', async () => {
  const fake = fakeBuiltSession();
  const fixture = fakeSessionsLayer({ fakes: [fake] });
  let ended = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(fixture.layer, scope);
      const sessions = Context.get(context, FluidcastSessions);
      const { fluidcastSessionId } = yield* sessions.start(startInput);
      const live = yield* sessions.current(fluidcastSessionId);
      const waiting = yield* Effect.forkDetach(
        Effect.tap(live.ended, () => Effect.sync(() => (ended = true))),
      );
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.join(waiting);
    }),
  );
  assert.equal(fake.state.closed, true);
  assert.equal(ended, true);
});

test("a command outlives its caller's interruption, and ends with the session", async () => {
  const fake = fakeBuiltSession();
  await withSessions({ fakes: [fake] }, ({ sessions }) =>
    Effect.gen(function* () {
      const { fluidcastSessionId } = yield* sessions.start(startInput);
      const live = yield* sessions.current(fluidcastSessionId);

      // A disconnecting client: the caller is interrupted, the command keeps running.
      const caller = yield* Effect.forkChild(live.command({ _tag: 'Next' }));
      yield* eventually(() => fake.state.commandStarted);
      yield* Fiber.interrupt(caller);
      yield* Effect.sleep('20 millis');
      assert.equal(fake.state.commandInterrupted, false);

      // Stopping the session interrupts the command, and a waiting caller learns the session is gone.
      const waiting = yield* Effect.forkChild(Effect.flip(live.command({ _tag: 'Next' })));
      yield* Effect.sleep('10 millis');
      yield* sessions.stop(fluidcastSessionId);
      assert.equal(fake.state.commandInterrupted, true);
      assert.ok((yield* Fiber.join(waiting)) instanceof FluidcastSessionNotFound);
    }),
  );
});

test('shutting down the layer interrupts a running command', async () => {
  const fake = fakeBuiltSession();
  const fixture = fakeSessionsLayer({ fakes: [fake] });
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(fixture.layer, scope);
      const sessions = Context.get(context, FluidcastSessions);
      const { fluidcastSessionId } = yield* sessions.start(startInput);
      const live = yield* sessions.current(fluidcastSessionId);
      const caller = yield* Effect.forkDetach(Effect.exit(live.command({ _tag: 'Next' })));
      yield* eventually(() => fake.state.commandStarted);
      yield* Scope.close(scope, Exit.void);
      assert.equal(fake.state.commandInterrupted, true);
      yield* Fiber.join(caller);
    }),
  );
});
