// Whole-runtime smoke: boots the real runtime against a temp data dir and a temp Git repo, then
// drives one user path end to end through the public HTTP and WebSocket API. Every response is
// decoded with the contract schemas, so this pins wire behavior (status, code, envelope shape)
// across the Effect v4 port and the runtime module refactor. Pinned values were observed on v3.
//
// The helpers below are deliberately inline: `@isagi/testing` (handle diff, process probe, log
// capture, fiber probe) does not exist yet, and the final enforcement stage switches this file to it.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Effect, Result, Schema } from 'effect';
import type { FastifyInstance } from 'fastify';

import {
  apiBaseErrorResponseSchema,
  apiBasePath,
  apiEndpoints,
  apiErrorResponseSchema,
  apiInfrastructureErrorSchema,
  apiSuccessResponseSchema,
  ptyWebSocketOutputMessageSchema,
  runtimeEventSchema,
  runtimeEventsWebSocketEndpoint,
  terminalSessionPtyWebSocketEndpoint,
  type AnyApiEndpoint,
  type ApiEndpointOutput,
  type ApiError,
  type RuntimeEvent,
  type WireSchema,
} from '@isagi/contracts';

import { startRuntimeServer } from '../http-server.js';

describe('runtime smoke', () => {
  const marker = `isagi-smoke-${randomUUID()}`;
  let runtime: SmokeRuntime;
  let events: RecordingSocket<RuntimeEvent>;
  let projectId: number;
  let worktreeId: number;
  let surfaceId: number;
  let paneId: number;
  let terminalSessionId: number;
  let terminal: TerminalAttach;

  before(async () => {
    runtime = await bootSmokeRuntime();
  });

  // Only does work when a flow failed before flow 12 shut the runtime down.
  after(async () => {
    events?.socket.close();
    terminal?.socket.socket.close();
    await runtime?.shutdown();
    await killProcessesMatching(marker);
  });

  test('flow 1: health responds', async () => {
    await callOk(runtime.server, apiEndpoints.health);
  });

  test('flow 2: a fresh data dir has an empty workspace', async () => {
    const workspace = await callOk(runtime.server, apiEndpoints.workspace.get);
    assert.deepEqual(workspace.projects, []);
  });

  test('flow 3: the runtime events socket opens', async () => {
    events = await openSocket(runtime, runtimeEventsWebSocketEndpoint.path, runtimeEventSchema);
    assert.equal(events.socket.readyState, WebSocket.OPEN);
  });

  test('flow 4: adding a project is idempotent by path', async () => {
    const added = await callOk(runtime.server, apiEndpoints.projects.add, {
      body: { path: runtime.repoDir },
    });
    assert.equal(added.alreadyExisted, false);
    projectId = added.projectId;

    const again = await callOk(runtime.server, apiEndpoints.projects.add, {
      body: { path: runtime.repoDir },
    });
    assert.deepEqual(again, { projectId, alreadyExisted: true });
  });

  test('flow 5: the workspace lists the project with its root worktree and keeps active context', async () => {
    const workspace = await callOk(runtime.server, apiEndpoints.workspace.get);
    assert.equal(workspace.projects.length, 1);
    const [project] = workspace.projects;
    assert.ok(project);
    assert.equal(project.id, projectId);
    assert.equal(project.status, 'present');
    assert.equal(project.rootPath, runtime.repoDir);
    const root = project.worktrees.find((worktree) => worktree.isRoot);
    assert.ok(root, 'the project has a root worktree');
    assert.equal(root.path, runtime.repoDir);
    assert.equal(root.branch, 'main');
    worktreeId = root.id;

    // Restoration is runtime-owned: the active context round-trips through the runtime.
    const activeContext = { projectId, worktreeId };
    const persisted = await callOk(runtime.server, apiEndpoints.workspace.setActiveContext, {
      body: { activeContext, revision: 1 },
    });
    assert.deepEqual(persisted.activeContext, activeContext);
    const restored = await callOk(runtime.server, apiEndpoints.workspace.getActiveContext);
    assert.deepEqual(restored.activeContext, activeContext);
  });

  test('flow 6: creating a terminal surface starts a terminal session in its first pane', async () => {
    const created = await callOk(runtime.server, apiEndpoints.surfaces.createSurface, {
      params: { worktreeId },
      body: { initialPane: { kind: 'terminal_session' } },
    });
    assert.equal(created.worktreeId, worktreeId);
    surfaceId = created.surfaceId;
    paneId = created.paneId;

    const detail = await callOk(runtime.server, apiEndpoints.surfaces.get, {
      params: { surfaceId },
    });
    assert.equal(detail.id, surfaceId);
    assert.deepEqual(
      detail.panes.map((pane) => pane.id),
      [paneId],
    );
    const session = detail.panes[0]?.session;
    assert.ok(session?.kind === 'terminal_session', 'the first pane holds a terminal session');
    terminalSessionId = session.terminalSession.id;
  });

  test('flow 7: a claimed terminal session attaches, runs input and accepts a resize', async () => {
    terminal = await claimAndAttachTerminal(runtime, { worktreeId, paneId, terminalSessionId });
    // Input sent before the attach finishes replaying is queued by the route; that ordering is
    // pinned by the PTY stream tests, so this flow only types once the shell prompt is visible.
    await waitFor(() => terminal.output().includes('$'), 'the shell prompt');

    terminal.socket.send({ type: 'input', data: 'echo smoke-$((40+2))\n' });
    await waitFor(() => terminal.output().includes('smoke-42'), 'the echoed command output');

    terminal.socket.send({ type: 'resize', cols: 100, rows: 30 });
    await delay(200);
    assert.deepEqual(errorMessages(terminal.socket), []);

    // The marker rides in argv (as `$0` of a child shell), not in a shell comment that never
    // reaches any process's argv, so the probe sees it and flow 11 can prove the tree is killed.
    terminal.socket.send({ type: 'input', data: `sh -c 'sleep 300; true' ${marker}\n` });
    await waitFor(
      async () => (await processesMatching(marker)).length > 0,
      'the marker process to start',
    );
    assert.deepEqual(errorMessages(terminal.socket), []);
    assert.equal(terminal.socket.closed, false);
  });

  test('flow 8: attaching without a token is refused with a stable code', async () => {
    const refused = await openSocket(
      runtime,
      terminalAttachPath(terminalSessionId),
      ptyWebSocketOutputMessageSchema,
    );
    try {
      await waitFor(() => refused.closed, 'the runtime to close the refused attach');
      assert.deepEqual(refused.decodeFailures, []);
      assert.deepEqual(
        refused.messages.map((message) =>
          message.type === 'error' ? { type: message.type, code: message.code } : message,
        ),
        [{ type: 'error', code: 'attach_token_missing' }],
      );
    } finally {
      await refused.close();
    }
  });

  test('flow 9: the events socket saw the surface, terminal session and attention changes', async () => {
    const expected = ['attention_source_changed', 'surface_changed', 'terminal_session_changed'];
    await waitFor(
      () => expected.every((type) => events.messages.some((event) => event.type === type)),
      `runtime events ${expected.join(', ')}`,
    );
    assert.deepEqual(events.decodeFailures, []);
  });

  test('flow 10: failures use the stable error envelope', async () => {
    const missingSurface = await callApi(runtime.server, apiEndpoints.surfaces.get, {
      params: { surfaceId: 999_999 },
    });
    assert.ok(!missingSurface.ok);
    assert.deepEqual([missingSurface.status, missingSurface.error.code], [400, 'surface_rejected']);
    assert.notEqual(missingSurface.error.requestId, '');

    const emptyPath = await callApi(runtime.server, apiEndpoints.projects.add, {
      body: { path: '' },
    });
    assert.ok(!emptyPath.ok);
    assert.deepEqual(
      [emptyPath.status, emptyPath.error.code],
      [400, 'api_request_decoding_failed'],
    );
    assert.notEqual(emptyPath.error.requestId, '');

    const unknownRoute = await runtime.server.inject({
      method: 'GET',
      url: `${apiBasePath}/nope`,
    });
    const notFound = Schema.decodeUnknownSync(apiBaseErrorResponseSchema)(unknownRoute.json());
    assert.deepEqual([unknownRoute.statusCode, notFound.error.code], [404, 'api_route_not_found']);
    assert.notEqual(notFound.error.requestId, '');
  });

  test('flow 11: deleting the surface tears down the PTY process tree', async () => {
    const deleted = await callOk(runtime.server, apiEndpoints.surfaces.delete, {
      params: { surfaceId },
    });
    assert.equal(deleted.deletedSurfaceId, surfaceId);
    assert.deepEqual(deleted.deletedPaneIds, [paneId]);
    await expectNoProcessMatching(marker, 2_000);
  });

  test('flow 12: the runtime shuts down cleanly once its sockets are closed', async () => {
    await events.close();
    await terminal.socket.close();
    const shutdownLogs = await captureLogs(() => runtime.shutdown());
    await expectNoNewHandles(runtime.handleBaseline);
    assert.deepEqual(failureLines(shutdownLogs), []);
    // The "no fibers left running" assertion needs a fiber probe layer at boot, which the v3
    // entry point cannot take; it is added with `@isagi/testing` and the new composition root.
  });
});

