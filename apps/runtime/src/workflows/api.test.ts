import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Either } from 'effect';
import Fastify from 'fastify';

import { GitCommandError } from '../git/index.js';
import { DatabaseError } from '../persistence/index.js';
import { registerWorkflowApi } from './api.js';
import { WorkflowEngine } from './engine/interpreter.service.js';
import { WorkflowRunProjection } from './read/projection.service.js';
import { WorkflowEngineError } from './types.js';

/**
 * The HTTP boundary itself: envelopes, decoding, and the mapping from an engine's own vocabulary to
 * the wire's. The read model's behaviour is proved against real records in `read/`; what matters
 * here is that a route hands its inputs on unchanged and that a rejection reaches the client as the
 * structured answer it is, rather than as an internal error.
 */

function withServices(services: {
  readonly engine?: Record<string, unknown>;
  readonly projection?: Record<string, unknown>;
}) {
  return {
    runPromise: async <A>(effect: Effect.Effect<A, unknown, never>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(WorkflowEngine, (services.engine ?? {}) as never),
          Effect.provideService(WorkflowRunProjection, (services.projection ?? {}) as never),
        ) as Effect.Effect<A, unknown, never>,
      ),
  } as never;
}

function body<T>(raw: string) {
  return JSON.parse(raw) as T;
}

test('the descriptors route returns manifests and unavailable workflows side by side', async () => {
  const fastify = Fastify({ logger: false });
  let seen: unknown = null;
  registerWorkflowApi(
    fastify,
    withServices({
      engine: {
        listWorkflowDescriptors: (input: unknown) =>
          Effect.sync(() => {
            seen = input;
            return [
              {
                workflowKey: 'ship-it',
                result: {
                  ok: true,
                  manifest: {
                    title: 'Ship it',
                    description: 'Runs the release checklist.',
                    inputs: [{ kind: 'text', key: 'version', label: 'Version' }],
                  },
                },
              },
              {
                workflowKey: 'broken',
                result: {
                  ok: false,
                  reason: 'artifact_load_failed',
                  diagnostics: [{ code: 'invalid_export', message: 'No default export.', at: {} }],
                },
              },
            ];
          }),
      },
    }),
  );

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/descriptors',
    payload: { origin: { worktreeId: 7, surfaceId: 42, paneId: 99, agentSessionId: 100 } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, {
    origin: { worktreeId: 7, surfaceId: 42, paneId: 99, agentSessionId: 100 },
  });
  const decoded = body<{ data: { workflows: readonly Record<string, unknown>[] } }>(response.body);
  assert.equal(decoded.data.workflows.length, 2);
  assert.deepEqual(decoded.data.workflows[1], {
    ok: false,
    workflowKey: 'broken',
    reason: 'artifact_load_failed',
    diagnostics: [{ code: 'invalid_export', message: 'No default export.', at: {} }],
  });
});

test('the start route passes launch inputs and origin through unchanged', async () => {
  const fastify = Fastify({ logger: false });
  let seen: unknown = null;
  registerWorkflowApi(
    fastify,
    withServices({
      engine: {
        startWorkflow: (input: unknown) =>
          Effect.sync(() => {
            seen = input;
            return { id: 123, workflowKey: 'ship-it' };
          }),
      },
    }),
  );

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/runs',
    payload: {
      workflowKey: 'ship-it',
      inputs: { version: '1.2.3' },
      origin: { worktreeId: 7, surfaceId: 42 },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, {
    workflowKey: 'ship-it',
    inputs: { version: '1.2.3' },
    origin: { worktreeId: 7, surfaceId: 42 },
  });
  assert.deepEqual(body<{ data: unknown }>(response.body).data, {
    runId: 123,
    workflowKey: 'ship-it',
  });
});

test('a paginated read passes its filters, limit and cursor to the projection', async () => {
  const fastify = Fastify({ logger: false });
  let seen: unknown = null;
  registerWorkflowApi(
    fastify,
    withServices({
      projection: {
        listOperations: (runId: number, query: unknown) =>
          Effect.sync(() => {
            seen = { runId, query };
            return { items: [], nextCursor: null };
          }),
      },
    }),
  );

  const response = await fastify.inject({
    method: 'GET',
    url: '/api/v1/workflows/runs/9/operations?executionId=4&state=uncertain&limit=25&cursor=abc',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, {
    runId: 9,
    query: { executionId: 4, state: 'uncertain', limit: 25, cursor: 'abc' },
  });
});

test('an over-large page limit is refused at the boundary rather than silently clamped', async () => {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(
    fastify,
    withServices({
      projection: {
        listOperations: () => Effect.succeed({ items: [], nextCursor: null }),
      },
    }),
  );

  const response = await fastify.inject({
    method: 'GET',
    url: '/api/v1/workflows/runs/9/operations?limit=501',
  });

  assert.equal(response.statusCode, 400);
  assert.equal(
    body<{ error: { code: string } }>(response.body).error.code,
    'api_request_decoding_failed',
  );
});

test('a rejected cursor reaches the client as its own reason, and says nothing about the cursor', async () => {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(
    fastify,
    withServices({
      projection: {
        listEvents: () =>
          Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_cursor_invalid',
              message: 'This pagination cursor is not one this listing will continue.',
            }),
          ),
      },
    }),
  );

  const response = await fastify.inject({
    method: 'GET',
    url: '/api/v1/workflows/runs/3/events?cursor=not-a-cursor',
  });

  assert.equal(response.statusCode, 400);
  const decoded = body<{ error: { data: { reason: string }; message: string } }>(response.body);
  assert.equal(decoded.error.data.reason, 'workflow_cursor_invalid');
  assert.ok(!decoded.error.message.includes('not-a-cursor'));
});

