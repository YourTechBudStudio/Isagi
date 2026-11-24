import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Duration, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';

import {
  defaultEditorProbeRequest,
  describeUnreachable,
  EDITOR_WORKBENCH_MARKER,
  probeWorkbench,
  type EditorProbeOutcome,
  type EditorProbeRequest,
  type EditorReadinessSettlement,
} from '../readiness.js';

const SOCKET = '/tmp/isagi-editor-0a1b/7-a1b2c3-w.sock';

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
  const request: EditorProbeRequest = ({ socketPath, path, requireMarker }) =>
    Effect.sync(() => {
      calls.push(`${socketPath}${path}`);
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
  advance: Duration.Input,
  timing: Partial<typeof TIMING> = {},
) {
  return Effect.gen(function* () {
    const settlements: EditorReadinessSettlement[] = [];
    const fiber = yield* Effect.forkChild(
      probeWorkbench({
        socketPath: SOCKET,
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
  }).pipe(Effect.provide(TestClock.layer()));
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
  assert.deepEqual(calls, [`${SOCKET}/healthz`, `${SOCKET}/`]);
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
      detail: `${SOCKET} · workbench · marker absent · gave up after 60s`,
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
      detail: `${SOCKET} · healthz · no response · gave up after 60s`,
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
      detail: `${SOCKET} · healthz · request timed out · gave up after 60s`,
    },
  ]);
});