describe('runtime smoke: shutdown with open sockets', () => {
  test(
    'flow 13: closing the runtime with an events socket and a PTY attach open',
    { todo: 'phase 3: shutdown ordering' },
    async () => {
      const marker = `isagi-smoke-${randomUUID()}`;
      const runtime = await bootSmokeRuntime();
      let events: RecordingSocket<RuntimeEvent> | undefined;
      let terminal: TerminalAttach | undefined;
      try {
        events = await openSocket(runtime, runtimeEventsWebSocketEndpoint.path, runtimeEventSchema);
        const { projectId } = await callOk(runtime.server, apiEndpoints.projects.add, {
          body: { path: runtime.repoDir },
        });
        const workspace = await callOk(runtime.server, apiEndpoints.workspace.get);
        const worktree = workspace.projects
          .find((project) => project.id === projectId)
          ?.worktrees.find((candidate) => candidate.isRoot);
        assert.ok(worktree);
        const created = await callOk(runtime.server, apiEndpoints.surfaces.createSurface, {
          params: { worktreeId: worktree.id },
          body: { initialPane: { kind: 'terminal_session' } },
        });
        const detail = await callOk(runtime.server, apiEndpoints.surfaces.get, {
          params: { surfaceId: created.surfaceId },
        });
        const session = detail.panes[0]?.session;
        assert.ok(session?.kind === 'terminal_session');
        const attached = await claimAndAttachTerminal(runtime, {
          worktreeId: worktree.id,
          paneId: created.paneId,
          terminalSessionId: session.terminalSession.id,
        });
        terminal = attached;
        await waitFor(() => attached.output().includes('$'), 'the shell prompt');
        attached.socket.send({ type: 'input', data: `sh -c 'sleep 300; true' ${marker}\n` });
        await waitFor(
          async () => (await processesMatching(marker)).length > 0,
          'the marker process to start',
        );

        const openEvents = events;
        const shutdownLogs = await captureLogs(() => runtime.shutdown());
        await waitFor(
          () => openEvents.closed && attached.socket.closed,
          'the runtime to close both sockets',
          2_000,
        );
        await expectNoProcessMatching(marker, 2_000);
        await expectNoNewHandles(runtime.handleBaseline);
        assert.deepEqual(failureLines(shutdownLogs), []);
      } finally {
        events?.socket.close();
        terminal?.socket.socket.close();
        await runtime.shutdown();
        await killProcessesMatching(marker);
      }
    },
  );
});

