import assert from 'node:assert/strict';
import test from 'node:test';

import { TransportError, type Transport } from '@yourtechbudstudio/fluidcast-client';
import { SpeechError } from '@yourtechbudstudio/fluidcast-core/speech';
import {
  CommandRejected,
  SpeechNotFound,
  ToolCommandRejected,
} from '@yourtechbudstudio/fluidcast-harness/protocol';
import type { WorkerFeed } from '@yourtechbudstudio/fluidcast-react';
import { Deferred, Effect, Layer, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { RuntimeClient } from '@isagi/runtime-client';

import { fluidcastTransport, fluidcastWorkerStreams } from './transport.js';

const runtimeUrl = 'http://runtime.test';
const fluidcastSessionId = 'fc-1';

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

function fakeRuntime(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const entry: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      body:
        typeof init?.body === 'string'
          ? init.body
          : init?.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : undefined,
    };
    seen.push(entry);
    return answer(entry);
  };
  const layer = RuntimeClient.layer(runtimeUrl).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  const run = <A, E>(
    use: (transport: Transport['Service'], worker: WorkerFeed['Service']) => Effect.Effect<A, E>,
    beforeSubscribe: Effect.Effect<void> = Effect.void,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* fluidcastTransport({ fluidcastSessionId, beforeSubscribe });
        const worker = yield* fluidcastWorkerStreams({ fluidcastSessionId });
        return yield* use(transport, worker);
      }).pipe(Effect.provide(layer)),
    );
  return { seen, run };
}

const envelope = (code: string, status: number, data?: unknown) =>
  new Response(
    JSON.stringify({
      error: {
        code,
        status,
        message: 'x',
        requestId: 'r',
        ...(data === undefined ? {} : { data }),
      },
    }),
    { status },
  );

const sse = (...values: readonly unknown[]) =>
  new Response(
    `: open\n\n${values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')}`,
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );

const sendPause = (transport: Transport['Service']) =>
  transport.send({ _tag: 'Pause' }).pipe(Effect.flip);

test('send posts the encoded command to its session', async () => {
  const runtime = fakeRuntime(
    () => new Response(JSON.stringify({ data: null, meta: { requestId: 'r' } }), { status: 200 }),
  );

  await runtime.run((transport) => transport.send({ _tag: 'Pause' }));

  assert.equal(runtime.seen[0]?.method, 'POST');
  assert.equal(runtime.seen[0]?.url, `${runtimeUrl}/api/v1/fluidcast-sessions/fc-1/commands`);
  assert.deepEqual(JSON.parse(runtime.seen[0]?.body ?? ''), { _tag: 'Pause' });
});

test('a rejected command comes back as the SDK rejection it carries', async () => {
  const runtime = fakeRuntime(() =>
    envelope('fluidcast_command_rejected', 409, {
      rejection: { _tag: 'CommandRejected', command: 'Pause', phase: 'idle' },
    }),
  );

  const error = await runtime.run(sendPause);

  assert.ok(error instanceof CommandRejected);
  assert.equal(error.command, 'Pause');
});

test('a rejected tool command comes back as ToolCommandRejected', async () => {
  const runtime = fakeRuntime(() =>
    envelope('fluidcast_command_rejected', 409, {
      rejection: { _tag: 'ToolCommandRejected', executionId: 'e', reason: 'stale' },
    }),
  );

  assert.ok((await runtime.run(sendPause)) instanceof ToolCommandRejected);
});

test('a rejection that is not an SDK rejection is a malformed reply', async () => {
  const runtime = fakeRuntime(() =>
    envelope('fluidcast_command_rejected', 409, { rejection: { _tag: 'Nope' } }),
  );

  const error = await runtime.run(sendPause);

  assert.ok(error instanceof TransportError);
  assert.equal(error.reason, 'Malformed');
});

const statusCases = [
  [
    'a stopped or replaced session',
    envelope('fluidcast_session_not_found', 404, { fluidcastSessionId }),
    'BadRequest',
    404,
  ],
  ['an invalid command', envelope('fluidcast_command_invalid', 400), 'BadRequest', 400],
  ['a runtime failure', envelope('api_unhandled_error', 500), 'ServerError', 500],
] as const;

for (const [name, response, reason, status] of statusCases) {
  test(`${name} is TransportError ${reason}`, async () => {
    const runtime = fakeRuntime(() => response.clone());

    const error = await runtime.run(sendPause);

    assert.ok(error instanceof TransportError);
    assert.equal(error.reason, reason);
    assert.equal(error.status, status);
  });
}

test('an unreachable runtime is TransportError Unreachable', async () => {
  const runtime = fakeRuntime(() => Promise.reject(new Error('down')));

  const error = await runtime.run(sendPause);

  assert.ok(error instanceof TransportError);
  assert.equal(error.reason, 'Unreachable');
});

test('a reply that is not the envelope is TransportError Malformed', async () => {
  const runtime = fakeRuntime(() => new Response('<html>', { status: 502 }));

  const error = await runtime.run(sendPause);

  assert.ok(error instanceof TransportError);
  assert.equal(error.reason, 'Malformed');
});

test('subscribe decodes subscription messages from the session events stream', async () => {
  const runtime = fakeRuntime(() =>
    sse({ _tag: 'PauseChanged', paused: true }, { _tag: 'Superseded' }),
  );

  const messages = await runtime.run((transport) => Stream.runCollect(transport.subscribe()));

  assert.deepEqual(
    [...messages].map((message) => message._tag),
    ['PauseChanged', 'Superseded'],
  );
  assert.equal(runtime.seen[0]?.url, `${runtimeUrl}/api/v1/fluidcast-sessions/fc-1/events`);
});

