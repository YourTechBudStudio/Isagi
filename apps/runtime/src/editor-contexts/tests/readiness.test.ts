import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { Duration, Effect, Fiber, TestClock, TestContext } from 'effect';

import {
  defaultEditorProbeRequest,
  describeUnreachable,
  EDITOR_WORKBENCH_MARKER,
  probeWorkbench,
  type EditorProbeOutcome,
  type EditorProbeRequest,
  type EditorReadinessSettlement,
} from '../readiness.js';

const TIMING = {
  initialDelayMs: 250,
  intervalMs: 500,
  requestTimeoutMs: 2_000,
  deadlineMs: 60_000,
};

/**
 * A scripted request seam. Each stage draws from its own queue and repeats its
 * last answer once exhausted, so a test states only the outcomes it cares about.
 */
function scriptedRequest(script: {
  readonly healthz: readonly EditorProbeOutcome[];
  readonly workbench: readonly EditorProbeOutcome[];
}) {
  const calls: string[] = [];
  let healthzIndex = 0;
  let workbenchIndex = 0;
  const request: EditorProbeRequest = ({ url, requireMarker }) =>
    Effect.sync(() => {
      calls.push(url);
      const queue = requireMarker ? script.workbench : script.healthz;
      const index = requireMarker ? workbenchIndex : healthzIndex;
      if (requireMarker) workbenchIndex += 1;
      else healthzIndex += 1;
      const outcome = queue.at(Math.min(index, queue.length - 1));
      if (!outcome) throw new Error('the scripted probe request has no outcome to return');
      return outcome;
    });
  return { request, calls };
}

function runProbe(
  request: EditorProbeRequest,
  advance: Duration.DurationInput,
  timing: Partial<typeof TIMING> = {},
) {
  return Effect.gen(function* () {
    const settlements: EditorReadinessSettlement[] = [];
    const fiber = yield* Effect.fork(
      probeWorkbench({
        host: '127.0.0.1',
        port: 41_287,
        request,
        timing: { ...TIMING, ...timing },
        onSettled: (settlement) =>
          Effect.sync(() => {
            settlements.push(settlement);
          }),
      }),
    );
    yield* TestClock.adjust(advance);
    yield* Fiber.join(fiber);
    return settlements;
  }).pipe(Effect.provide(TestContext.TestContext));
}

test('both stages passing settles ready with no detail', async () => {
  const { request, calls } = scriptedRequest({
    healthz: [{ kind: 'ok' }],
    workbench: [{ kind: 'ok' }],
  });

  const settlements = await Effect.runPromise(runProbe(request, Duration.seconds(1)));

  assert.deepEqual(settlements, [{ state: 'ready', detail: null }]);
  // Health first, workbench immediately after — the advance never reaches a
  // second interval, so the stage change cost no extra poll.
  assert.deepEqual(calls, ['http://127.0.0.1:41287/healthz', 'http://127.0.0.1:41287/']);
});

test('stage 1 passing then a marker mismatch keeps polling and settles unreachable', async () => {
  const { request, calls } = scriptedRequest({
    healthz: [{ kind: 'ok' }],
    workbench: [{ kind: 'marker_absent' }],
  });

  const settlements = await Effect.runPromise(runProbe(request, Duration.seconds(61)));

  assert.deepEqual(settlements, [
    {
      state: 'unreachable',
      detail: '127.0.0.1:41287 · workbench · marker absent · gave up after 60s',
    },
  ]);
  // It kept asking, and — the monotonic rule — never went back to health.
  assert.ok(calls.length > 10);
  assert.equal(calls.filter((url) => url.endsWith('/healthz')).length, 1);
});

test('a workbench that never comes up settles naming the health stage', async () => {
  const { request } = scriptedRequest({
    healthz: [{ kind: 'no_response' }],
    workbench: [{ kind: 'ok' }],
  });

  const settlements = await Effect.runPromise(runProbe(request, Duration.seconds(61)));

  assert.deepEqual(settlements, [
    {
      state: 'unreachable',
      detail: '127.0.0.1:41287 · healthz · no response · gave up after 60s',
    },
  ]);
});

test('a request that never answers is bounded by the per-request timeout', async () => {
  const request: EditorProbeRequest = () => Effect.never;

  const settlements = await Effect.runPromise(runProbe(request, Duration.seconds(61)));

  // The individual request is abandoned rather than consuming the whole
  // deadline, and its own timer names the outcome.
  assert.deepEqual(settlements, [
    {
      state: 'unreachable',
      detail: '127.0.0.1:41287 · healthz · request timed out · gave up after 60s',
    },
  ]);
});