// --- Booting -------------------------------------------------------------------------------------

interface SmokeRuntime {
  readonly server: FastifyInstance;
  readonly url: string;
  readonly repoDir: string;
  readonly handleBaseline: ReadonlyMap<string, number>;
  /** Closes the server once, then restores the environment and removes the temp dirs. */
  readonly shutdown: () => Promise<void>;
}

const smokeEnvironment = [
  'ISAGI_DATA_DIR',
  'SHELL',
  'ISAGI_EDITOR_CAPABILITY',
  'ISAGI_ALLOWED_ORIGINS',
] as const;

async function bootSmokeRuntime(): Promise<SmokeRuntime> {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-smoke-data-')));
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-smoke-repo-')));
  const savedEnvironment = new Map(smokeEnvironment.map((name) => [name, process.env[name]]));
  const restoreEnvironment = () => {
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const removeTempDirs = () => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  };

  process.env.ISAGI_DATA_DIR = dataDir;
  process.env.SHELL = '/bin/sh';
  // Editor provisioning reports `not_applicable` without a capability, so nothing downloads.
  delete process.env.ISAGI_EDITOR_CAPABILITY;
  delete process.env.ISAGI_ALLOWED_ORIGINS;

  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
    writeFileSync(join(repoDir, 'README.md'), 'smoke\n');
    execFileSync('git', ['-C', repoDir, 'add', '.']);
    execFileSync('git', [
      '-C',
      repoDir,
      '-c',
      'user.email=s@s',
      '-c',
      'user.name=s',
      'commit',
      '-qm',
      'init',
    ]);
  } catch (error) {
    restoreEnvironment();
    removeTempDirs();
    throw error;
  }

  const handleBaseline = activeResourceCounts();
  let started: { readonly server: FastifyInstance; readonly url: string };
  try {
    started = await Effect.runPromise(startRuntimeServer());
  } catch (error) {
    restoreEnvironment();
    removeTempDirs();
    throw error;
  }

  let shutdown: Promise<void> | undefined;
  return {
    server: started.server,
    url: started.url,
    repoDir,
    handleBaseline,
    shutdown: () => {
      shutdown ??= started.server.close().finally(() => {
        restoreEnvironment();
        removeTempDirs();
      });
      return shutdown;
    },
  };
}

