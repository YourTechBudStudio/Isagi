import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type { AddProjectOutput, ApiError, Project, WorkspaceSnapshot } from '@isagi/contracts';

import {
  createRuntimeClient,
  RuntimeApiError,
  RuntimeDecodeError,
  RuntimeTransportError,
} from './client.js';

const workspace = {
  projects: [],
} satisfies WorkspaceSnapshot;

const project = {
  id: 1,
  name: 'isagi',
  rootPath: '/repo/isagi',
  status: 'present',
  worktrees: [
    {
      id: 1,
      projectId: 1,
      title: 'main',
      path: '/repo/isagi',
      branch: 'main',
      head: 'abcdef0',
      isRoot: true,
      attention: 'idle',
      parked: false,
      surfaces: [],
      activeSurfaceId: null,
      commands: [],
    },
  ],
} satisfies Project;

const addProjectOutput = {
  projectId: project.id,
  alreadyExisted: false,
} satisfies AddProjectOutput;

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('runtime client decodes success envelopes', async () => {
  globalThis.fetch = mockFetch(
    new Response(JSON.stringify({ data: workspace, meta: { requestId: 'req-success' } }), {
      status: 200,
    }),
  );

  const snapshot = await Effect.runPromise(
    createRuntimeClient('http://runtime.test').fetchWorkspace(),
  );

  assert.deepEqual(snapshot, workspace);
});

test('runtime client decodes minimal mutation success envelopes', async () => {
  globalThis.fetch = mockFetch(
    new Response(JSON.stringify({ data: addProjectOutput, meta: { requestId: 'req-add' } }), {
      status: 200,
    }),
  );

  const output = await Effect.runPromise(
    createRuntimeClient('http://runtime.test').addProject('/repo/isagi'),
  );

  assert.deepEqual(output, addProjectOutput);
});

test('runtime client decodes endpoint API errors before base API errors', async () => {
  const apiError = {
    code: 'project_path_rejected',
    status: 400,
    message: 'Not a Git repository: /repo/nope',
    requestId: 'req-api-error',
    data: { reason: 'not_git_repository', path: '/repo/nope' },
  } satisfies ApiError;

  globalThis.fetch = mockFetch(
    new Response(JSON.stringify({ error: apiError }), {
      status: 400,
    }),
  );

  const error = await Effect.runPromise(
    Effect.flip(createRuntimeClient('http://runtime.test').addProject('/repo/nope')),
  );

  assert.ok(error instanceof RuntimeApiError);
  assert.equal(error.apiError.code, 'project_path_rejected');
  assert.equal(error.apiError.requestId, 'req-api-error');
});

test('runtime client classifies invalid success envelopes as decode errors', async () => {
  globalThis.fetch = mockFetch(
    new Response(JSON.stringify({ data: { invalid: true }, meta: { requestId: 'req-invalid' } }), {
      status: 200,
    }),
  );

  const error = await Effect.runPromise(
    Effect.flip(createRuntimeClient('http://runtime.test').fetchWorkspace()),
  );

  assert.ok(error instanceof RuntimeDecodeError);
});

test('runtime client passes Effect interruption to fetch', async () => {
  let resolveStarted!: () => void;
  let resolveAborted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });

  globalThis.fetch = ((_input, init) =>
    new Promise<Response>((resolve) => {
      resolveStarted();
      init?.signal?.addEventListener(
        'abort',
        () => {
          resolveAborted();
          resolve(
            new Response(JSON.stringify({ data: workspace, meta: { requestId: 'req-aborted' } }), {
              status: 200,
            }),
          );
        },
        { once: true },
      );
    })) as typeof fetch;

  const controller = new AbortController();
  const request = Effect.runPromise(createRuntimeClient('http://runtime.test').fetchWorkspace(), {
    signal: controller.signal,
  }).catch(() => {});

  await started;
  controller.abort();
  await aborted;
  await request;
});

test('runtime client classifies fetch failures as transport errors', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('network down'))) as typeof fetch;

  const error = await Effect.runPromise(
    Effect.flip(createRuntimeClient('http://runtime.test').fetchWorkspace()),
  );

  assert.ok(error instanceof RuntimeTransportError);
});

function mockFetch(response: Response) {
  return (() => Promise.resolve(response.clone())) as typeof fetch;
}
