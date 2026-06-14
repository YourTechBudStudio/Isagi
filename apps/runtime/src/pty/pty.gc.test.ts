import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import {
  DataDirectory,
  DatabaseError,
  RuntimeDatabaseLive,
  type DataDirectoryService,
} from '../persistence/index.js';
import { SurfaceRepositoryLive } from '../surfaces/index.js';
import { WorkspaceRepository, WorkspaceRepositoryLive } from '../workspace/index.js';
import { collectNodePtyGarbage } from './adapters/node-pty-gc.js';
import { collectTmuxGarbage } from './adapters/tmux-gc.js';
import {
  PtyRepository,
  PtyRepositoryLive,
  type LaunchBackendSessionInput,
  type PtyBackendShape,
  type PtyRepositoryService,
} from './index.js';
import { runPtyGc } from './service/gc.js';
import { cleanupOrphanPtyLogs } from './service/logs.js';
import type { NodePtyBackendRef } from './types.js';

test('tmux orphan GC kills current-hash sessions without DB rows only', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-tmux-gc-orphan-'));
  const killedSessionNames: string[] = [];
  const backend = fakeTmuxBackend({
    sessionNames: ['isagi_current_42', 'isagi_other_43', 'isagi_current_not-a-number'],
    killedSessionNames,
  });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        yield* runPtyGc(repository, backend, 'current');
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.deepEqual(killedSessionNames, ['isagi_current_42']);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('tmux orphan GC kills terminal-status tmux rows and keeps live rows', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-tmux-gc-terminal-'));
  const killedSessionNames: string[] = [];
  try {
    const sessions = await Effect.runPromise(
      Effect.gen(function* () {
        const failed = yield* createPersistedTmuxSession('/repo/isagi-failed', dataRoot, {
          status: 'failed',
          statusReason: 'backend_session_missing',
        });
        const running = yield* createPersistedTmuxSession('/repo/isagi-running', dataRoot, {
          status: 'running',
          statusReason: null,
        });
        const repository = yield* PtyRepository;
        const backend = fakeTmuxBackend({
          sessionNames: [
            `isagi_current_${failed.ptySessionId}`,
            `isagi_current_${running.ptySessionId}`,
          ],
          killedSessionNames,
        });
        yield* runPtyGc(repository, backend, 'current');
        return { failed, running };
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.deepEqual(killedSessionNames, [`isagi_current_${sessions.failed.ptySessionId}`]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('tmux orphan GC skips matching rows that are not tmux backend', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-tmux-gc-backend-skip-'));
  const killedSessionNames: string[] = [];
  try {
    const ptySessionId = await Effect.runPromise(
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
        yield* repository.updateBackendMetadata({
          ptySessionId: metadata.ptySessionId,
          backend: 'node_pty',
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptySessionId: metadata.ptySessionId,
            pid: null,
          }),
          logMode: 'backend_file',
          logPath: join(dataRoot, 'sessions', `${metadata.ptySessionId}.ptylog`),
        });
        yield* repository.transitionSession({
          ptySessionId: metadata.ptySessionId,
          status: 'failed',
          statusReason: 'runtime_ephemeral_lost',
          exitCode: null,
          signal: null,
        });
        const backend = fakeTmuxBackend({
          sessionNames: [`isagi_current_${metadata.ptySessionId}`],
          killedSessionNames,
        });
        yield* runPtyGc(repository, backend, 'current');
        return metadata.ptySessionId;
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.equal(ptySessionId > 0, true);
    assert.deepEqual(killedSessionNames, []);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('tmux orphan GC skips killing when DB lookup fails', async () => {
  const killedSessionNames: string[] = [];
  const backend = fakeTmuxBackend({
    sessionNames: ['isagi_current_42'],
    killedSessionNames,
  });
  const repository = {
    createLaunchMetadata: () => Effect.die('createLaunchMetadata is not used by GC tests'),
    findSession: () => Effect.succeed(null),
    listSessionLogPaths: Effect.succeed([]),
    listSessions: () =>
      Effect.fail(
        new DatabaseError({
          operation: 'list_pty_sessions',
          cause: new Error('database unavailable'),
        }),
      ),
    updateBackendRef: () => Effect.void,
    updateBackendMetadata: () => Effect.void,
    transitionSession: () => Effect.void,
  } satisfies PtyRepositoryService;

  await Effect.runPromise(runPtyGc(repository, backend, 'current').pipe(Effect.ignore));

  assert.deepEqual(killedSessionNames, []);
});

test('node-pty process-local GC kills DB-missing and terminal-status live sessions', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-node-gc-orphan-'));
  const killedPtySessionIds: number[] = [];
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const failed = yield* createPersistedNodePtySession('/repo/isagi-failed', dataRoot, {
          status: 'failed',
          statusReason: 'runtime_ephemeral_lost',
        });
        const running = yield* createPersistedNodePtySession('/repo/isagi-running', dataRoot, {
          status: 'running',
          statusReason: null,
        });
        const repository = yield* PtyRepository;
        const backend = fakeNodePtyBackend({
          refs: [nodePtyRef(42), nodePtyRef(failed.ptySessionId), nodePtyRef(running.ptySessionId)],
          killedPtySessionIds,
        });
        yield* runPtyGc(repository, backend, 'current');
        return { failed, running };
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.deepEqual(killedPtySessionIds, [42, output.failed.ptySessionId]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('node-pty process-local GC treats same-id non-node persisted ref as orphan', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-node-gc-backend-mismatch-'));
  const killedPtySessionIds: number[] = [];
  try {
    const ptySessionId = await Effect.runPromise(
      Effect.gen(function* () {
        const tmux = yield* createPersistedTmuxSession('/repo/isagi', dataRoot, {
          status: 'running',
          statusReason: null,
        });
        const repository = yield* PtyRepository;
        const backend = fakeNodePtyBackend({
          refs: [nodePtyRef(tmux.ptySessionId)],
          killedPtySessionIds,
        });
        yield* runPtyGc(repository, backend, 'current');
        return tmux.ptySessionId;
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.deepEqual(killedPtySessionIds, [ptySessionId]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('orphan log cleanup deletes only old unreferenced top-level pty logs', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-log-gc-'));
  const sessionsPath = join(dataRoot, 'sessions');
  mkdirSync(sessionsPath, { recursive: true });
  const nowMs = Date.parse('2026-06-12T12:00:00.000Z');
  const oldDate = new Date(nowMs - 4 * 60 * 60_000);
  const youngDate = new Date(nowMs - 30 * 60_000);
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
        const referenced = join(sessionsPath, 'referenced.ptylog');
        const oldOrphan = join(sessionsPath, 'old-orphan.ptylog');
        const youngOrphan = join(sessionsPath, 'young-orphan.ptylog');
        const unrelated = join(sessionsPath, 'old-orphan.txt');
        writeFileSync(referenced, 'referenced', 'utf8');
        writeFileSync(oldOrphan, 'old orphan', 'utf8');
        writeFileSync(youngOrphan, 'young orphan', 'utf8');
        writeFileSync(unrelated, 'not a pty log', 'utf8');
        mkdirSync(join(sessionsPath, 'nested'), { recursive: true });
        writeFileSync(join(sessionsPath, 'nested', 'nested.ptylog'), 'nested', 'utf8');
        utimesSync(referenced, oldDate, oldDate);
        utimesSync(oldOrphan, oldDate, oldDate);
        utimesSync(youngOrphan, youngDate, youngDate);
        utimesSync(unrelated, oldDate, oldDate);
        yield* repository.updateBackendMetadata({
          ptySessionId: metadata.ptySessionId,
          backend: 'node_pty',
          backendRefJson: JSON.stringify(nodePtyRef(metadata.ptySessionId)),
          logMode: 'backend_file',
          logPath: referenced,
        });

        const stats = yield* cleanupOrphanPtyLogs(repository, sessionsPath, {
          minAgeMs: 3 * 60 * 60_000,
          nowMs,
        });
        return { referenced, oldOrphan, youngOrphan, unrelated, stats };
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.deepEqual(output.stats, {
      inspected: 3,
      deleted: ['sessions/old-orphan.ptylog'],
      skippedYoung: ['sessions/young-orphan.ptylog'],
      failed: [],
    });
    assert.equal(existsSync(output.referenced), true);
    assert.equal(existsSync(output.oldOrphan), false);
    assert.equal(existsSync(output.youngOrphan), true);
    assert.equal(existsSync(output.unrelated), true);
    assert.equal(existsSync(join(sessionsPath, 'nested', 'nested.ptylog')), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('orphan log cleanup reports delete failures and continues', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-log-gc-failure-'));
  const sessionsPath = join(dataRoot, 'sessions');
  mkdirSync(sessionsPath, { recursive: true });
  const nowMs = Date.parse('2026-06-12T12:00:00.000Z');
  const oldDate = new Date(nowMs - 4 * 60 * 60_000);
  const blocked = join(sessionsPath, 'blocked.ptylog');
  const originalConsoleWarn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(message);
  };

  try {
    writeFileSync(blocked, 'blocked', 'utf8');
    utimesSync(blocked, oldDate, oldDate);
    chmodSync(sessionsPath, 0o500);

    const stats = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        return yield* cleanupOrphanPtyLogs(repository, sessionsPath, {
          minAgeMs: 3 * 60 * 60_000,
          nowMs,
        });
      }).pipe(Effect.provide(repositoryOnlyLayer(dataRoot))),
    );

    assert.deepEqual(stats, {
      inspected: 1,
      deleted: [],
      skippedYoung: [],
      failed: ['sessions/blocked.ptylog'],
    });
    assert.equal(existsSync(blocked), true);
    assert.equal(
      warnings.some((warning) => String(warning).includes('Could not delete orphan PTY log')),
      true,
    );
  } finally {
    console.warn = originalConsoleWarn;
    chmodSync(sessionsPath, 0o700);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function fakeTmuxBackend(options: {
  readonly sessionNames?: readonly string[];
  readonly killedSessionNames?: string[];
}) {
  const listSessions = Effect.succeed(
    (options.sessionNames ?? []).map(
      (sessionName) =>
        ({
          schemaVersion: 1,
          backend: 'tmux',
          sessionName,
        }) as const,
    ),
  );
  return {
    name: 'tmux',
    available: Effect.succeed(true),
    launch: (input: LaunchBackendSessionInput) =>
      Effect.succeed({
        schemaVersion: 1,
        backend: 'tmux',
        sessionName: input.backendSessionName ?? `isagi_test_${input.ptySessionId}`,
      } as const),
    attach: () =>
      Effect.succeed({
        write: () => Effect.void,
        resize: () => Effect.void,
        detach: Effect.void,
      }),
    replay: (input) =>
      Effect.sync(() => {
        input.send({ type: 'replay_start', bytes: 0 });
        input.send({ type: 'replay_end' });
      }),
    inspect: () => Effect.succeed({ status: 'alive' as const }),
    listSessions,
    collectGarbage: (input) => collectTmuxGarbage(input, listSessions),
    kill: (ref) =>
      Effect.sync(() => {
        if (ref.backend === 'tmux') {
          options.killedSessionNames?.push(ref.sessionName);
        }
      }),
  } satisfies PtyBackendShape;
}

function fakeNodePtyBackend(options: {
  readonly refs?: readonly NodePtyBackendRef[];
  readonly killedPtySessionIds?: number[];
}) {
  const listSessions = Effect.succeed(options.refs ?? []);
  return {
    name: 'node_pty',
    available: Effect.succeed(true),
    launch: (input: LaunchBackendSessionInput) => Effect.succeed(nodePtyRef(input.ptySessionId)),
    attach: () =>
      Effect.succeed({
        write: () => Effect.void,
        resize: () => Effect.void,
        detach: Effect.void,
      }),
    replay: (input) =>
      Effect.sync(() => {
        input.send({ type: 'replay_start', bytes: 0 });
        input.send({ type: 'replay_end' });
      }),
    inspect: () => Effect.succeed({ status: 'alive' as const }),
    listSessions,
    collectGarbage: (input) => collectNodePtyGarbage(input, listSessions),
    kill: (ref) =>
      Effect.sync(() => {
        if (ref.backend === 'node_pty') {
          options.killedPtySessionIds?.push(ref.ptySessionId);
        }
      }),
  } satisfies PtyBackendShape;
}

function nodePtyRef(ptySessionId: number): NodePtyBackendRef {
  return {
    schemaVersion: 1,
    backend: 'node_pty',
    ptySessionId,
    pid: null,
  };
}

function createPersistedTmuxSession(
  rootPath: string,
  dataRoot: string,
  input: {
    readonly status?: import('@isagi/contracts').PtySessionStatus | undefined;
    readonly statusReason: import('@isagi/contracts').PtySessionStatusReason | null;
  },
) {
  return Effect.gen(function* () {
    const worktreeId = yield* insertWorktree(rootPath);
    const repository = yield* PtyRepository;
    const metadata = yield* repository.createLaunchMetadata({
      worktreeId,
      kind: 'terminal',
      titleBase: 'Terminal',
      purpose: 'terminal',
      harness: null,
      command: process.env.SHELL || 'bash',
    });
    const sessionName = `isagi_test_${metadata.ptySessionId}`;
    yield* repository.updateBackendMetadata({
      ptySessionId: metadata.ptySessionId,
      backend: 'tmux',
      backendRefJson: JSON.stringify({
        schemaVersion: 1,
        backend: 'tmux',
        sessionName,
      }),
      logMode: 'none',
      logPath: null,
    });
    yield* repository.transitionSession({
      ptySessionId: metadata.ptySessionId,
      status: input.status ?? 'running',
      statusReason: input.statusReason,
      exitCode: null,
      signal: null,
    });
    return {
      ptySessionId: metadata.ptySessionId,
      sessionName,
      logPath: join(dataRoot, 'sessions', `${metadata.ptySessionId}.ptylog`),
    };
  });
}

function createPersistedNodePtySession(
  rootPath: string,
  dataRoot: string,
  input: {
    readonly status?: import('@isagi/contracts').PtySessionStatus | undefined;
    readonly statusReason: import('@isagi/contracts').PtySessionStatusReason | null;
  },
) {
  return Effect.gen(function* () {
    const worktreeId = yield* insertWorktree(rootPath);
    const repository = yield* PtyRepository;
    const metadata = yield* repository.createLaunchMetadata({
      worktreeId,
      kind: 'terminal',
      titleBase: 'Terminal',
      purpose: 'terminal',
      harness: null,
      command: process.env.SHELL || 'bash',
    });
    yield* repository.updateBackendMetadata({
      ptySessionId: metadata.ptySessionId,
      backend: 'node_pty',
      backendRefJson: JSON.stringify(nodePtyRef(metadata.ptySessionId)),
      logMode: 'backend_file',
      logPath: join(dataRoot, 'sessions', `${metadata.ptySessionId}.ptylog`),
    });
    yield* repository.transitionSession({
      ptySessionId: metadata.ptySessionId,
      status: input.status ?? 'running',
      statusReason: input.statusReason,
      exitCode: null,
      signal: null,
    });
    return {
      ptySessionId: metadata.ptySessionId,
      logPath: join(dataRoot, 'sessions', `${metadata.ptySessionId}.ptylog`),
    };
  });
}

function insertWorktree(rootPath: string) {
  return insertProjectWorktree(rootPath).pipe(Effect.map((row) => row.worktreeId));
}

function insertProjectWorktree(rootPath: string) {
  return Effect.gen(function* () {
    const repository = yield* WorkspaceRepository;
    const projectId = yield* repository.insertProject({
      name: rootPath.split('/').at(-1) ?? 'repo',
      rootPath,
    });
    yield* repository.reconcileProjectWorktrees({
      projectId,
      discovered: [{ path: rootPath, branch: 'main', head: 'abcdef0' }],
    });
    const worktrees = yield* repository.listWorktrees;
    const worktree = worktrees.find((candidate) => candidate.projectId === projectId);
    if (!worktree) {
      return yield* Effect.die('Expected test worktree to be inserted.');
    }
    return { projectId, worktreeId: worktree.id };
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
