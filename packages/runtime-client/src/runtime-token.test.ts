import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Redacted, Stream } from 'effect';
import { HttpClient } from 'effect/http';

import {
  apiEndpoints,
  fluidcastEventStreamEndpoints,
  workflowContentEndpoints,
} from '@isagi/contracts';

import { RuntimeClient, withRuntimeToken } from './index.js';
import { fakeRuntime, json, runtimeUrl } from './test-support.js';

const token = Redacted.make('process-token-for-tests');

/** A client made under the transformed `HttpClient`, as the CLI and the desktop's readiness probe build it. */
const withToken = <A, E, R>(use: (client: RuntimeClient['Service']) => Effect.Effect<A, E, R>) =>
  RuntimeClient.make(runtimeUrl).pipe(
    Effect.flatMap(use),
    Effect.updateService(HttpClient.HttpClient, withRuntimeToken(token)),
  );

test('withRuntimeToken sends the bearer on JSON, content and event-stream requests', async () => {
  const runtime = fakeRuntime((seen) =>
    seen.url.endsWith('/events')
      ? new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : seen.url.includes('/workspace')
        ? json({ data: { projects: [] }, meta: { requestId: 'r' } })
        : new Response('text', { status: 200 }),
  );

  await runtime.run(
    withToken((client) =>
      Effect.gen(function* () {
        yield* client.request(apiEndpoints.workspace.get);
        yield* Effect.ignore(
          client.requestContent(
            workflowContentEndpoints.getCheckpointFile,
            { checkpointId: 2 },
            { path: 'a.txt' },
          ),
        );
        yield* Stream.runDrain(
          client.requestEventStream(fluidcastEventStreamEndpoints.events, {
            fluidcastSessionId: 'fc',
          }),
        );
      }),
    ),
  );

  assert.equal(runtime.seen.length, 3);
  for (const seen of runtime.seen) {
    assert.equal(seen.headers.authorization, 'Bearer process-token-for-tests', seen.url);
  }
});

test('the default client carries no authorization header', async () => {
  const runtime = fakeRuntime(() => json({ data: { projects: [] }, meta: { requestId: 'r' } }));

  await runtime.run(RuntimeClient.use((client) => client.request(apiEndpoints.workspace.get)));

  assert.equal(runtime.seen[0]?.headers.authorization, undefined);
});
