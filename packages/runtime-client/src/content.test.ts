import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { workflowContentEndpoints } from '@isagi/contracts';

import {
  contentEndpointUrl,
  requestContent,
  RuntimeApiError,
  RuntimeDecodeError,
  RuntimeTransportError,
} from './index.js';

const runtimeUrl = 'http://runtime.test';
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('a content URL interpolates its params and names the download variant only when asked', () => {
  const endpoint = workflowContentEndpoints.getCheckpointFileContent;
  const params = { runId: 77, checkpointId: 'wcp_1', fileId: 'wcf_2' };
  assert.equal(
    contentEndpointUrl(runtimeUrl, endpoint, params),
    `${runtimeUrl}/api/v1/workflows/runs/77/checkpoints/wcp_1/files/wcf_2/content`,
  );
  assert.equal(
    contentEndpointUrl(runtimeUrl, endpoint, params, { download: true }),
    `${runtimeUrl}/api/v1/workflows/runs/77/checkpoints/wcp_1/files/wcf_2/content?download=true`,
  );
});

test('a successful content request hands back the response with its body unread', async () => {
  let seen = '';
  globalThis.fetch = ((input) => {
    seen = String(input);
    return Promise.resolve(new Response('round one verdict', { status: 200 }));
  }) as typeof fetch;

  const response = await Effect.runPromise(
    requestContent(runtimeUrl, workflowContentEndpoints.getEvidenceContent, {
      runId: 77,
      evidenceKey: 'wev_abc',
    }) as Effect.Effect<Response, never>,
  );

  assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), 'round one verdict');
  assert.equal(seen, `${runtimeUrl}/api/v1/workflows/runs/77/evidence/wev_abc/content`);
});

test('an unreadable capture comes back as the structured rejection, not as empty bytes', async () => {
  const data = {
    reason: 'workflow_evidence_content_unavailable',
    evidenceKey: 'wev_abc',
    cause: 'missing',
  };
  globalThis.fetch = rejecting(data);

  const error = await Effect.runPromise(
    Effect.flip(
      requestContent(runtimeUrl, workflowContentEndpoints.getEvidenceContent, {
        runId: 77,
        evidenceKey: 'wev_abc',
      }),
    ),
  );

  assert.ok(error instanceof RuntimeApiError);
  assert.equal(error.apiError.code, 'workflow_rejected');
  assert.deepEqual(apiErrorData(error), data);
});

for (const cause of ['missing', 'corrupt'] as const) {
  test(`${cause} checkpoint bytes come back as the structured rejection naming the file`, async () => {
    const data = {
      reason: 'workflow_checkpoint_content_unavailable',
      checkpointId: 'wcp_1',
      fileId: 'wcf_2',
      cause,
    };
    globalThis.fetch = rejecting(data);

    const error = await Effect.runPromise(
      Effect.flip(
        requestContent(runtimeUrl, workflowContentEndpoints.getCheckpointFileContent, {
          runId: 77,
          checkpointId: 'wcp_1',
          fileId: 'wcf_2',
        }),
      ),
    );

    assert.ok(error instanceof RuntimeApiError);
    assert.deepEqual(apiErrorData(error), data);
  });
}

test('an infrastructure error envelope on a content route decodes through the base arm', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: 'api_route_not_found',
            status: 404,
            message: 'Route not found',
            requestId: 'r',
            data: { method: 'GET', url: '/x' },
          },
        }),
        { status: 404 },
      ),
    )) as typeof fetch;

  const error = await Effect.runPromise(
    Effect.flip(
      requestContent(runtimeUrl, workflowContentEndpoints.getEvidenceContent, {
        runId: 77,
        evidenceKey: 'wev_abc',
      }),
    ),
  );

  assert.ok(error instanceof RuntimeApiError);
  assert.equal(error.apiError.code, 'api_route_not_found');
});

test('a non-OK content response without an envelope is a decode error', async () => {
  globalThis.fetch = (() =>
    Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))) as typeof fetch;

  const error = await Effect.runPromise(
    Effect.flip(
      requestContent(runtimeUrl, workflowContentEndpoints.getEvidenceContent, {
        runId: 77,
        evidenceKey: 'wev_abc',
      }),
    ),
  );

  assert.ok(error instanceof RuntimeDecodeError);
});

test('an unreachable content route is a transport error', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('network down'))) as typeof fetch;

  const error = await Effect.runPromise(
    Effect.flip(
      requestContent(runtimeUrl, workflowContentEndpoints.getEvidenceContent, {
        runId: 77,
        evidenceKey: 'wev_abc',
      }),
    ),
  );

  assert.ok(error instanceof RuntimeTransportError);
});

function rejecting(data: Record<string, unknown>) {
  return (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: { code: 'workflow_rejected', status: 400, message: 'gone', requestId: 'r', data },
        }),
        { status: 400 },
      ),
    )) as typeof fetch;
}

function apiErrorData(error: RuntimeApiError): unknown {
  return 'data' in error.apiError ? error.apiError.data : undefined;
}
