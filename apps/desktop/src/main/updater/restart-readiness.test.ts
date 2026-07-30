import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { createRestartReadinessReader, restartReadinessTimeoutMs } from './restart-readiness.js';

const success = (workingAgentCount: number) =>
  new Response(JSON.stringify({ data: { workingAgentCount }, meta: { requestId: 'request-1' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('restart readiness decodes clear and working agent results', async () => {
  for (const [count, expected] of [
    [0, { kind: 'clear' }],
    [3, { kind: 'working_agents', workingAgentCount: 3 }],
  ] as const) {
    const diagnostics: string[] = [];
    const read = createRestartReadinessReader({
      getRuntimeUrl: () => Effect.succeed('http://127.0.0.1:43129'),
      fetch: () => Promise.resolve(success(count)),
      diagnose: (category) => diagnostics.push(category),
    });
    assert.deepEqual(await Effect.runPromise(read()), expected);
    assert.deepEqual(diagnostics, []);
  }
});

test('restart readiness maps transport, HTTP, and decoding failures to categorized unknown', async () => {
  const cases = [
    {
      expected: 'transport',
      fetch: () => Promise.reject(new Error('secret transport cause')),
    },
    {
      expected: 'http',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'agent_session_activity_unavailable',
                status: 500,
                message: 'Agent session activity could not be read.',
                requestId: 'request-1',
              },
            }),
            { status: 500 },
          ),
        ),
    },
    {
      expected: 'decoding',
      fetch: () => Promise.resolve(new Response('{', { status: 200 })),
    },
    {
      expected: 'decoding',
      fetch: () => Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 })),
    },
  ] as const;
  for (const subject of cases) {
    const diagnostics: string[] = [];
    const read = createRestartReadinessReader({
      getRuntimeUrl: () => Effect.succeed('http://127.0.0.1:43129'),
      fetch: subject.fetch,
      diagnose: (category) => diagnostics.push(category),
    });
    assert.deepEqual(await Effect.runPromise(read()), { kind: 'unknown' });
    assert.deepEqual(diagnostics, [subject.expected]);
  }
});

test('restart readiness reports an unusable runtime URL as a diagnosed unknown', async () => {
  const diagnostics: string[] = [];
  let fetched = false;
  const read = createRestartReadinessReader({
    // A degraded external runtime still hands back its configured URL, so a
    // malformed one must stay in the failure channel instead of escaping as a
    // defect the coordinator never sees.
    getRuntimeUrl: () => Effect.succeed('not-a-url'),
    fetch: () => {
      fetched = true;
      return Promise.resolve(success(0));
    },
    diagnose: (category) => diagnostics.push(category),
  });
  assert.deepEqual(await Effect.runPromise(read()), { kind: 'unknown' });
  assert.deepEqual(diagnostics, ['transport']);
  assert.equal(fetched, false);
});

test('restart readiness applies one timeout to runtime access and aborts an in-flight fetch', async () => {
  let aborted = false;
  const read = createRestartReadinessReader({
    getRuntimeUrl: () => Effect.succeed('http://127.0.0.1:43129'),
    fetch: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
    diagnose: (category) => assert.equal(category, 'timeout'),
  });
  const startedAt = Date.now();
  assert.deepEqual(await Effect.runPromise(read()), { kind: 'unknown' });
  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt >= restartReadinessTimeoutMs - 100);
});

test('restart readiness aborts a response whose body never finishes', async () => {
  let signal: AbortSignal | undefined;
  const read = createRestartReadinessReader({
    getRuntimeUrl: () => Effect.succeed('http://127.0.0.1:43129'),
    // Headers arrive immediately; the body never does. The deadline owns the
    // whole operation, so the transport must not be left alive behind it.
    fetch: (_input, init) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        json: () => new Promise<unknown>(() => undefined),
      } as unknown as Response);
    },
    diagnose: (category) => assert.equal(category, 'timeout'),
  });
  const startedAt = Date.now();
  assert.deepEqual(await Effect.runPromise(read()), { kind: 'unknown' });
  assert.equal(signal?.aborted, true);
  assert.ok(Date.now() - startedAt >= restartReadinessTimeoutMs - 100);
});