test('subscribe opens the stream only after beforeSubscribe completes', async () => {
  const runtime = fakeRuntime(() => sse({ _tag: 'Superseded' }));
  const gate = Effect.runSync(Deferred.make<void>());

  const pending = runtime.run(
    (transport) => Stream.runCollect(transport.subscribe()),
    Deferred.await(gate),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.seen.length, 0);

  Effect.runSync(Deferred.succeed(gate, undefined));
  await pending;
  assert.equal(runtime.seen.length, 1);
});

test('a subscription message the SDK cannot decode is TransportError Malformed', async () => {
  const runtime = fakeRuntime(() => sse({ _tag: 'NotAMessage' }));

  const error = await runtime.run((transport) =>
    Stream.runDrain(transport.subscribe()).pipe(Effect.flip),
  );

  assert.ok(error instanceof TransportError);
  assert.equal(error.reason, 'Malformed');
});

test('a subscription to a stopped session is TransportError BadRequest', async () => {
  const runtime = fakeRuntime(() =>
    envelope('fluidcast_session_not_found', 404, { fluidcastSessionId }),
  );

  const error = await runtime.run((transport) =>
    Stream.runDrain(transport.subscribe()).pipe(Effect.flip),
  );

  assert.ok(error instanceof TransportError);
  assert.equal(error.reason, 'BadRequest');
  assert.equal(error.status, 404);
});

test('speech streams the line and its URL names the same route', async () => {
  const runtime = fakeRuntime(() => new Response(new Uint8Array([1, 2]), { status: 200 }));

  const [bytes, url] = await runtime.run((transport) =>
    Stream.runCollect(transport.speech('a 1')).pipe(
      Effect.map((chunks) => [
        [...chunks].flatMap((chunk) => [...chunk]),
        transport.speechUrl?.('a 1'),
      ]),
    ),
  );

  assert.deepEqual(bytes, [1, 2]);
  assert.equal(url, `${runtimeUrl}/api/v1/fluidcast-sessions/fc-1/speech/a%201`);
  assert.equal(runtime.seen[0]?.url, url);
});

test('speech for a line the session does not hold is SpeechNotFound', async () => {
  const runtime = fakeRuntime(() => envelope('fluidcast_speech_not_found', 404));

  const error = await runtime.run((transport) =>
    Stream.runDrain(transport.speech('a1')).pipe(Effect.flip),
  );

  assert.ok(error instanceof SpeechNotFound);
  assert.equal(error.actionId, 'a1');
});

test('a speech service failure is SpeechError with its reason', async () => {
  const runtime = fakeRuntime(() =>
    envelope('fluidcast_speech_failed', 502, { reason: 'StatusCodeError' }),
  );

  const error = await runtime.run((transport) =>
    Stream.runDrain(transport.speech('a1')).pipe(Effect.flip),
  );

  assert.ok(error instanceof SpeechError);
  assert.equal(error.reason, 'StatusCodeError');
});

test('worker status and transcript decode their own streams', async () => {
  const runtime = fakeRuntime((seen) =>
    seen.url.endsWith('/worker/status')
      ? sse({ _tag: 'WorkerSummary', status: 'idle', sessionId: null, backgroundTasks: 0 })
      : sse({ _tag: 'TranscriptSnapshot', entries: [] }),
  );

  const [status, transcript] = await runtime.run((_transport, worker) =>
    Effect.all([Stream.runCollect(worker.status()), Stream.runCollect(worker.transcript())]),
  );

  assert.deepEqual(
    [...status],
    [{ _tag: 'WorkerSummary', status: 'idle', sessionId: null, backgroundTasks: 0 }],
  );
  assert.deepEqual([...transcript], [{ _tag: 'TranscriptSnapshot', entries: [] }]);
});

test('a worker message that does not decode is TransportError Malformed', async () => {
  const runtime = fakeRuntime(() => sse({ _tag: 'WorkerSummary', status: 'busy' }));

  const error = await runtime.run((_transport, worker) =>
    Stream.runDrain(worker.status()).pipe(Effect.flip),
  );

  assert.ok(error instanceof TransportError);
  assert.equal(error.reason, 'Malformed');
});

const ok = (data: unknown) =>
  new Response(JSON.stringify({ data, meta: { requestId: 'r' } }), { status: 200 });

test("skills are read from the session's skills route and decoded", async () => {
  const skills = [
    { name: 'review', description: 'Review the diff', argumentHint: '[level]' },
    { name: 'plan', description: 'Plan the change' },
  ];
  const runtime = fakeRuntime(() => ok(skills));

  const listed = await runtime.run((_transport, worker) => worker.skills());

  assert.deepEqual(listed, skills);
  assert.equal(runtime.seen[0]?.method, 'GET');
  assert.equal(runtime.seen[0]?.url, `${runtimeUrl}/api/v1/fluidcast-sessions/fc-1/worker/skills`);
});

test('a skills failure is the TransportError its status or body calls for', async () => {
  const cases = [
    [envelope('fluidcast_skills_unavailable', 502, { reason: 'TimedOut' }), 'ServerError'],
    [envelope('fluidcast_session_not_found', 404, { fluidcastSessionId }), 'BadRequest'],
    [ok([{ name: 'review' }]), 'Malformed'],
  ] as const;
  for (const [response, reason] of cases) {
    const runtime = fakeRuntime(() => response);
    const error = await runtime.run((_transport, worker) => worker.skills().pipe(Effect.flip));
    assert.ok(error instanceof TransportError);
    assert.equal(error.reason, reason);
  }
});