test('a probe interrupted mid-flight writes no observation', async () => {
  const settlements = await Effect.runPromise(
    Effect.gen(function* () {
      const recorded: EditorReadinessSettlement[] = [];
      const fiber = yield* Effect.forkChild(
        probeWorkbench({
          socketPath: SOCKET,
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
    }).pipe(Effect.provide(TestClock.layer())),
  );

  assert.deepEqual(settlements, []);
});

test('the settled detail is composed only from authored components', () => {
  assert.equal(
    describeUnreachable({
      socketPath: SOCKET,
      stage: 'workbench',
      outcome: { kind: 'http_status', status: 502 },
      deadlineMs: 60_000,
    }),
    `${SOCKET} · workbench · http 502 · gave up after 60s`,
  );
  assert.equal(
    describeUnreachable({
      socketPath: SOCKET,
      stage: 'workbench',
      outcome: { kind: 'not_html' },
      deadlineMs: 30_000,
    }),
    `${SOCKET} · workbench · not html · gave up after 30s`,
  );
});

// ---------------------------------------------------------------------------
// The default request path, against a real server
// ---------------------------------------------------------------------------

interface ServedRequest {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
}

/**
 * A real HTTP server on a UNIX socket, as Code Server listens. The directory is
 * short and under the system temp root, because a socket path is capped near
 * 104 bytes.
 */
function withServer<A>(
  handler: (path: string) => {
    readonly status: number;
    readonly contentType?: string | undefined;
    readonly chunks?: readonly string[] | undefined;
    readonly location?: string | undefined;
  },
  body: (socketPath: string, served: readonly ServedRequest[]) => Promise<A>,
): Promise<A> {
  const directory = mkdtempSync(join(tmpdir(), 'ier-'));
  const socketPath = join(directory, 'w.sock');
  const served: ServedRequest[] = [];
  return new Promise<A>((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      served.push({ path: request.url ?? '/', headers: request.headers });
      const result = handler(request.url ?? '/');
      const headers: Record<string, string> = {};
      if (result.contentType) headers['content-type'] = result.contentType;
      if (result.location) headers.location = result.location;
      response.writeHead(result.status, headers);
      for (const chunk of result.chunks ?? []) response.write(chunk);
      response.end();
    });
    server.listen(socketPath, () => {
      body(socketPath, served)
        .then(resolve, reject)
        .finally(() => {
          server.close();
          rmSync(directory, { recursive: true, force: true });
        });
    });
  });
}

test('the default request reads a real 2xx health response as ok', async () => {
  const outcome = await withServer(
    () => ({ status: 200, contentType: 'text/plain', chunks: ['ok'] }),
    (socketPath) =>
      Effect.runPromise(
        defaultEditorProbeRequest({
          socketPath,
          path: '/healthz',
          requireMarker: false,
        }),
      ),
  );

  assert.deepEqual(outcome, { kind: 'ok' });
});

test('the default request reports a real non-2xx status', async () => {
  const outcome = await withServer(
    () => ({ status: 502, contentType: 'text/plain', chunks: ['bad gateway'] }),
    (socketPath) =>
      Effect.runPromise(
        defaultEditorProbeRequest({
          socketPath,
          path: '/healthz',
          requireMarker: false,
        }),
      ),
  );

  assert.deepEqual(outcome, { kind: 'http_status', status: 502 });
});

test('the default request refuses to follow a redirect off the upstream origin', async () => {
  const outcome = await withServer(
    () => ({ status: 302, location: 'http://example.invalid/', chunks: [] }),
    (socketPath) =>
      Effect.runPromise(defaultEditorProbeRequest({ socketPath, path: '/', requireMarker: true })),
  );

  // Readiness is a statement about *this* incarnation. Naming the refusal is what
  // separates it from an ordinary bad status the workbench happened to return.
  assert.deepEqual(outcome, { kind: 'redirected_away' });
});

test('the default request rejects a 2xx that is not HTML', async () => {
  const outcome = await withServer(
    () => ({ status: 200, contentType: 'application/json', chunks: ['{}'] }),
    (socketPath) =>
      Effect.runPromise(defaultEditorProbeRequest({ socketPath, path: '/', requireMarker: true })),
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
    (socketPath) =>
      Effect.runPromise(defaultEditorProbeRequest({ socketPath, path: '/', requireMarker: true })),
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
    (socketPath) =>
      Effect.runPromise(defaultEditorProbeRequest({ socketPath, path: '/', requireMarker: true })),
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
    (socketPath) =>
      Effect.runPromise(defaultEditorProbeRequest({ socketPath, path: '/', requireMarker: true })),
  );

  assert.deepEqual(outcome, { kind: 'marker_absent' });
});

test('the default request reports an unreachable socket as no response', async () => {
  // A socket path nothing listens on: the transport failure is opaque by design.
  const directory = mkdtempSync(join(tmpdir(), 'ier-'));
  const outcome = await Effect.runPromise(
    defaultEditorProbeRequest({
      socketPath: join(directory, 'absent.sock'),
      path: '/healthz',
      requireMarker: false,
    }),
  ).finally(() => rmSync(directory, { recursive: true, force: true }));

  assert.deepEqual(outcome, { kind: 'no_response' });
});

/**
 * The regression. Code Server answers `GET /` with a same-origin 302 to
 * `?folder=…` whenever a folder was given on the command line and the query
 * carries none — which every Isagi launch does. A probe that would not follow it
 * reported `unreachable` after 60s for a workbench that was serving correctly,
 * because the pane's iframe follows the redirect like any browser.
 */
test('the default request follows Code Server’s own same-origin redirect', async () => {
  const outcome = await withServer(
    (path) =>
      path.includes('folder=')
        ? {
            status: 200,
            contentType: 'text/html',
            chunks: [`<html>${EDITOR_WORKBENCH_MARKER}</html>`],
          }
        : { status: 302, location: '/?folder=%2Fsome%2Fworktree', chunks: [] },
    (socketPath) =>
      Effect.runPromise(defaultEditorProbeRequest({ socketPath, path: '/', requireMarker: true })),
  );

  assert.deepEqual(outcome, { kind: 'ok' });
});

test('a relative redirect target resolves against the origin rather than escaping it', async () => {
  const outcome = await withServer(
    (path) =>
      path === '/healthz'
        ? { status: 302, location: 'healthz/', chunks: [] }
        : { status: 200, contentType: 'text/plain', chunks: ['ok'] },
    (socketPath) =>
      Effect.runPromise(
        defaultEditorProbeRequest({ socketPath, path: '/healthz', requireMarker: false }),
      ),
  );

  assert.deepEqual(outcome, { kind: 'ok' });
});

test('a redirect loop settles on the status rather than walking forever', async () => {
  const outcome = await withServer(
    () => ({ status: 307, location: '/again', chunks: [] }),
    (socketPath) =>
      Effect.runPromise(defaultEditorProbeRequest({ socketPath, path: '/', requireMarker: true })),
  );

  assert.deepEqual(outcome, { kind: 'http_status', status: 307 });
});

test('a 3xx with no Location is reported as the status it is', async () => {
  const outcome = await withServer(
    () => ({ status: 303, chunks: [] }),
    (socketPath) =>
      Effect.runPromise(defaultEditorProbeRequest({ socketPath, path: '/', requireMarker: true })),
  );

  assert.deepEqual(outcome, { kind: 'http_status', status: 303 });
});

test('every probe request names the upstream host, redirect hops included', async () => {
  const served = await withServer(
    (path) =>
      path === '/'
        ? { status: 302, location: '/?folder=%2Fw', chunks: [] }
        : { status: 200, contentType: 'text/html', chunks: [EDITOR_WORKBENCH_MARKER] },
    async (socketPath, requests) => {
      const outcome = await Effect.runPromise(
        defaultEditorProbeRequest({ socketPath, path: '/', requireMarker: true }),
      );
      assert.deepEqual(outcome, { kind: 'ok' });
      return requests;
    },
  );

  assert.deepEqual(
    served.map((request) => [request.path, request.headers.host]),
    [
      ['/', 'localhost'],
      ['/?folder=%2Fw', 'localhost'],
    ],
  );
});

test('an absolute redirect to the upstream origin stays on the incarnation', async () => {
  const outcome = await withServer(
    (path) =>
      path === '/next'
        ? { status: 200, contentType: 'text/plain', chunks: ['ok'] }
        : { status: 302, location: 'http://localhost/next', chunks: [] },
    (socketPath) =>
      Effect.runPromise(
        defaultEditorProbeRequest({ socketPath, path: '/healthz', requireMarker: false }),
      ),
  );

  assert.deepEqual(outcome, { kind: 'ok' });
});

test('an absolute redirect to another loopback authority is redirected away', async () => {
  for (const location of ['http://127.0.0.1/', 'http://localhost:8080/', 'https://localhost/']) {
    const outcome = await withServer(
      () => ({ status: 302, location, chunks: [] }),
      (socketPath) =>
        Effect.runPromise(
          defaultEditorProbeRequest({ socketPath, path: '/healthz', requireMarker: false }),
        ),
    );

    assert.deepEqual(outcome, { kind: 'redirected_away' }, location);
  }
});
