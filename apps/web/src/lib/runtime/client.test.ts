import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import type {
  AddProjectOutput,
  ApiError,
  CreateSurfaceOutput,
  DeleteSurfaceOutput,
  Project,
  RenameSurfaceOutput,
  WorkspaceSnapshot,
} from '@isagi/contracts';

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
      parked: false,
      surfaces: [],
      activeSurfaceId: null,
    },
  ],
} satisfies Project;

const addProjectOutput = {
  projectId: project.id,
  alreadyExisted: false,
} satisfies AddProjectOutput;

const renameSurfaceOutput = {
  surfaceId: 7,
  title: 'Terminal',
} satisfies RenameSurfaceOutput;

const deleteSurfaceOutput = {
  deletedSurfaceId: 7,
  deletedPaneIds: [11],
} satisfies DeleteSurfaceOutput;

const launchAgentSurfaceOutput = {
  worktreeId: 10,
  surfaceId: 42,
  paneId: 7,
  title: 'OpenCode',
} satisfies CreateSurfaceOutput;

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

test('runtime client interpolates path params', async () => {
  let requestedUrl = '';
  globalThis.fetch = ((input) => {
    requestedUrl = String(input);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: { projectId: 42, deleted: true },
          meta: { requestId: 'req-delete' },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const output = await Effect.runPromise(
    createRuntimeClient('http://runtime.test').deleteProject(42),
  );

  assert.equal(requestedUrl, 'http://runtime.test/api/v1/projects/42');
  assert.deepEqual(output, { projectId: 42, deleted: true });
});

test('runtime client calls the worktree commands endpoint', async () => {
  let requestedUrl = '';
  globalThis.fetch = ((input) => {
    requestedUrl = String(input);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: { status: 'configured', worktreeId: 10, commands: [], removedCommands: [] },
          meta: { requestId: 'req-commands' },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const output = await Effect.runPromise(
    createRuntimeClient('http://runtime.test').fetchWorktreeCommands(10),
  );

  assert.equal(requestedUrl, 'http://runtime.test/api/v1/worktrees/10/commands');
  assert.deepEqual(output, {
    status: 'configured',
    worktreeId: 10,
    commands: [],
    removedCommands: [],
  });
});

test('runtime client calls surface title and delete endpoints', async () => {
  const requests: Array<{ readonly url: string; readonly method: string; readonly body: string }> =
    [];
  globalThis.fetch = ((input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
    });
    const data = requests.length === 1 ? renameSurfaceOutput : deleteSurfaceOutput;
    return Promise.resolve(
      new Response(JSON.stringify({ data, meta: { requestId: `req-${requests.length}` } }), {
        status: 200,
      }),
    );
  }) as typeof fetch;

  const client = createRuntimeClient('http://runtime.test');
  assert.deepEqual(await Effect.runPromise(client.renameSurfaceTitle(7, 'Terminal')), {
    surfaceId: 7,
    title: 'Terminal',
  });
  assert.deepEqual(await Effect.runPromise(client.deleteSurfacePane(7, 11)), deleteSurfaceOutput);

  assert.deepEqual(requests, [
    {
      url: 'http://runtime.test/api/v1/surfaces/7/title',
      method: 'PUT',
      body: JSON.stringify({ title: 'Terminal' }),
    },
    {
      url: 'http://runtime.test/api/v1/surfaces/7/panes/11',
      method: 'DELETE',
      body: '',
    },
  ]);
});

test('runtime client calls agent surface launch endpoint with harness', async () => {
  let request: { readonly url: string; readonly method: string; readonly body: string } | null =
    null;
  globalThis.fetch = ((input, init) => {
    request = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
    };
    return Promise.resolve(
      new Response(
        JSON.stringify({ data: launchAgentSurfaceOutput, meta: { requestId: 'req-launch' } }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const output = await Effect.runPromise(
    createRuntimeClient('http://runtime.test').launchAgentSurface(10, { harness: 'opencode' }),
  );

  assert.deepEqual(output, launchAgentSurfaceOutput);
  assert.deepEqual(request, {
    url: 'http://runtime.test/api/v1/worktrees/10/agent-surfaces',
    method: 'POST',
    body: JSON.stringify({ harness: 'opencode' }),
  });
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