test('an unreadable payload carries which value failed and why', async () => {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(
    fastify,
    withServices({
      projection: {
        getPayload: () =>
          Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_payload_unavailable',
              message: 'Recorded value sha256:abc no longer matches its reference.',
              workflowRunId: 3,
              payloadRef: 'sha256:abc',
              payloadCause: 'corrupt',
            }),
          ),
      },
    }),
  );

  const response = await fastify.inject({
    method: 'GET',
    url: '/api/v1/workflows/runs/3/payloads/sha256%3Aabc',
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(body<{ error: { data: unknown } }>(response.body).error.data, {
    reason: 'workflow_payload_unavailable',
    payloadRef: 'sha256:abc',
    cause: 'corrupt',
    workflowRunId: 3,
  });
});

test('a structural refusal carries its addressable diagnostics', async () => {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(
    fastify,
    withServices({
      engine: {
        retry: () =>
          Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_structure_validation_failed',
              message: 'The latest verified version no longer fits where this run is parked.',
              workflowRunId: 5,
              diagnostics: [
                {
                  code: 'node_missing',
                  message: 'Node writer is gone.',
                  at: { graphKey: 'root', nodeId: 'writer' },
                },
              ],
            }),
          ),
      },
    }),
  );

  const response = await fastify.inject({ method: 'POST', url: '/api/v1/workflows/runs/5/retry' });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(body<{ error: { data: unknown } }>(response.body).error.data, {
    reason: 'workflow_structure_validation_failed',
    diagnostics: [
      {
        code: 'node_missing',
        message: 'Node writer is gone.',
        at: { graphKey: 'root', nodeId: 'writer' },
      },
    ],
    workflowRunId: 5,
  });
});

test('an occupied surface is a conflict, and a discovery failure is the runtime admitting a fault', async () => {
  for (const [code, status] of [
    ['workflow_surface_attached', 409],
    ['workflow_discovery_failed', 500],
    ['workflow_run_not_dismissible', 400],
  ] as const) {
    const fastify = Fastify({ logger: false });
    registerWorkflowApi(
      fastify,
      withServices({
        engine: {
          dismiss: () => Effect.fail(new WorkflowEngineError({ code, message: 'nope' })),
        },
      }),
    );
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/workflows/runs/5/dismiss',
    });
    assert.equal(response.statusCode, status, code);
  }
});

test('a database failure is reported as one, not as a workflow rejection', async () => {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(
    fastify,
    withServices({
      projection: {
        getRun: () =>
          Effect.fail(new DatabaseError({ operation: 'workflow_get_run', cause: new Error('io') })),
      },
    }),
  );

  const response = await fastify.inject({ method: 'GET', url: '/api/v1/workflows/runs/4' });

  assert.equal(response.statusCode, 500);
  assert.equal(
    body<{ error: { code: string } }>(response.body).error.code,
    'runtime_database_failed',
  );
});

test('every control returns the narrow accepted-action fact and nothing more', async () => {
  const controls = ['pause', 'resume', 'retry', 'cancel', 'dismiss'] as const;
  for (const control of controls) {
    const fastify = Fastify({ logger: false });
    registerWorkflowApi(
      fastify,
      withServices({
        engine: {
          [control]: () =>
            Effect.succeed({
              runId: 7,
              accepted: true,
              status: 'running',
              revision: 12,
              diagnostics: [],
            }),
        },
      }),
    );
    const response = await fastify.inject({
      method: 'POST',
      url: `/api/v1/workflows/runs/7/${control}`,
    });
    assert.equal(response.statusCode, 200, control);
    assert.deepEqual(body<{ data: unknown }>(response.body).data, {
      runId: 7,
      accepted: true,
      status: 'running',
      revision: 12,
      diagnostics: [],
    });
  }
});

test('advance addresses a wait by its own identity', async () => {
  const fastify = Fastify({ logger: false });
  let seen: unknown = null;
  registerWorkflowApi(
    fastify,
    withServices({
      engine: {
        advance: (input: unknown) =>
          Effect.sync(() => {
            seen = input;
            return { runId: 7, accepted: true, status: 'ready', revision: 3, diagnostics: [] };
          }),
      },
    }),
  );

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/runs/7/advance',
    payload: { waitId: 44, answers: { risk: 'medium' } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, { runId: 7, waitId: 44, answers: { risk: 'medium' } });
});

