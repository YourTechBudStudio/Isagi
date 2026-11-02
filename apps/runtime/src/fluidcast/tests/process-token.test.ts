import assert from 'node:assert/strict';
import test from 'node:test';

import { Context, type Duration, Effect, Fiber, Layer } from 'effect';

import { ProcessTokens } from '../../access/index.js';
import { LaunchEnvironment } from '../../pty-processes/index.js';
import { FluidcastStartFailed } from '../errors.js';
import { buildFluidcastModels } from '../models.js';
import { buildFluidcastSession } from '../session-factory.js';
import { FluidcastSessions } from '../sessions.service.js';
import {
  fakeBuiltSession,
  fakeSessionsLayer,
  fakeWorkerType,
  type FakeWorkerOptions,
  fluidcastConfig,
  recordingHttpClient,
  recordingWorkers,
  withLaunchEnvironment,
} from './support.js';

// One process token per SDK execution (a Fluidcast session's worker and probe): live while the
// worker can call `isagi`, released when it faults, when the session's scope closes, and when an
// interrupted build closes it.

const startInput = {
  agentSessionId: 7,
  harness: 'claude',
  cwd: '/repo',
  harnessSessionId: null,
} as const;

/** Polls `condition` until it holds, or dies after `ms`. */
const eventually = (condition: () => boolean, ms = 2_000) =>
  Effect.gen(function* () {
    for (let waited = 0; !condition(); waited += 5) {
      if (waited >= ms) return yield* Effect.die(new Error('condition never held'));
      yield* Effect.sleep('5 millis');
    }
  });

/**
 * `FluidcastSessions` over the real session factory with fake workers, so the token comes from the
 * production acquisition. `token()` reads the one the worker was given.
 */
function withRealBuilds(
  options: { readonly worker?: FakeWorkerOptions; readonly buildTimeout?: Duration.Input },
  body: (harness: {
    readonly sessions: FluidcastSessions['Service'];
    readonly tokens: ProcessTokens['Service'];
    readonly token: () => string | undefined;
  }) => Effect.Effect<void, unknown>,
) {
  const config = fluidcastConfig();
  const recording = recordingWorkers(fakeWorkerType(options.worker).worker);
  const http = recordingHttpClient();
  return withLaunchEnvironment(true, (_layer, bin) => {
    const fixture = fakeSessionsLayer({
      fakes: [],
      environment: { HOME: '/home/dev', PATH: bin },
      ...(options.buildTimeout === undefined ? {} : { buildTimeout: options.buildTimeout }),
      builder: (input) =>
        Effect.gen(function* () {
          const models = yield* buildFluidcastModels(config).pipe(Effect.provide(http.layer));
          return yield* buildFluidcastSession(input, {
            config,
            models,
            workers: recording.workers,
          });
        }),
    });
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(fixture.layer);
          yield* body({
            sessions: Context.get(context, FluidcastSessions),
            tokens: Context.get(context, ProcessTokens),
            token: () => recording.given.claude[0]?.environment?.ISAGI_RUNTIME_TOKEN,
          });
        }),
      ),
    );
  });
}

test("a session's token is live while it runs and released when it is stopped", async () => {
  await withRealBuilds({}, ({ sessions, tokens, token }) =>
    Effect.gen(function* () {
      const { fluidcastSessionId } = yield* sessions.start(startInput);
      const issued = token();
      assert.ok(issued !== undefined, 'the worker was given a token');
      assert.equal(tokens.isLive(issued), true);

      yield* sessions.stop(fluidcastSessionId);
      assert.equal(tokens.isLive(issued), false, 'closing the session scope releases it');
    }),
  );
});

test('a build that hangs past its environment and times out releases the token', async () => {
  await withRealBuilds(
    {
      // Attaching never answers: the build has its environment, then blocks.
      worker: { attachHangs: true },
      buildTimeout: '50 millis',
    },
    ({ sessions, tokens, token }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          sessions.start({ ...startInput, harnessSessionId: 'native-1' }),
        );
        assert.ok(error instanceof FluidcastStartFailed);
        assert.equal(error.reason, 'session_build_failed');
        const issued = token();
        assert.ok(issued !== undefined, 'the build reached its environment before it hung');
        assert.equal(tokens.isLive(issued), false);
      }),
  );
});

test('a build interrupted by its caller releases the token', async () => {
  await withRealBuilds(
    { worker: { attachHangs: true }, buildTimeout: '1 minute' },
    ({ sessions, tokens, token }) =>
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          sessions.start({ ...startInput, harnessSessionId: 'native-1' }),
        );
        yield* eventually(() => token() !== undefined);
        const issued = token()!;
        assert.equal(tokens.isLive(issued), true, 'live while the build runs');

        yield* Fiber.interrupt(starting);
        assert.equal(tokens.isLive(issued), false);
      }),
  );
});

test('a worker fault releases the token while the session stays stoppable', async () => {
  const fake = fakeBuiltSession();
  let issued: string | undefined;
  const fixture = fakeSessionsLayer({
    fakes: [],
    // The fake session's token, issued the way the factory issues it but never released by a
    // scope, so only the fault can release it.
    builder: (input) =>
      Effect.gen(function* () {
        const environment = yield* (yield* LaunchEnvironment).forProcess({
          _tag: 'sdk',
          executionId: input.fluidcastSessionId,
        });
        issued = environment.ISAGI_RUNTIME_TOKEN;
        return fake.built;
      }),
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(fixture.layer);
        const sessions = Context.get(context, FluidcastSessions);
        const tokens = Context.get(context, ProcessTokens);
        const { fluidcastSessionId } = yield* sessions.start(startInput);
        assert.ok(issued !== undefined);
        assert.equal(tokens.isLive(issued), true);

        fake.faultWith('ClaudeExited');
        yield* eventually(() => fixture.events.length > 0);
        assert.equal(tokens.isLive(issued), false, 'released by the time health is published');
        assert.equal(sessions.execution(fluidcastSessionId)?.worker.state, 'ended');

        // Stopping still works, and its release of the same token is a no-op.
        yield* sessions.stop(fluidcastSessionId);
        assert.equal(tokens.isLive(issued), false);
      }),
    ),
  );
});
