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
  serveFakeSession,
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

/** An SSE body's `data:` payloads, read on demand from one open connection. */
function sseEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let taken = 0;
  return {
    reader,
    /** The next `data:` payload, or `undefined` once the stream has ended. */
    next: async (): Promise<unknown> => {
      for (;;) {
        const events = [...text.matchAll(/^data: (.*)$/gm)];
        if (events.length > taken) return JSON.parse(events[taken++]![1]!) as unknown;
        const { value, done } = await reader.read();
        if (done) return undefined;
        text += decoder.decode(value, { stream: true });
      }
    },
  };
}

const until = async (condition: () => boolean) => {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited >= 2_000) throw new Error('the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// The player keeps both worker streams open for its whole instance, not only while it shows the
// Worker layer.
test('worker status and transcript streams stay open together until their client or the session ends', () =>
  serveFakeSession(async ({ base, fake, sessions, fluidcastSessionId }) => {
    const status = sseEvents((await fetch(`${base}/worker/status`)).body!);
    const transcript = sseEvents((await fetch(`${base}/worker/transcript`)).body!);
    assert.equal(((await status.next()) as { status: string }).status, 'idle');
    assert.equal(((await transcript.next()) as { _tag: string })._tag, 'TranscriptSnapshot');

    // Both keep receiving updates while open together.
    fake.reportNativeId('native-1');
    fake.appendTranscript({
      _tag: 'TranscriptAppended',
      entries: [{ _tag: 'text', text: 'Working on it.', parentToolUseId: null }],
    });
    assert.equal(((await status.next()) as { sessionId: string }).sessionId, 'native-1');
    assert.equal(((await transcript.next()) as { _tag: string })._tag, 'TranscriptAppended');

    // A second status client that disconnects releases only its own subscription.
    const other = sseEvents((await fetch(`${base}/worker/status`)).body!);
    await other.next();
    assert.equal(fake.state.open.status, 2);
    await other.reader.cancel();
    await until(() => fake.state.open.status === 1);
    fake.reportNativeId('native-2');
    assert.equal(((await status.next()) as { sessionId: string }).sessionId, 'native-2');
    assert.equal(fake.state.open.transcript, 1);

    // Stopping the session ends both streams normally and releases their subscriptions.
    await Effect.runPromise(sessions.stop(fluidcastSessionId));
    assert.equal(await status.next(), undefined);
    assert.equal(await transcript.next(), undefined);
    await until(() => fake.state.open.status === 0 && fake.state.open.transcript === 0);
  }));
