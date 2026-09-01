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
  ClientSettingsOutput,
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

const createSurfaceOutput = {
  worktreeId: 10,
  surfaceId: 42,
  paneId: 7,
  title: 'OpenCode',
} satisfies CreateSurfaceOutput;

const originalFetch = globalThis.fetch;
const clientSettings = {
  terminal: {
    scrollbackLines: 5_000,
    cache: {
      idleTtlMinutes: 180,
      maxHiddenSessions: 4,
      maxEstimatedBufferMiB: 64,
    },
  },
} satisfies ClientSettingsOutput;

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

test('runtime client requests and decodes client settings without applying defaults', async () => {
  let requestedUrl = '';
  globalThis.fetch = ((input) => {
    requestedUrl = String(input);
    return Promise.resolve(
      new Response(JSON.stringify({ data: clientSettings, meta: { requestId: 'req-settings' } }), {
        status: 200,
      }),
    );
  }) as typeof fetch;

  const output = await Effect.runPromise(
    createRuntimeClient('http://runtime.test').fetchClientSettings(),
  );

  assert.equal(requestedUrl, 'http://runtime.test/api/v1/client-settings');
  assert.deepEqual(output, clientSettings);
});

test('runtime client rejects malformed client settings instead of applying defaults', async () => {
  globalThis.fetch = mockFetch(
    new Response(
      JSON.stringify({
        data: { terminal: { cache: clientSettings.terminal.cache } },
        meta: { requestId: 'req-settings-invalid' },
      }),
      { status: 200 },
    ),
  );

  const error = await Effect.runPromise(
    Effect.flip(createRuntimeClient('http://runtime.test').fetchClientSettings()),
  );

  assert.ok(error instanceof RuntimeDecodeError);
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

test('runtime client resolves command log stream websocket URLs', () => {
  const client = createRuntimeClient('https://runtime.test/base/');

  assert.equal(
    client.resolveCommandLogStreamWebSocketUrl(10, 'dev server'),
    'wss://runtime.test/api/v1/worktrees/10/commands/log-stream?commandName=dev+server',
  );
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

test('runtime client calls surface creation endpoint with initial pane', async () => {
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
        JSON.stringify({ data: createSurfaceOutput, meta: { requestId: 'req-create-surface' } }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const output = await Effect.runPromise(
    createRuntimeClient('http://runtime.test').createSurface(10, {
      initialPane: { kind: 'agent_session', harness: 'opencode' },
    }),
  );

  assert.deepEqual(output, createSurfaceOutput);
  assert.deepEqual(request, {
    url: 'http://runtime.test/api/v1/worktrees/10/surfaces',
    method: 'POST',
    body: JSON.stringify({ initialPane: { kind: 'agent_session', harness: 'opencode' } }),
  });
});

test('runtime client sends workflow start variables in the request body', async () => {
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
        JSON.stringify({
          data: { workflowRunId: 77, workflowKey: 'argument-probe' },
          meta: { requestId: 'req-workflow-start' },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const output = await Effect.runPromise(
    createRuntimeClient('http://runtime.test').startWorkflow({
      workflowKey: 'argument-probe',
      variables: {
        text: 'hello',
        select: 'no',
        multi: ['a', 'b'],
        confirm: true,
      },
      context: { worktreeId: 10, surfaceId: 42, paneId: 7, agentSessionId: 99 },
    }),
  );

  assert.deepEqual(output, { workflowRunId: 77, workflowKey: 'argument-probe' });
  assert.deepEqual(request, {
    url: 'http://runtime.test/api/v1/workflows/runs',
    method: 'POST',
    body: JSON.stringify({
      workflowKey: 'argument-probe',
      variables: {
        text: 'hello',
        select: 'no',
        multi: ['a', 'b'],
        confirm: true,
      },
      context: { worktreeId: 10, surfaceId: 42, paneId: 7, agentSessionId: 99 },
    }),
  });
});

test('runtime client calls split pane endpoint with source pane and new pane spec', async () => {
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
        JSON.stringify({ data: createSurfaceOutput, meta: { requestId: 'req-split-pane' } }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const output = await Effect.runPromise(
    createRuntimeClient('http://runtime.test').splitPane(10, {
      paneId: 7,
      direction: 'right',
      newPane: { kind: 'terminal_session' },
    }),
  );

  assert.deepEqual(output, createSurfaceOutput);
  assert.deepEqual(request, {
    url: 'http://runtime.test/api/v1/worktrees/10/pane-splits',
    method: 'POST',
    body: JSON.stringify({
      paneId: 7,
      direction: 'right',
      newPane: { kind: 'terminal_session' },
    }),
  });
});

test('runtime client calls each rail order endpoint with its scope and anchor', async () => {
  const requests: Array<{ readonly url: string; readonly method: string; readonly body: string }> =
    [];
  const outputs = [
    { projectId: 1 },
    { projectId: 1, worktreeId: 13 },
    { worktreeId: 12, surfaceId: 123 },
  ];
  globalThis.fetch = ((input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: outputs[requests.length - 1],
          meta: { requestId: `req-order-${requests.length}` },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const client = createRuntimeClient('http://runtime.test');
  // A null anchor is "move to the end", and it has to survive as JSON null
  // rather than being dropped from the body.
  assert.deepEqual(
    await Effect.runPromise(client.moveProjectOrder(1, { beforeProjectId: null })),
    outputs[0],
  );
  assert.deepEqual(
    await Effect.runPromise(client.moveWorktreeOrder(1, 13, { beforeWorktreeId: 12 })),
    outputs[1],
  );
  assert.deepEqual(
    await Effect.runPromise(client.moveSurfaceOrder(12, 123, { beforeSurfaceId: 121 })),
    outputs[2],
  );

  assert.deepEqual(requests, [
    {
      url: 'http://runtime.test/api/v1/projects/1/order',
      method: 'PUT',
      body: JSON.stringify({ beforeProjectId: null }),
    },
    {
      url: 'http://runtime.test/api/v1/projects/1/worktrees/13/order',
      method: 'PUT',
      body: JSON.stringify({ beforeWorktreeId: 12 }),
    },
    {
      url: 'http://runtime.test/api/v1/worktrees/12/surfaces/123/order',
      method: 'PUT',
      body: JSON.stringify({ beforeSurfaceId: 121 }),
    },
  ]);
});

test('runtime client surfaces rail order refusals as typed API errors', async () => {
  const apiError = {
    code: 'surface_order_rejected',
    status: 400,
    message: 'surface 123 does not belong to worktree 12',
    requestId: 'req-order-refused',
    data: {
      reason: 'surface_worktree_mismatch',
      worktreeId: 12,
      surfaceId: 123,
      beforeSurfaceId: 121,
    },
  } satisfies ApiError;

  globalThis.fetch = mockFetch(new Response(JSON.stringify({ error: apiError }), { status: 400 }));

  const error = await Effect.runPromise(
    Effect.flip(
      createRuntimeClient('http://runtime.test').moveSurfaceOrder(12, 123, {
        beforeSurfaceId: 121,
      }),
    ),
  );

  assert.ok(error instanceof RuntimeApiError);
  assert.equal(error.apiError.code, 'surface_order_rejected');
  assert.deepEqual(error.apiError.data, {
    reason: 'surface_worktree_mismatch',
    worktreeId: 12,
    surfaceId: 123,
    beforeSurfaceId: 121,
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

// ---------------------------------------------------------------------------
// Editor
//
// Every one of these is a transport shape a type-checker cannot catch: a params
// object mistaken for a body, a query flattened into params, an argument order
// reversed. They are asserted here so the mistake fails in this suite rather
// than as a 404 or an `api_response_encoding_failed` at runtime.
// ---------------------------------------------------------------------------

const editorContextFacts = {
  id: 7,
  worktreeId: 10,
  activePtyProcessId: null,
  attempt: { state: 'none' },
  processStatus: null,
  processDiagnostic: null,
  processDiagnosticDetail: null,
  workbenchReadiness: null,
  readinessDetail: null,
  endpoint: null,
  hasDiagnostics: false,
  createdAt: '2026-08-31T09:00:00.000Z',
  updatedAt: '2026-08-31T09:00:00.000Z',
};

function captureRequest(data: unknown) {
  const captured: { url: string; method: string | undefined; body: string | null } = {
    url: '',
    method: undefined,
    body: null,
  };
  globalThis.fetch = ((input, init) => {
    captured.url = String(input);
    captured.method = init?.method;
    captured.body = typeof init?.body === 'string' ? init.body : null;
    return Promise.resolve(
      new Response(JSON.stringify({ data, meta: { requestId: 'req-editor' } }), { status: 200 }),
    );
  }) as typeof fetch;
  return captured;
}

test('runtime client opens an editor by worktree path parameter, with no body', async () => {
  const captured = captureRequest({
    worktreeId: 10,
    surfaceId: 501,
    paneId: 601,
    editorContextId: 7,
  });

  const output = await Effect.runPromise(createRuntimeClient('http://runtime.test').openEditor(10));

  assert.equal(captured.url, 'http://runtime.test/api/v1/worktrees/10/editor');
  assert.equal(captured.method, 'POST');
  // The worktree is the whole input; a body would only invite a second target.
  assert.equal(captured.body, null);
  assert.deepEqual(output, { worktreeId: 10, surfaceId: 501, paneId: 601, editorContextId: 7 });
});

test('runtime client sends the ensure intent as a body, keyed by editor context', async () => {
  const captured = captureRequest({ editorContext: editorContextFacts });

  await Effect.runPromise(
    createRuntimeClient('http://runtime.test').ensureEditorRuntime(7, { intent: 'replace' }),
  );

  assert.equal(captured.url, 'http://runtime.test/api/v1/editor-contexts/7/runtime');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(JSON.parse(captured.body ?? 'null'), { intent: 'replace' });
});

test('runtime client names the incarnation as a query, not a second path parameter', async () => {
  const captured = captureRequest({
    editorContextId: 7,
    ptyProcessId: 48120,
    excerpt: 'listening on 127.0.0.1:41287',
    truncated: false,
    totalBytes: 28,
  });

  const output = await Effect.runPromise(
    createRuntimeClient('http://runtime.test').editorDiagnostics(7, 48120),
  );

  // Params, then query — the order `ApiEndpointRequestArgs` derives. Reversing
  // the two arguments would silently produce `/editor-contexts/48120/...`.
  assert.equal(
    captured.url,
    'http://runtime.test/api/v1/editor-contexts/7/diagnostics?ptyProcessId=48120',
  );
  assert.equal(captured.method, 'GET');
  assert.equal(output.ptyProcessId, 48120);
});

test('runtime client retries provisioning with no arguments at all', async () => {
  const captured = captureRequest({ provisioning: { status: 'checking', version: '4.135.0' } });

  const output = await Effect.runPromise(
    createRuntimeClient('http://runtime.test').retryEditorProvisioning(),
  );

  assert.equal(captured.url, 'http://runtime.test/api/v1/editor/provisioning/retry');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(output, { provisioning: { status: 'checking', version: '4.135.0' } });
});