test('an advance without a wait identity is refused before it reaches the engine', async () => {
  const fastify = Fastify({ logger: false });
  let called = false;
  registerWorkflowApi(
    fastify,
    withServices({
      engine: {
        advance: () =>
          Effect.sync(() => {
            called = true;
            return { runId: 7, accepted: true, status: 'ready', revision: 3, diagnostics: [] };
          }),
      },
    }),
  );

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/runs/7/advance',
    payload: { answers: { risk: 'medium' } },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(called, false);
});

test('the websocket stream and the destructive clear route are gone', async () => {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(fastify, withServices({}));
  await fastify.ready();
  for (const url of ['/api/v1/workflows/runs/1/events-stream', '/api/v1/workflows/runs/1/clear']) {
    const response = await fastify.inject({ method: 'POST', url });
    assert.equal(response.statusCode, 404, url);
  }
  assert.ok(Either.isRight(Either.right(true)));
});

test('a load failure keeps its stable reason in structured data, not in prose', async () => {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(
    fastify,
    withServices({
      engine: {
        startWorkflow: () =>
          Effect.fail(
            new WorkflowEngineError({
              code: 'workflow_load_failed',
              message: 'Workflow source differs from the verified build.',
              workflowKey: 'stale',
              workflowLoadFailureReason: 'stale_source',
              workflowSourceDirectory: '/repo/src/workflows/stale',
              workflowPackageDirectory: '/repo/.isagi/workflows/stale',
            }),
          ),
      },
    }),
  );

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/runs',
    payload: { workflowKey: 'stale', origin: { worktreeId: 1, surfaceId: 2 } },
  });

  assert.equal(response.statusCode, 400);
  // The client branches on the reason, never on the sentence: copy is the web app's to own.
  assert.deepEqual(body<{ error: { data: unknown } }>(response.body).error.data, {
    reason: 'workflow_load_failed',
    workflowKey: 'stale',
    workflowLoadFailureReason: 'stale_source',
    workflowSourceDirectory: '/repo/src/workflows/stale',
    workflowPackageDirectory: '/repo/.isagi/workflows/stale',
  });
});

test('a stale control is reported as one, and a refused launch or control changes nothing', async () => {
  const calls: string[] = [];
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(
    fastify,
    withServices({
      engine: {
        resume: () =>
          Effect.sync(() => {
            calls.push('resume');
          }).pipe(
            Effect.zipRight(
              Effect.fail(
                new WorkflowEngineError({
                  code: 'workflow_stale_control',
                  message: 'This run moved on since the control was prepared.',
                  workflowRunId: 8,
                }),
              ),
            ),
          ),
      },
      projection: {
        getRun: () =>
          Effect.sync(() => {
            calls.push('read');
            return { run: { runId: 8 } as never };
          }),
      },
    }),
  );

  const refused = await fastify.inject({ method: 'POST', url: '/api/v1/workflows/runs/8/resume' });
  assert.equal(refused.statusCode, 400);
  assert.deepEqual(body<{ error: { data: unknown } }>(refused.body).error.data, {
    reason: 'workflow_stale_control',
    workflowRunId: 8,
  });
  // A refused control reaches the engine once and stops there: the route does not retry it, does not
  // fall back to another control, and does not read anything back to "fix up" the response.
  assert.deepEqual(calls, ['resume']);
});

test('a Git failure under a launch is reported as a Git failure, not as an unhandled error', async () => {
  const fastify = Fastify({ logger: false });
  registerWorkflowApi(
    fastify,
    withServices({
      engine: {
        // The launch path makes one owning-service call — the worktree-creation preflight — so Git
        // can fail underneath a launch. It is infrastructure, not a placement the person chose
        // badly, and a client has to be able to tell those apart: a `workflow_rejected` says "fix
        // your request", this says "something broke underneath it".
        startWorkflow: () =>
          Effect.fail(
            new GitCommandError({
              args: ['-C', '/repo', 'rev-parse', '--verify', 'origin/main^{commit}'],
              cwd: '/repo',
              stderr: 'fatal: not a git repository',
              failure: { kind: 'exited', exitCode: 128 },
              cause: new Error('git exited 128'),
            }),
          ),
      },
    }),
  );

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/v1/workflows/runs',
    payload: {
      workflowKey: 'placeable',
      origin: { worktreeId: 1, surfaceId: 2 },
      placement: {
        worktree: { kind: 'create', branch: 'feat/new', fromRef: 'origin/main' },
        surface: { kind: 'create', title: 'New work' },
      },
    },
  });

  assert.equal(response.statusCode, 500);
  const decoded = body<{ error: { code: string; data: { args: string[]; cwd: string | null } } }>(
    response.body,
  );
  // The same envelope `workspace/api.ts` produces for the same failure: one shared mapper, so a
  // client never has to learn which route it happened to hit.
  assert.equal(decoded.error.code, 'git_command_failed');
  assert.deepEqual(decoded.error.data.args, [
    '-C',
    '/repo',
    'rev-parse',
    '--verify',
    'origin/main^{commit}',
  ]);
  assert.equal(decoded.error.data.cwd, '/repo');
});
