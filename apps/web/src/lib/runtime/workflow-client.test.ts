import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { executionsPageFixture } from '../workspace/workflow/test-support.js';
import { createRuntimeClient, RuntimeApiError } from './client.js';

/**
 * The workflow half of the runtime client, checked against the real endpoint definitions.
 *
 * These assert the wire shape a route is actually called with — path, method, query and body —
 * because every one of them is a place a client can be quietly wrong: a control that forgets its
 * run, an advance that forgets its wait, a recovery read that omits the bound it is recovering from.
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

test('advance carries the wait it answers, and its answers', async () => {
  const recorded = await capture(controlOutput(), (client) =>
    client.advanceWorkflow(77, { waitId: 5, answers: { verdict: 'ship', notes: ['a', 'b'] } }),
  );
  assert.equal(recorded.url, `${runtimeUrl}/api/v1/workflows/runs/77/advance`);
  assert.equal(
    recorded.body,
    JSON.stringify({ waitId: 5, answers: { verdict: 'ship', notes: ['a', 'b'] } }),
  );
});

test('a continue-style wait advances with no answers at all', async () => {
  const recorded = await capture(controlOutput(), (client) =>
    client.advanceWorkflow(77, { waitId: 5 }),
  );
  assert.equal(recorded.body, JSON.stringify({ waitId: 5 }));
});

test('the structure read asks for the current pin and never names a version', async () => {
  const recorded = await capture(structureOutput(), (client) => client.getWorkflowStructure(77));
  // The parameter stays in the contract for API consumers; the client draws the run's own pin.
  assert.equal(recorded.url, `${runtimeUrl}/api/v1/workflows/runs/77/structure`);
});

test('hydration omits sinceRevision, and a gap fill carries it', async () => {
  const hydration = await capture(executionsPageFixture({ highWaterRevision: 4 }), (client) =>
    client.listWorkflowExecutions(77, { limit: 100 }),
  );
  assert.equal(hydration.url, `${runtimeUrl}/api/v1/workflows/runs/77/executions?limit=100`);

  const recovery = await capture(executionsPageFixture({ highWaterRevision: 9 }), (client) =>
    client.listWorkflowExecutions(77, { limit: 100, sinceRevision: 4 }),
  );
  // `sinceRevision` is what selects recovery mode; losing it would silently re-read the whole run.
  assert.match(recovery.url, /sinceRevision=4/);
});

test('a continuation sends only its cursor, because the cursor carries the boundary', async () => {
  const recorded = await capture(executionsPageFixture({ highWaterRevision: 9 }), (client) =>
    client.listWorkflowExecutions(77, { limit: 100, cursor: 'opaque-cursor' }),
  );
  assert.match(recorded.url, /cursor=opaque-cursor/);
  assert.doesNotMatch(recorded.url, /sinceRevision/);
  assert.doesNotMatch(recorded.url, /snapshotToken/);
});

test('an operations read passes every filter that shapes its result', async () => {
  const recorded = await capture({ items: [], nextCursor: null }, (client) =>
    client.listWorkflowOperations(77, { limit: 50, executionId: 3, state: 'uncertain' }),
  );
  assert.match(recorded.url, /executionId=3/);
  assert.match(recorded.url, /state=uncertain/);
});

test('a payload read is scoped to its run and its reference', async () => {
  const recorded = await capture(
    { payloadRef: 'sha256:abc', mediaType: 'application/json', byteSize: 3, value: { a: 1 } },
    (client) => client.getWorkflowPayload(77, 'sha256:abc'),
  );
  assert.equal(
    recorded.url,
    `${runtimeUrl}/api/v1/workflows/runs/77/payloads/${encodeURIComponent('sha256:abc')}`,
  );
});

test('an unavailable payload surfaces as a structured refusal, not an empty value', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'workflow_rejected',
            status: 409,
            message: 'diagnostic message from runtime',
            requestId: 'req-payload',
            data: {
              reason: 'workflow_payload_unavailable',
              payloadRef: 'sha256:gone',
              cause: 'corrupt',
            },
          },
          meta: { requestId: 'req-payload' },
        }),
        { status: 409 },
      ),
    )) as typeof fetch;

  const exit = await Effect.runPromiseExit(
    createRuntimeClient(runtimeUrl).getWorkflowPayload(77, 'sha256:gone'),
  );
  assert.equal(exit._tag, 'Failure');
  const failure = exit._tag === 'Failure' ? causeFailure(exit.cause) : null;
  assert.ok(failure instanceof RuntimeApiError);
  const data = apiErrorData(failure as RuntimeApiError<never>) as {
    readonly reason: string;
    readonly cause: string;
  };
  // Missing and corrupt stay apart: one is a value that was never written, the other is bytes that
  // no longer hash to what they claim, and the person can act on the difference.
  assert.equal(data.reason, 'workflow_payload_unavailable');
  assert.equal(data.cause, 'corrupt');
});

test('a stale control refusal keeps its own reason rather than collapsing to a generic failure', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'workflow_rejected',
            status: 409,
            message: 'diagnostic message from runtime',
            requestId: 'req-stale',
            data: { reason: 'workflow_stale_control', workflowRunId: 77 },
          },
          meta: { requestId: 'req-stale' },
        }),
        { status: 409 },
      ),
    )) as typeof fetch;

  const exit = await Effect.runPromiseExit(createRuntimeClient(runtimeUrl).pauseWorkflow(77));
  const failure = exit._tag === 'Failure' ? causeFailure(exit.cause) : null;
  assert.ok(failure instanceof RuntimeApiError);
  assert.equal(
    (apiErrorData(failure as RuntimeApiError<never>) as { readonly reason: string }).reason,
    'workflow_stale_control',
  );
});

test('an evidence listing repeats its label parameter instead of joining it', async () => {
  const recorded = await capture({ items: [], nextCursor: null }, (client) =>
    client.listWorkflowEvidence(77, {
      executionId: 12,
      subtree: 'true',
      role: 'review',
      label: ['round:2', 'phase:draft'],
    }),
  );
  const url = new URL(recorded.url);
  assert.equal(url.pathname, '/api/v1/workflows/runs/77/evidence');
  assert.deepEqual(
    url.searchParams.getAll('label'),
    ['round:2', 'phase:draft'],
    'a comma-joined value would make the separator illegal inside a label forever',
  );
  assert.equal(url.searchParams.get('executionId'), '12');
  assert.equal(url.searchParams.get('subtree'), 'true');
});

test('evidence content is fetched as bytes, with the download variant available as a URL', async () => {
  let seen: string | null = null;
  globalThis.fetch = ((input) => {
    seen = String(input);
    return Promise.resolve(new Response('round one verdict', { status: 200 }));
  }) as typeof fetch;

  const client = createRuntimeClient(runtimeUrl);
  const blob = await Effect.runPromise(
    client.fetchWorkflowEvidenceContent(77, 'wev_abc') as Effect.Effect<Blob, never>,
  );
  assert.equal(await blob.text(), 'round one verdict');
  assert.equal(seen, `${runtimeUrl}/api/v1/workflows/runs/77/evidence/wev_abc/content`);
  assert.equal(
    client.workflowEvidenceContentUrl(77, 'wev_abc', { download: true }),
    `${runtimeUrl}/api/v1/workflows/runs/77/evidence/wev_abc/content?download=true`,
  );
});

test('an unreadable capture comes back as the structured rejection, not as empty bytes', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'workflow_rejected',
            status: 400,
            message: 'Captured content for wev_abc is no longer stored.',
            requestId: 'req',
            data: {
              reason: 'workflow_evidence_content_unavailable',
              evidenceKey: 'wev_abc',
              cause: 'missing',
            },
          },
        }),
        { status: 400 },
      ),
    )) as typeof fetch;

  const failure = await Effect.runPromise(
    Effect.either(createRuntimeClient(runtimeUrl).fetchWorkflowEvidenceContent(77, 'wev_abc')),
  );
  assert.ok(failure._tag === 'Left');
  const error = failure.left as RuntimeApiError<never>;
  assert.deepEqual(apiErrorData(error), {
    reason: 'workflow_evidence_content_unavailable',
    evidenceKey: 'wev_abc',
    cause: 'missing',
  });
});

test('the four checkpoint reads reach their routes with their queries', async () => {
  const listed = await capture({ items: [], nextCursor: null }, (client) =>
    client.listWorkflowCheckpoints(77, { executionId: 12, descendants: 'true', limit: 50 }),
  );
  const listUrl = new URL(listed.url);
  assert.equal(listUrl.pathname, '/api/v1/workflows/runs/77/checkpoints');
  assert.equal(listUrl.searchParams.get('executionId'), '12');
  assert.equal(listUrl.searchParams.get('descendants'), 'true');

  const base = { kind: 'none', reason: 'folder_project' } as const;
  const detail = await capture(
    {
      checkpoint: {
        checkpointId: 'wcp_1',
        runId: 77,
        frameId: 1,
        executionId: 12,
        attemptId: 3,
        nodeId: 'save',
        title: 'Saved',
        createdAt: '2026-09-23T00:00:00.000Z',
        base,
        parentCheckpointId: null,
        artifactHash: 'sha256:pin',
        provenance: { repositoryRootPath: null },
        counts: { scopes: 0, files: 0, absences: 0, warnings: 0 },
        warningGroups: [],
        links: { inventory: '/i', manifest: '/m' },
      },
    },
    (client) => client.getWorkflowCheckpoint(77, 'wcp_1'),
  );
  assert.equal(new URL(detail.url).pathname, '/api/v1/workflows/runs/77/checkpoints/wcp_1');

  const inventory = await capture(
    { checkpointId: 'wcp_1', entries: [], nextCursor: null },
    (client) => client.listWorkflowCheckpointInventory(77, 'wcp_1', { cursor: 'next', limit: 500 }),
  );
  const inventoryUrl = new URL(inventory.url);
  assert.equal(inventoryUrl.pathname, '/api/v1/workflows/runs/77/checkpoints/wcp_1/inventory');
  assert.equal(inventoryUrl.searchParams.get('cursor'), 'next');

  const manifest = await capture(
    { checkpointId: 'wcp_1', entries: [], nextCursor: null },
    (client) => client.listWorkflowCheckpointManifest(77, 'wcp_1', {}),
  );
  assert.equal(
    new URL(manifest.url).pathname,
    '/api/v1/workflows/runs/77/checkpoints/wcp_1/manifest',
  );
});

test('checkpoint file bytes are fetched raw, with the download variant available as a URL', async () => {
  let seen: string | null = null;
  globalThis.fetch = ((input) => {
    seen = String(input);
    return Promise.resolve(new Response('saved bytes', { status: 200 }));
  }) as typeof fetch;

  const client = createRuntimeClient(runtimeUrl);
  const blob = await Effect.runPromise(
    client.fetchWorkflowCheckpointFileContent(77, 'wcp_1', 'wcf_2') as Effect.Effect<Blob, never>,
  );
  assert.equal(await blob.text(), 'saved bytes');
  assert.equal(
    seen,
    `${runtimeUrl}/api/v1/workflows/runs/77/checkpoints/wcp_1/files/wcf_2/content`,
  );
  assert.equal(
    client.workflowCheckpointFileContentUrl(77, 'wcp_1', 'wcf_2', { download: true }),
    `${runtimeUrl}/api/v1/workflows/runs/77/checkpoints/wcp_1/files/wcf_2/content?download=true`,
  );
});

for (const cause of ['missing', 'corrupt'] as const) {
  test(`${cause} checkpoint bytes come back as the structured rejection naming the file`, async () => {
    const data = {
      reason: 'workflow_checkpoint_content_unavailable',
      checkpointId: 'wcp_1',
      fileId: 'wcf_2',
      cause,
    };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'workflow_rejected',
              status: 400,
              message: 'gone',
              requestId: 'r',
              data,
            },
          }),
          { status: 400 },
        ),
      )) as typeof fetch;

    const failure = await Effect.runPromise(
      Effect.either(
        createRuntimeClient(runtimeUrl).fetchWorkflowCheckpointFileContent(77, 'wcp_1', 'wcf_2'),
      ),
    );
    assert.ok(failure._tag === 'Left');
    assert.deepEqual(apiErrorData(failure.left as RuntimeApiError<never>), data);
  });
}

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
    artifactHash: 'sha256:pin-1',
    workflowKey: 'review',
    sdkVersion: '0.1.0',
    verifierVersion: '0.1.0',
    pinOrdinal: 1,
    adoptedAt: '2026-09-15T10:00:00.000Z',
    descriptor: {
      descriptorVersion: 1,
      workflowContractVersion: 3,
      rootGraphKey: 'root',
      graphs: [],
    },
  };
}

function controlOutput() {
  return { runId: 77, accepted: true, status: 'running', revision: 4, diagnostics: [] };
}