// --- HTTP ----------------------------------------------------------------------------------------

type AnyEndpoint = AnyApiEndpoint;

interface CallRequest {
  readonly params?: Readonly<Record<string, string | number>>;
  readonly body?: unknown;
}

type CallResult<Endpoint extends AnyEndpoint> =
  | { readonly ok: true; readonly status: number; readonly data: ApiEndpointOutput<Endpoint> }
  | { readonly ok: false; readonly status: number; readonly error: ApiError };

/** One endpoint call. A 2xx body is decoded as the success envelope, anything else as an error. */
async function callApi<Endpoint extends AnyEndpoint>(
  server: FastifyInstance,
  endpoint: Endpoint,
  request: CallRequest = {},
): Promise<CallResult<Endpoint>> {
  const path = endpoint.path.replace(/:(\w+)/g, (_, name: string) => {
    const value = request.params?.[name];
    assert.notEqual(value, undefined, `${endpoint.id} needs the ${name} route param`);
    return encodeURIComponent(String(value));
  });
  const response = await server.inject({
    method: endpoint.method,
    url: `${apiBasePath}${path}`,
    ...(request.body === undefined ? {} : { payload: request.body as object }),
  });
  const body: unknown = response.json();
  if (response.statusCode >= 200 && response.statusCode < 300) {
    const decoded = Schema.decodeUnknownSync(apiSuccessResponseSchema(endpoint.output))(body);
    return {
      ok: true,
      status: response.statusCode,
      data: decoded.data as ApiEndpointOutput<Endpoint>,
    };
  }
  const errorSchema = apiErrorResponseSchema(
    Schema.Union([endpoint.errors, apiInfrastructureErrorSchema]),
  );
  const decoded = Schema.decodeUnknownSync(errorSchema)(body);
  return { ok: false, status: response.statusCode, error: decoded.error as ApiError };
}

async function callOk<Endpoint extends AnyEndpoint>(
  server: FastifyInstance,
  endpoint: Endpoint,
  request: CallRequest = {},
): Promise<ApiEndpointOutput<Endpoint>> {
  const result = await callApi(server, endpoint, request);
  if (!result.ok) {
    assert.fail(`${endpoint.id} failed with ${result.status}: ${JSON.stringify(result.error)}`);
  }
  assert.equal(result.status, 200);
  return result.data;
}

// --- WebSockets ----------------------------------------------------------------------------------

interface RecordingSocket<Message> {
  readonly socket: WebSocket;
  readonly messages: Message[];
  readonly decodeFailures: string[];
  readonly closed: boolean;
  readonly send: (message: unknown) => void;
  /** Starts the closing handshake (if still open) and waits for it to finish. */
  readonly close: () => Promise<void>;
}

/**
 * Opens a real WebSocket to the listening runtime and records every server message, decoded with
 * `schema`.
 *
 * Not `injectWS`: its in-memory streams never emit `close` after a closing handshake, so every
 * server-initiated close (the attach refusal, shutdown) leaves ws's 30 s close timer behind and
 * would make the handle and shutdown assertions measure the test transport instead of the runtime.
 */
async function openSocket<MessageSchema extends WireSchema>(
  runtime: SmokeRuntime,
  path: string,
  schema: MessageSchema,
): Promise<RecordingSocket<MessageSchema['Type']>> {
  type Message = MessageSchema['Type'];
  const url = new URL(`${apiBasePath}${path}`, runtime.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const messages: Message[] = [];
  const decodeFailures: string[] = [];
  let closed = false;
  const decode = Schema.decodeUnknownResult(schema);
  const socket = new WebSocket(url);
  socket.addEventListener('message', (event) => {
    const text = String(event.data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      decodeFailures.push(text);
      return;
    }
    const result = decode(parsed);
    if (Result.isSuccess(result)) messages.push(result.success);
    else decodeFailures.push(text);
  });
  socket.addEventListener('close', () => {
    closed = true;
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`WebSocket ${path} failed to open.`)), {
      once: true,
    });
  });
  return {
    socket,
    messages,
    decodeFailures,
    get closed() {
      return closed;
    },
    send: (message) => socket.send(JSON.stringify(message)),
    close: async () => {
      if (!closed) socket.close();
      await waitFor(() => closed, `WebSocket ${path} to close`, 2_000);
    },
  };
}

