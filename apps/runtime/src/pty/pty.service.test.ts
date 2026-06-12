import assert from 'node:assert/strict';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Either, Layer } from 'effect';

import type { SurfaceDetail } from '@isagi/contracts';

import {
  DataDirectory,
  RuntimeDatabaseLive,
  type DataDirectoryService,
} from '../persistence/index.js';
import { SurfaceRepositoryLive, SurfaceService, SurfaceServiceLive } from '../surfaces/index.js';
import { WorkspaceRepository, WorkspaceRepositoryLive } from '../workspace/index.js';
import {
  PtyBackend,
  PtyRepository,
  PtyRepositoryLive,
  PtyService,
  PtyServiceError,
  PtyServiceLive,
  PtyStartError,
  type LaunchBackendSessionInput,
  type PtyBackendShape,
} from './index.js';
import { detectOrphanPtyLogs } from './pty.service.js';

test('launch creates metadata, writes output to the log, and marks running attention', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-launch-'));
  const fake = fakeBackend();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.equal(output.launched.worktreeId, output.detail.worktreeId);
    assert.equal(output.detail.attention, 'working');
    assert.equal(output.detail.panes[0]?.attention, 'working');
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'running');
    assert.equal(output.detail.panes[0]?.ptySession?.command, process.env.SHELL || 'bash');
    assert.ok(
      readFileSync(
        join(dataRoot, 'sessions', `${output.launched.ptySessionId}.ptylog`),
        'utf8',
      ).startsWith('hello from pty'),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('orphan log detection reports unreferenced pty logs without deleting them', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-orphan-logs-'));
  mkdirSync(join(dataRoot, 'sessions'), { recursive: true });
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const repository = yield* PtyRepository;
        const metadata = yield* repository.createLaunchMetadata({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
          purpose: 'terminal',
          harness: null,
          command: process.env.SHELL || 'bash',
        });
        assert.ok(metadata.logPath);
        writeFileSync(metadata.logPath, 'referenced', 'utf8');
        const orphanPath = join(dataRoot, 'sessions', 'orphan.ptylog');
        writeFileSync(orphanPath, 'orphan', 'utf8');

        return {
          orphans: yield* detectOrphanPtyLogs(repository, join(dataRoot, 'sessions')),
          orphanPath,
        };
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.deepEqual(output.orphans, ['sessions/orphan.ptylog']);
    assert.equal(readFileSync(output.orphanPath, 'utf8'), 'orphan');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('new sessions do not reuse deleted pty ids or orphaned log paths', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-id-reuse-'));
  const fake = fakeBackend();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const firstWorktree = yield* insertProjectWorktree('/repo/isagi-one');
        const pty = yield* PtyService;
        const first = yield* pty.launch({
          worktreeId: firstWorktree.worktreeId,
          purpose: 'terminal',
          harness: null,
        });
        const workspaceRepository = yield* WorkspaceRepository;
        yield* workspaceRepository.deleteProject(firstWorktree.projectId);

        const secondWorktree = yield* insertProjectWorktree('/repo/isagi-two');
        const second = yield* pty.launch({
          worktreeId: secondWorktree.worktreeId,
          purpose: 'terminal',
          harness: null,
        });
        return { first, second };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    const firstLogPath = join(dataRoot, 'sessions', `${output.first.ptySessionId}.ptylog`);
    const secondLogPath = join(dataRoot, 'sessions', `${output.second.ptySessionId}.ptylog`);
    assert.ok(output.second.ptySessionId > output.first.ptySessionId);
    assert.notEqual(firstLogPath, secondLogPath);
    assert.equal(readFileSync(firstLogPath, 'utf8'), 'hello from pty');
    assert.equal(readFileSync(secondLogPath, 'utf8'), 'hello from pty');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('spawn failure returns created ids and persists a failed visible session with log text', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-failed-spawn-'));
  const fake = fakeBackend({ failStart: true });
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'agent', harness: 'pi' });
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.equal(output.detail.title, 'Pi');
    assert.equal(output.detail.attention, 'error');
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'failed');
    assert.equal(output.detail.panes[0]?.ptySession?.statusReason, 'backend_launch_failed');
    assert.equal(output.detail.panes[0]?.ptySession?.command, 'pi');
    const log = readFileSync(
      join(dataRoot, 'sessions', `${output.launched.ptySessionId}.ptylog`),
      'utf8',
    );
    assert.match(log, /Failed to start pi/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('exit updates status and attention honestly', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-exit-'));
  const fake = fakeBackend();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        fake.exits.get(launched.ptySessionId)?.({ exitCode: 1, signal: null });
        yield* waitUntilDetail(
          launched.surfaceId,
          (detail) => detail.panes[0]?.ptySession?.status === 'failed',
        );
        const surfaces = yield* SurfaceService;
        return { launched, detail: yield* surfaces.getSurfaceDetail(launched.surfaceId) };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.equal(output.detail.attention, 'error');
    assert.equal(output.detail.panes[0]?.ptySession?.exitCode, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('attach captures replay offset before live output so replay and live stream do not gap', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-attach-'));
  const fake = fakeBackend();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        const messages: unknown[] = [];
        const attachment = yield* pty.attach({
          ptySessionId: launched.ptySessionId,
          send: (message) => messages.push(message),
        });
        fake.outputs.get(launched.ptySessionId)?.('during replay');
        const replayed: unknown[] = [];
        yield* pty.replay({
          session: attachment.session,
          bytes: attachment.replayBytes,
          send: (message) => replayed.push(message),
        });
        attachment.unsubscribe();
        return { launched, messages, replayed };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.deepEqual(output.replayed, [
      { type: 'replay_start', bytes: Buffer.byteLength('hello from pty') },
      { type: 'output', data: 'hello from pty', replay: true },
      { type: 'replay_end' },
    ]);
    assert.deepEqual(output.messages, [{ type: 'output', data: 'during replay' }]);
    assert.ok(
      readFileSync(
        join(dataRoot, 'sessions', `${output.launched.ptySessionId}.ptylog`),
        'utf8',
      ).startsWith('hello from ptyduring replay'),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('replaced websocket attachment cannot keep writing to the current session', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-replaced-attach-'));
  const fake = fakeBackend();
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        const first = yield* pty.attach({
          ptySessionId: launched.ptySessionId,
          send: () => {},
        });
        const second = yield* pty.attach({
          ptySessionId: launched.ptySessionId,
          send: () => {},
        });
        const staleWrite = yield* pty
          .write({
            ptySessionId: launched.ptySessionId,
            attachmentId: first.attachmentId,
            data: 'stale',
          })
          .pipe(Effect.either);
        const currentWrite = yield* pty.write({
          ptySessionId: launched.ptySessionId,
          attachmentId: second.attachmentId,
          data: 'current',
        });
        second.unsubscribe();
        return { staleWrite, currentWrite };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.ok(Either.isLeft(output.staleWrite));
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('missing runtime-local backend session fails attach with backend code and durable reason', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-missing-backend-'));
  const fake = fakeBackend({ failAttach: true });
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        const launched = yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
        const attachResult = yield* pty
          .attach({
            ptySessionId: launched.ptySessionId,
            send: () => {},
          })
          .pipe(Effect.either);
        const surfaces = yield* SurfaceService;
        return {
          attachResult,
          detail: yield* surfaces.getSurfaceDetail(launched.surfaceId),
        };
      }).pipe(Effect.provide(testLayer(dataRoot, fake.backend))),
    );

    assert.ok(Either.isLeft(output.attachResult));
    assert.ok(output.attachResult.left instanceof PtyServiceError);
    assert.equal(output.attachResult.left.code, 'backend_session_missing');
    assert.equal(output.detail.panes[0]?.ptySession?.status, 'failed');
    assert.equal(output.detail.panes[0]?.ptySession?.statusReason, 'runtime_ephemeral_lost');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('graceful service shutdown marks live node-pty sessions failed without recovery reason', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-graceful-shutdown-'));
  try {
    const launched = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const pty = yield* PtyService;
        return yield* pty.launch({ worktreeId, purpose: 'terminal', harness: null });
      }).pipe(Effect.provide(testLayer(dataRoot, fakeBackend().backend))),
    );

    const detail = await Effect.runPromise(
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.getSurfaceDetail(launched.surfaceId);
      }).pipe(Effect.provide(testLayer(dataRoot, fakeBackend().backend))),
    );

    assert.equal(detail.panes[0]?.ptySession?.status, 'failed');
    assert.equal(detail.panes[0]?.ptySession?.statusReason, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('startup recovery marks persisted live node-pty sessions failed without mutating logs', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-restart-'));
  try {
    const launched = await Effect.runPromise(
      Effect.gen(function* () {
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const repository = yield* PtyRepository;
        const metadata = yield* repository.createLaunchMetadata({
          worktreeId,
          kind: 'terminal',
          titleBase: 'Terminal',
          purpose: 'terminal',
          harness: null,
          command: process.env.SHELL || 'bash',
        });
        return {
          worktreeId: metadata.worktreeId,
          surfaceId: metadata.surfaceId,
          paneId: metadata.paneId,
          ptySessionId: metadata.ptySessionId,
        };
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        const surfaces = yield* SurfaceService;
        return yield* surfaces.getSurfaceDetail(launched.surfaceId);
      }).pipe(Effect.provide(testLayer(dataRoot, fakeBackend().backend))),
    );

    assert.equal(recovered.panes[0]?.ptySession?.status, 'failed');
    assert.equal(recovered.panes[0]?.ptySession?.statusReason, 'runtime_ephemeral_lost');
    const logPath = join(dataRoot, 'sessions', `${launched.ptySessionId}.ptylog`);
    assert.equal(existsSync(logPath), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function fakeBackend(
  options: { readonly failStart?: boolean; readonly failAttach?: boolean } = {},
) {
  let nextPid = 100;
  const outputs = new Map<number, (data: string) => void>();
  const exits = new Map<
    number,
    (exit: { readonly exitCode: number | null; readonly signal: string | null }) => void
  >();
  const logPaths = new Map<number, string | null>();
  const backend = {
    name: 'node_pty',
    available: Effect.succeed(true),
    launch: (input: LaunchBackendSessionInput) =>
      Effect.try({
        try: () => {
          if (options.failStart) {
            throw new Error('spawn failed');
          }
          const pid = nextPid++;
          appendFakeLog(input.logPath, 'hello from pty');
          logPaths.set(input.ptySessionId, input.logPath);
          exits.set(input.ptySessionId, input.onExit);
          return {
            schemaVersion: 1,
            backend: 'node_pty',
            ptySessionId: input.ptySessionId,
            pid,
          } as const;
        },
        catch: (cause) =>
          new PtyStartError({
            ptySessionId: input.ptySessionId,
            command: input.command,
            cwd: input.cwd,
            cause,
          }),
      }),
    attach: (input) =>
      Effect.try({
        try: () => {
          if (options.failAttach) {
            throw new Error('attach failed');
          }
          outputs.set(input.ref.ptySessionId, (data) => {
            appendFakeLog(logPaths.get(input.ref.ptySessionId) ?? null, data);
            input.onOutput(data);
          });
          const existingExit = exits.get(input.ref.ptySessionId);
          exits.set(input.ref.ptySessionId, (exit) => {
            input.onExit(exit);
            existingExit?.(exit);
          });
          return {
            write: () => Effect.void,
            resize: () => Effect.void,
            detach: Effect.sync(() => {
              outputs.delete(input.ref.ptySessionId);
            }),
          };
        },
        catch: (cause) =>
          new PtyStartError({
            ptySessionId: input.ref.ptySessionId,
            command: 'node_pty_attach',
            cwd: '',
            cause,
          }),
      }),
    replay: (input) => replayFakeLog(input.logPath, input.bytes, input.send),
    inspect: () => Effect.succeed({ alive: true }),
    kill: () => Effect.void,
  } satisfies PtyBackendShape;
  return { backend, outputs, exits };
}

function appendFakeLog(path: string | null, data: string) {
  if (path) {
    appendFileSync(path, data, 'utf8');
  }
}

function replayFakeLog(
  path: string | null,
  limitBytes: number | null,
  send: (message: import('@isagi/contracts').PtyWebSocketOutputMessage) => void,
) {
  return Effect.sync(() => {
    const bytes = path && existsSync(path) ? (limitBytes ?? statSync(path).size) : 0;
    send({ type: 'replay_start', bytes });
    if (path && bytes > 0) {
      const fd = openSync(path, 'r');
      try {
        const buffer = Buffer.allocUnsafe(bytes);
        const read = readSync(fd, buffer, 0, bytes, 0);
        if (read > 0) {
          send({ type: 'output', data: buffer.toString('utf8', 0, read), replay: true });
        }
      } finally {
        closeSync(fd);
      }
    }
    send({ type: 'replay_end' });
  });
}

function insertWorktree(rootPath: string) {
  return insertProjectWorktree(rootPath).pipe(Effect.map((row) => row.worktreeId));
}

function insertProjectWorktree(rootPath: string) {
  return Effect.gen(function* () {
    const workspaceRepository = yield* WorkspaceRepository;
    const projectId = yield* workspaceRepository.insertProject({ name: 'isagi', rootPath });
    yield* workspaceRepository.reconcileProjectWorktrees({
      projectId,
      discovered: [{ path: rootPath, branch: 'main', head: 'abcdef0' }],
    });
    const worktrees = yield* workspaceRepository.listWorktrees;
    const worktree = worktrees.find((candidate) => candidate.projectId === projectId);
    if (!worktree) {
      return yield* Effect.die('Expected test worktree to be inserted.');
    }
    return { projectId, worktreeId: worktree.id };
  });
}

function waitUntilDetail(surfaceId: number, predicate: (detail: SurfaceDetail) => boolean) {
  return Effect.gen(function* () {
    const surfaces = yield* SurfaceService;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const detail = yield* surfaces.getSurfaceDetail(surfaceId);
      if (predicate(detail)) {
        return detail;
      }
      yield* Effect.sleep('10 millis');
    }
    return yield* Effect.die('Timed out waiting for surface detail predicate.');
  });
}

function repositoryOnlyLayer(dataRoot: string) {
  const dataDirectory = dataDirectoryService(dataRoot);
  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const workspaceRepository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  const surfaceRepository = SurfaceRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(dataDirectoryLayer),
  );
  const ptyRepository = PtyRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(surfaceRepository),
  );
  return Layer.mergeAll(workspaceRepository, surfaceRepository, ptyRepository);
}

function testLayer(dataRoot: string, backend: PtyBackendShape) {
  const dataDirectory = dataDirectoryService(dataRoot);

  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const workspaceRepository = WorkspaceRepositoryLive.pipe(Layer.provide(database));
  const surfaceRepository = SurfaceRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(dataDirectoryLayer),
  );
  const surfaceService = SurfaceServiceLive.pipe(Layer.provide(surfaceRepository));
  const ptyRepository = PtyRepositoryLive.pipe(
    Layer.provide(database),
    Layer.provide(surfaceRepository),
  );
  const ptyService = PtyServiceLive.pipe(
    Layer.provide(ptyRepository),
    Layer.provide(Layer.succeed(PtyBackend, backend)),
    Layer.provide(dataDirectoryLayer),
  );
  return Layer.mergeAll(
    workspaceRepository,
    surfaceRepository,
    surfaceService,
    ptyRepository,
    ptyService,
  );
}

function dataDirectoryService(dataRoot: string) {
  return {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService;
}