test('a probe interrupted mid-flight writes no observation', async () => {
  const settlements = await Effect.runPromise(
    Effect.gen(function* () {
      const recorded: EditorReadinessSettlement[] = [];
      const fiber = yield* Effect.fork(
        probeWorkbench({
          host: '127.0.0.1',
          port: 41_287,
          request: () => Effect.succeed({ kind: 'no_response' } as const),
          timing: TIMING,
          onSettled: (settlement) =>
            Effect.sync(() => {
              recorded.push(settlement);
            }),
        }),
      );
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust(Duration.seconds(120));
      return recorded;
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

  assert.deepEqual(settlements, []);
});

test('the settled detail is composed only from authored components', () => {
  assert.equal(
    describeUnreachable({
      host: '127.0.0.1',
      port: 41_287,
      stage: 'workbench',
      outcome: { kind: 'http_status', status: 502 },
      deadlineMs: 60_000,
    }),
    '127.0.0.1:41287 · workbench · http 502 · gave up after 60s',
  );
  assert.equal(
    describeUnreachable({
      host: '127.0.0.1',
      port: 41_287,
      stage: 'workbench',
      outcome: { kind: 'not_html' },
      deadlineMs: 30_000,
    }),
    '127.0.0.1:41287 · workbench · not html · gave up after 30s',
  );
});

// ---------------------------------------------------------------------------
// The default request path, against a real server
// ---------------------------------------------------------------------------

function withServer<A>(
  handler: (path: string) => {
    readonly status: number;
    readonly contentType?: string | undefined;
    readonly chunks?: readonly string[] | undefined;
    readonly location?: string | undefined;
  },
  body: (origin: string) => Promise<A>,
): Promise<A> {
  return new Promise<A>((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      const result = handler(request.url ?? '/');
      const headers: Record<string, string> = {};
      if (result.contentType) headers['content-type'] = result.contentType;
      if (result.location) headers.location = result.location;
      response.writeHead(result.status, headers);
      for (const chunk of result.chunks ?? []) response.write(chunk);
      response.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      body(`http://127.0.0.1:${port}`)
        .then(resolve, reject)
        .finally(() => server.close());
    });
  });
}

test('the default request reads a real 2xx health response as ok', async () => {
  const outcome = await withServer(
    () => ({ status: 200, contentType: 'text/plain', chunks: ['ok'] }),
    (origin) =>
      Effect.runPromise(
        defaultEditorProbeRequest({
          url: `${origin}/healthz`,
          requireMarker: false,
        }),
      ),
  );

  assert.deepEqual(outcome, { kind: 'ok' });
});

test('the default request reports a real non-2xx status', async () => {
  const outcome = await withServer(
    () => ({ status: 502, contentType: 'text/plain', chunks: ['bad gateway'] }),
    (origin) =>
      Effect.runPromise(
        defaultEditorProbeRequest({
          url: `${origin}/healthz`,
          requireMarker: false,
        }),
      ),
  );

  assert.deepEqual(outcome, { kind: 'http_status', status: 502 });
});

test('the default request refuses to follow a redirect off the allocated origin', async () => {
  const outcome = await withServer(
    () => ({ status: 302, location: 'http://example.invalid/', chunks: [] }),
    (origin) =>
      Effect.runPromise(defaultEditorProbeRequest({ url: `${origin}/`, requireMarker: true })),
  );

  // Readiness is a statement about *this* origin, so a 3xx is simply not a 2xx.
  assert.deepEqual(outcome, { kind: 'http_status', status: 302 });
});

test('the default request rejects a 2xx that is not HTML', async () => {
  const outcome = await withServer(
    () => ({ status: 200, contentType: 'application/json', chunks: ['{}'] }),
    (origin) =>
      Effect.runPromise(defaultEditorProbeRequest({ url: `${origin}/`, requireMarker: true })),
  );

  assert.deepEqual(outcome, { kind: 'not_html' });
});

test('the default request finds the marker in a real HTML body', async () => {
  const outcome = await withServer(
    () => ({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      chunks: [`<!doctype html><script id="${EDITOR_WORKBENCH_MARKER}">{}</script>`],
    }),
    (origin) =>
      Effect.runPromise(defaultEditorProbeRequest({ url: `${origin}/`, requireMarker: true })),
  );

  assert.deepEqual(outcome, { kind: 'ok' });
});

test('the default request finds a marker split across chunk boundaries', async () => {
  const half = Math.floor(EDITOR_WORKBENCH_MARKER.length / 2);
  const outcome = await withServer(
    () => ({
      status: 200,
      contentType: 'text/html',
      chunks: [
        // A multi-byte code point immediately before the split, so a
        // non-streaming decoder would corrupt the boundary as well as lose it.
        `<!doctype html><p>café</p><span id="${EDITOR_WORKBENCH_MARKER.slice(0, half)}`,
        `${EDITOR_WORKBENCH_MARKER.slice(half)}">x</span>`,
      ],
    }),
    (origin) =>
      Effect.runPromise(defaultEditorProbeRequest({ url: `${origin}/`, requireMarker: true })),
  );

  assert.deepEqual(outcome, { kind: 'ok' });
});

test('the default request reports a real HTML body without the marker', async () => {
  const outcome = await withServer(
    () => ({
      status: 200,
      contentType: 'text/html',
      chunks: ['<!doctype html><body>not the workbench</body>'],
    }),
    (origin) =>
      Effect.runPromise(defaultEditorProbeRequest({ url: `${origin}/`, requireMarker: true })),
  );

  assert.deepEqual(outcome, { kind: 'marker_absent' });
});

test('the default request reports an unreachable origin as no response', async () => {
  // A port nothing is listening on: the transport failure is opaque by design.
  const outcome = await Effect.runPromise(
    defaultEditorProbeRequest({
      url: 'http://127.0.0.1:1/healthz',
      requireMarker: false,
    }),
  );

  assert.deepEqual(outcome, { kind: 'no_response' });
});
