import assert from 'node:assert/strict';
import test from 'node:test';

import { SkillsUnavailable } from '@yourtechbudstudio/fluidcast-tool-agent/schema';
import { Effect } from 'effect';

import { readEvents, serveFakeSession } from './support.js';

const postCommand = (base: string, command: unknown) =>
  fetch(`${base}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; data?: unknown } }).error;

test('the session, worker status and transcript streams carry SDK-encoded messages', () =>
  serveFakeSession(async ({ base }) => {
    const events = await readEvents((await fetch(`${base}/events`)).body!, 1);
    assert.deepEqual((events.events[0] as { _tag: string })._tag, 'Snapshot');
    await events.reader.cancel();

    const status = await readEvents((await fetch(`${base}/worker/status`)).body!, 1);
    assert.deepEqual(status.events[0], {
      _tag: 'WorkerSummary',
      status: 'idle',
      sessionId: null,
      backgroundTasks: 0,
    });
    await status.reader.cancel();

    const transcript = await readEvents((await fetch(`${base}/worker/transcript`)).body!, 1);
    assert.deepEqual(transcript.events[0], { _tag: 'TranscriptSnapshot', entries: [] });
    await transcript.reader.cancel();
  }));

test('stopping a session ends its open streams, and its routes then answer 404', () =>
  serveFakeSession(async ({ base, sessions, fluidcastSessionId }) => {
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
    for (const path of [
      '/events',
      '/worker/status',
      '/worker/transcript',
      '/worker/skills',
      '/speech/a1',
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path);
      assert.equal((await errorOf(response)).code, 'fluidcast_session_not_found', path);
    }
  }));

test('commands are decoded, applied, or refused with the SDK rejection', () =>
  serveFakeSession(async ({ base, fake }) => {
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
  serveFakeSession(async ({ base }) => {
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

test('worker skills are served SDK-encoded, or refused with why they are unavailable', () =>
  serveFakeSession(async ({ base, fake }) => {
    fake.listSkillsWith(
      Effect.succeed([
        { name: 'review', description: 'Review the diff', argumentHint: '[level]' },
        { name: 'plan', description: 'Plan the change' },
      ]),
    );
    const listed = await fetch(`${base}/worker/skills`);
    assert.equal(listed.status, 200);
    assert.deepEqual(((await listed.json()) as { data: unknown }).data, [
      { name: 'review', description: 'Review the diff', argumentHint: '[level]' },
      { name: 'plan', description: 'Plan the change' },
    ]);

    for (const reason of ['Failed', 'TimedOut'] as const) {
      fake.listSkillsWith(Effect.fail(new SkillsUnavailable({ reason })));
      const unavailable = await fetch(`${base}/worker/skills`);
      assert.equal(unavailable.status, 502, reason);
      assert.deepEqual(await errorOf(unavailable).then((error) => [error.code, error.data]), [
        'fluidcast_skills_unavailable',
        { reason },
      ]);
    }
  }));

test('worker skills answer 404 for an unknown session and for one stopped mid-listing', () =>
  serveFakeSession(async ({ base, fake, sessions, fluidcastSessionId }) => {
    const unknown = await fetch(`${base.replace(fluidcastSessionId, 'fc-unknown')}/worker/skills`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await errorOf(unknown).then((error) => [error.code, error.data]), [
      'fluidcast_session_not_found',
      { fluidcastSessionId: 'fc-unknown' },
    ]);

    let markListing: () => void = () => {};
    const listing = new Promise<void>((resolve) => (markListing = resolve));
    fake.listSkillsWith(Effect.andThen(Effect.sync(markListing), Effect.never));
    const pending = fetch(`${base}/worker/skills`);
    await listing;
    await Effect.runPromise(sessions.stop(fluidcastSessionId));
    const stopped = await pending;
    assert.equal(stopped.status, 404);
    assert.deepEqual(await errorOf(stopped).then((error) => [error.code, error.data]), [
      'fluidcast_session_not_found',
      { fluidcastSessionId },
    ]);
  }));