interface TerminalAttach {
  readonly socket: RecordingSocket<typeof ptyWebSocketOutputMessageSchema.Type>;
  readonly output: () => string;
}

async function claimAndAttachTerminal(
  runtime: SmokeRuntime,
  input: {
    readonly worktreeId: number;
    readonly paneId: number;
    readonly terminalSessionId: number;
  },
): Promise<TerminalAttach> {
  const claim = await callOk(runtime.server, apiEndpoints.surfaces.claimPaneSession, {
    params: { worktreeId: input.worktreeId },
    body: {
      action: 'claim_terminal_session',
      paneId: input.paneId,
      terminalSessionId: input.terminalSessionId,
    },
  });
  assert.deepEqual(claim.session, {
    kind: 'terminal_session',
    terminalSessionId: input.terminalSessionId,
  });
  const socket = await openSocket(
    runtime,
    `${terminalAttachPath(input.terminalSessionId)}?attachToken=${encodeURIComponent(claim.attachToken)}`,
    ptyWebSocketOutputMessageSchema,
  );
  return {
    socket,
    output: () =>
      socket.messages.map((message) => (message.type === 'output' ? message.data : '')).join(''),
  };
}

function terminalAttachPath(terminalSessionId: number) {
  return terminalSessionPtyWebSocketEndpoint.path.replace(
    ':terminalSessionId',
    String(terminalSessionId),
  );
}

function errorMessages(socket: RecordingSocket<{ readonly type: string }>) {
  return [
    ...socket.decodeFailures,
    ...socket.messages.filter((message) => message.type === 'error'),
  ];
}

// --- Processes, handles and logs -----------------------------------------------------------------

async function processesMatching(pattern: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('pgrep', ['-f', pattern], (error, stdout) => {
      // pgrep exits 1 when nothing matches.
      if (error && error.code !== 1) reject(error);
      else resolve(stdout.split('\n').filter((line) => line.trim() !== ''));
    });
  });
}

async function expectNoProcessMatching(pattern: string, timeoutMs: number) {
  await waitFor(
    async () => (await processesMatching(pattern)).length === 0,
    `no process matching ${pattern}`,
    timeoutMs,
  );
}

async function killProcessesMatching(pattern: string) {
  await new Promise<void>((resolve) => {
    execFile('pkill', ['-KILL', '-f', pattern], () => resolve());
  });
}

function activeResourceCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const resource of process.getActiveResourcesInfo()) {
    counts.set(resource, (counts.get(resource) ?? 0) + 1);
  }
  return counts;
}

/** Every resource kind is back to (or below) its pre-boot count within a short grace period. */
async function expectNoNewHandles(baseline: ReadonlyMap<string, number>) {
  const leaked = () =>
    [...activeResourceCounts()]
      .filter(([resource, count]) => count > (baseline.get(resource) ?? 0))
      .map(([resource, count]) => `${resource} ${baseline.get(resource) ?? 0} -> ${count}`);
  await waitFor(() => leaked().length === 0, 'no new active handles', 3_000).catch(() => {
    assert.deepEqual(leaked(), [], 'handles left open after shutdown');
  });
}

interface LogLine {
  readonly method: 'debug' | 'error' | 'info' | 'log' | 'warn';
  readonly text: string;
}

/** Records console output while `run` is in flight; the output still reaches the terminal. */
async function captureLogs(run: () => Promise<void>): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  const methods = ['debug', 'error', 'info', 'log', 'warn'] as const;
  const originals = methods.map((method) => [method, console[method]] as const);
  for (const [method, original] of originals) {
    console[method] = (...args: unknown[]) => {
      lines.push({ method, text: args.map(String).join(' ') });
      original.apply(console, args);
    };
  }
  try {
    await run();
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }
  return lines;
}

/** Warn and Error lines: console warnings/errors, and Effect logger lines at those levels. */
function failureLines(lines: readonly LogLine[]) {
  return lines
    .filter(
      (line) =>
        line.method === 'warn' ||
        line.method === 'error' ||
        /\blevel=(WARN|WARNING|ERROR|FATAL)\b/i.test(line.text),
    )
    .map((line) => `${line.method}: ${line.text}`);
}

// --- Timing --------------------------------------------------------------------------------------

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline)
      assert.fail(`Timed out after ${timeoutMs} ms waiting for ${description}.`);
    await delay(25);
  }
}
