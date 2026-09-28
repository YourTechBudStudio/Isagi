import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { RuntimeApiError } from '@isagi/runtime-client';

import {
  workflowCheckpointFixture,
  workflowExecutionDetailFixture,
  workflowSummaryFixture,
} from '../workspace/workflow/test-support.js';
import { createRuntimeClient } from './client.js';

/**
 * The workflow half of the runtime client, checked against the real endpoint definitions: the path,
 * method, query and body each route is actually called with.
 */

const runtimeUrl = 'http://runtime.test';

test('every control names its run, and cancel and dismiss are different routes', async () => {
  for (const [call, path] of [
    ['pauseWorkflow', 'pause'],
    ['resumeWorkflow', 'resume'],
    ['retryWorkflow', 'retry'],
    ['cancelWorkflow', 'cancel'],
    ['dismissWorkflow', 'dismiss'],
  ] as const) {
    const recorded = await capture(controlOutput(), (client) => client[call](77));
    assert.equal(recorded.url, `${runtimeUrl}/api/v1/workflows/runs/77/${path}`);
    assert.equal(recorded.method, 'POST');
  }
});

test('advance names the waiting execution it answers, and its answers', async () => {
  const recorded = await capture(controlOutput(), (client) =>
    client.advanceWorkflow(77, { executionId: 5, answers: { verdict: 'ship', notes: ['a', 'b'] } }),
  );
  assert.equal(recorded.url, `${runtimeUrl}/api/v1/workflows/runs/77/advance`);
  assert.equal(
    recorded.body,
    JSON.stringify({ executionId: 5, answers: { verdict: 'ship', notes: ['a', 'b'] } }),
  );
  const bare = await capture(controlOutput(), (client) =>
    client.advanceWorkflow(77, { executionId: 5 }),
  );
  assert.equal(bare.body, JSON.stringify({ executionId: 5 }));
});

test('the structure read names the build it draws', async () => {
  const recorded = await capture(structureOutput(), (client) =>
    client.getWorkflowStructure(77, 'sha256:build-1'),
  );
  assert.equal(
    recorded.url,
    `${runtimeUrl}/api/v1/workflows/runs/77/structure?artifactHash=${encodeURIComponent('sha256:build-1')}`,
  );
});

test('the event log pages forward from the last event held', async () => {
  const first = await capture({ items: [], nextCursor: null }, (client) =>
    client.listWorkflowEvents(77, { limit: 500 }),
  );
  assert.equal(first.url, `${runtimeUrl}/api/v1/workflows/runs/77/events?limit=500`);
  const next = await capture({ items: [], nextCursor: null }, (client) =>
    client.listWorkflowEvents(77, { limit: 500, cursor: 42 }),
  );
  assert.equal(next.url, `${runtimeUrl}/api/v1/workflows/runs/77/events?limit=500&cursor=42`);
});

test('executions and checkpoints are addressed directly by their own ids', async () => {
  const execution = await capture(
    { execution: workflowExecutionDetailFixture({ executionId: 9 }) },
    (client) => client.getWorkflowExecution(9),
  );
  assert.equal(execution.url, `${runtimeUrl}/api/v1/workflows/executions/9`);
  const checkpoint = await capture({ checkpoint: workflowCheckpointFixture() }, (client) =>
    client.getWorkflowCheckpoint(1),
  );
  assert.equal(checkpoint.url, `${runtimeUrl}/api/v1/workflows/checkpoints/1`);
  const list = await capture({ items: [], nextCursor: null }, (client) =>
    client.listWorkflowCheckpoints(77, { limit: 500 }),
  );
  assert.equal(list.url, `${runtimeUrl}/api/v1/workflows/runs/77/checkpoints?limit=500`);
});

test('a refused control keeps its own reason rather than collapsing to a generic failure', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'workflow_rejected',
            status: 409,
            message: 'diagnostic message from runtime',
            requestId: 'req-refused',
            data: { reason: 'workflow_control_unavailable', control: 'pause', workflowRunId: 77 },
          },
          meta: { requestId: 'req-refused' },
        }),
        { status: 409 },
      ),
    )) as typeof fetch;

  const exit = await Effect.runPromiseExit(createRuntimeClient(runtimeUrl).pauseWorkflow(77));
  const failure = exit._tag === 'Failure' ? causeFailure(exit.cause) : null;
  assert.ok(failure instanceof RuntimeApiError);
  assert.equal(
    (apiErrorData(failure as RuntimeApiError<never>) as { readonly reason: string }).reason,
    'workflow_control_unavailable',
  );
});

test('checkpoint file bytes are fetched raw by path, with the download variant available as a URL', async () => {
  let seen: string | null = null;
  globalThis.fetch = ((input) => {
    seen = String(input);
    return Promise.resolve(new Response('saved bytes', { status: 200 }));
  }) as typeof fetch;

  const client = createRuntimeClient(runtimeUrl);
  const blob = await Effect.runPromise(
    client.fetchWorkflowCheckpointFile(1, 'notes/a b.md') as Effect.Effect<Blob, never>,
  );
  assert.equal(await blob.text(), 'saved bytes');
  assert.equal(seen, `${runtimeUrl}/api/v1/workflows/checkpoints/1/file?path=notes%2Fa+b.md`);
  assert.equal(
    client.workflowCheckpointFileUrl(1, 'notes/a b.md', { download: true }),
    `${runtimeUrl}/api/v1/workflows/checkpoints/1/file?path=notes%2Fa+b.md&download=true`,
  );
});

async function capture<Output>(
  data: unknown,
  call: (client: ReturnType<typeof createRuntimeClient>) => Effect.Effect<Output, unknown>,
) {
  let recorded: { url: string; method: string; body: string } | null = null;
  globalThis.fetch = ((input, init) => {
    recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
    };
    return Promise.resolve(
      new Response(JSON.stringify({ data, meta: { requestId: 'req' } }), { status: 200 }),
    );
  }) as typeof fetch;

  await Effect.runPromise(call(createRuntimeClient(runtimeUrl)) as Effect.Effect<Output, never>);
  assert.ok(recorded, 'the call should have reached the transport');
  return recorded as unknown as { url: string; method: string; body: string };
}

function apiErrorData(failure: RuntimeApiError<never>): unknown {
  return (failure.apiError as { readonly data?: unknown }).data;
}

function causeFailure(cause: unknown): unknown {
  const failures = (cause as { readonly error?: unknown }).error;
  return failures ?? cause;
}

function structureOutput() {
  return {
    artifactHash: 'sha256:build-1',
    workflowKey: 'review',
    sdkVersion: '0.1.0',
    verifierVersion: '0.1.0',
    contractVersion: 4,
    firstSeenAt: '2026-09-15T10:00:00.000Z',
    descriptor: {
      descriptorVersion: 1,
      workflowContractVersion: 4,
      rootGraphKey: 'root',
      graphs: [],
    },
  };
}

function controlOutput() {
  return { run: workflowSummaryFixture({ runId: 77 }) };
}
