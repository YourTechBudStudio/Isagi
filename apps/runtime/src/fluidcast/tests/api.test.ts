import assert from 'node:assert/strict';
import test from 'node:test';

import { Context, Effect, Layer } from 'effect';

import { apiBasePath } from '@isagi/contracts';

import { withListeningServer } from '../../platform/http/testing.js';
import { registerFluidcastRoutes } from '../api.js';
import type { FluidcastSessionId } from '../ids.js';
import { FluidcastSessions } from '../sessions.service.js';
import { fakeBuiltSession, fakeSessionsLayer, type FakeBuiltSession } from './support.js';

interface Served {
  readonly sessions: FluidcastSessions['Service'];
  readonly fake: FakeBuiltSession;
  readonly fluidcastSessionId: FluidcastSessionId;
  /** `<origin>/api/v1/fluidcast-sessions/<id>` for the started session. */
  readonly base: string;
}

/** Starts one fake session and serves the Fluidcast routes over a real socket. */
function serve(run: (served: Served) => Promise<void>) {
  const fake = fakeBuiltSession();
  const fixture = fakeSessionsLayer({ fakes: [fake] });
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = Context.get(yield* Layer.build(fixture.layer), FluidcastSessions);
        const { fluidcastSessionId } = yield* sessions.start({
          agentSessionId: 7,
          harness: 'codex',
          cwd: '/repo',
          harnessSessionId: null,
        });
        yield* Effect.promise(() =>
          withListeningServer(
            Layer.succeed(FluidcastSessions, sessions),
            registerFluidcastRoutes,
            (server) =>
              run({
                sessions,
                fake,
                fluidcastSessionId,
                base: `${server.origin}${apiBasePath}/fluidcast-sessions/${fluidcastSessionId}`,
              }),
          ),
        );
      }),
    ),
  );
}

/** Reads SSE `data:` payloads until `count` arrived, leaving the stream open. */
async function readEvents(body: ReadableStream<Uint8Array>, count: number) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const events = () =>
    [...text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]!) as unknown);
  while (events().length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return { events: events(), reader };
}

const postCommand = (base: string, command: unknown) =>
  fetch(`${base}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; data?: unknown } }).error;

test('the session, worker status and transcript streams carry SDK-encoded messages', () =>
  serve(async ({ base }) => {
    const events = await readEvents((await fetch(`${base}/events`)).body!, 1);
    assert.deepEqual((events.events[0] as { _tag: string })._tag, 'Snapshot');
    await events.reader.cancel();

    const status = await readEvents((await fetch(`${base}/worker/status`)).body!, 1);
    assert.deepEqual(status.events[0], {
      _tag: 'WorkerSummary',
      status: 'idle',
      sessionId: null,
    });
    await status.reader.cancel();

    const transcript = await readEvents((await fetch(`${base}/worker/transcript`)).body!, 1);
    assert.deepEqual(transcript.events[0], { _tag: 'TranscriptSnapshot', entries: [] });
    await transcript.reader.cancel();
  }));

test('stopping a session ends its open streams, and its routes then answer 404', () =>
  serve(async ({ base, sessions, fluidcastSessionId }) => {
    const open = await readEvents((await fetch(`${base}/events`)).body!, 1);
    await Effect.runPromise(sessions.stop(fluidcastSessionId));
    // The stream ends normally once the session stops.
    for (;;) if ((await open.reader.read()).done) break;

    // A stale Pause, sent for the stopped session, cannot reach any replacement.
    const pause = await postCommand(base, { _tag: 'Pause' });
    assert.equal(pause.status, 404);
    const error = await errorOf(pause);
    assert.equal(error.code, 'fluidcast_session_not_found');
    assert.deepEqual(error.data, { fluidcastSessionId });
    for (const path of ['/events', '/worker/status', '/worker/transcript', '/speech/a1']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path);
      assert.equal((await errorOf(response)).code, 'fluidcast_session_not_found', path);
    }
  }));

test('commands are decoded, applied, or refused with the SDK rejection', () =>
  serve(async ({ base, fake }) => {
    const applied = await postCommand(base, { _tag: 'Pause' });
    assert.equal(applied.status, 200);
    assert.deepEqual(((await applied.json()) as { data: unknown }).data, null);
    assert.deepEqual(fake.commands, [{ _tag: 'Pause' }]);

    const invalid = await postCommand(base, { _tag: 'Explode' });
    assert.equal(invalid.status, 400);
    assert.equal((await errorOf(invalid)).code, 'fluidcast_command_invalid');

    const rejected = await postCommand(base, { _tag: 'Start' });
    assert.equal(rejected.status, 409);
    assert.deepEqual(await errorOf(rejected).then((error) => [error.code, error.data]), [
      'fluidcast_command_rejected',
      { rejection: { _tag: 'CommandRejected', command: 'Start', phase: 'idle' } },
    ]);

    const stale = await postCommand(base, {
      _tag: 'ToolCommand',
      handle: 'h',
      executionId: 'e1',
      payload: {},
    });
    assert.equal(stale.status, 409);
    assert.deepEqual((await errorOf(stale)).data, {
      rejection: { _tag: 'ToolCommandRejected', executionId: 'e1', reason: 'stale' },
    });
    assert.equal(fake.commands.length, 1);
  }));

test('speech streams audio, or answers 404 and 502 before the first byte', () =>
  serve(async ({ base }) => {
    const audio = await fetch(`${base}/speech/a1`);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type'), 'audio/ogg');
    assert.equal(audio.headers.get('content-length'), null);
    assert.equal(await audio.text(), 'audio for a1');

    const missing = await fetch(`${base}/speech/missing`);
    assert.equal(missing.status, 404);
    assert.equal((await errorOf(missing)).code, 'fluidcast_speech_not_found');

    const broken = await fetch(`${base}/speech/broken`);
    assert.equal(broken.status, 502);
    assert.deepEqual(await errorOf(broken).then((error) => [error.code, error.data]), [
      'fluidcast_speech_failed',
      { reason: 'RequestError' },
    ]);
  }));
