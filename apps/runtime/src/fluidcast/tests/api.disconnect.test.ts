import assert from 'node:assert/strict';
import test from 'node:test';

import { Context, Effect, Layer, Option, Stream } from 'effect';

import { apiBasePath } from '@isagi/contracts';

import { withListeningServer } from '../../platform/http/testing.js';
import { registerFluidcastRoutes } from '../api.js';
import { buildFluidcastModels } from '../models.js';
import { buildFluidcastSession } from '../session-factory.js';
import { FluidcastSessions } from '../sessions.service.js';
import {
  fakeSessionsLayer,
  fakeWorkerType,
  fluidcastConfig,
  hangingHttpClient,
  recordingWorkers,
  withLaunchEnvironment,
} from './support.js';

// A real Harness session, so the command's own state sequence is what is under test.

test('a client that disconnects mid-command does not leave the command half applied', async () => {
  const http = hangingHttpClient(300);
  const config = fluidcastConfig();
  const workers = recordingWorkers(fakeWorkerType().worker).workers;
  await withLaunchEnvironment(true, (launchEnvironment) => {
    const fixture = fakeSessionsLayer({
      fakes: [],
      builder: (input) =>
        Effect.gen(function* () {
          const models = yield* buildFluidcastModels(config).pipe(Effect.provide(http.layer));
          return yield* buildFluidcastSession(input, { config, models, workers });
        }).pipe(Effect.provide(launchEnvironment)),
    });
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = Context.get(yield* Layer.build(fixture.layer), FluidcastSessions);
          const { fluidcastSessionId } = yield* sessions.start({
            agentSessionId: 7,
            harness: 'claude',
            cwd: '/repo',
            harnessSessionId: null,
          });
          yield* Effect.promise(() =>
            withListeningServer(
              Layer.succeed(FluidcastSessions, sessions),
              registerFluidcastRoutes,
              async (server) => {
                const base = `${server.origin}${apiBasePath}/fluidcast-sessions/${fluidcastSessionId}`;
                const send = (command: unknown, signal?: AbortSignal) =>
                  fetch(`${base}/commands`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(command),
                    ...(signal ? { signal } : {}),
                  });

                assert.equal((await send({ _tag: 'SendMessage', text: 'Hello' })).status, 200);
                await http.requested;

                // The Interrupt waits on the generation's slow cleanup; the client leaves first.
                const abort = new AbortController();
                const interrupted = send({ _tag: 'Interrupt' }, abort.signal);
                setTimeout(() => abort.abort(), 50);
                await assert.rejects(interrupted);
                await new Promise((resolve) => setTimeout(resolve, 600));

                const state = await Effect.runPromise(
                  Effect.flatMap(sessions.current(fluidcastSessionId), (live) =>
                    Effect.map(Stream.runHead(live.session.subscribe()), (message) => {
                      const first = Option.getOrThrow(message);
                      assert.equal(first._tag, 'Snapshot');
                      return (first as Extract<typeof first, { _tag: 'Snapshot' }>).state;
                    }),
                  ),
                );
                assert.notEqual(state.generation, 'running', 'the Interrupt was cut off mid-way');
              },
            ),
          );
        }),
      ),
    );
  });
});
