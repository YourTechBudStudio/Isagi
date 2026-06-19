import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import {
  DataDirectory,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type DataDirectoryService,
  type RuntimeDatabaseService,
} from '../persistence/index.js';
import { projects, ptyProcesses, worktreeCommandStates, worktrees } from '../persistence/schema.js';
import { PtyRepository, PtyRepositoryLive } from './pty.repository.js';
import { collectPtyGarbage } from './service/gc.js';
import { PtyInspectError, PtyKillError, type PtyBackend } from './types.js';

function testLayer(dataRoot: string) {
  const dataDirectory = {
    paths: {
      root: dataRoot,
      databasePath: join(dataRoot, 'isagi.db'),
      statePath: join(dataRoot, 'state.json'),
      worktreesPath: join(dataRoot, 'worktrees'),
      sessionsPath: join(dataRoot, 'sessions'),
    },
  } satisfies DataDirectoryService;
  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const database = RuntimeDatabaseLive.pipe(Layer.provide(dataDirectoryLayer));
  const repository = PtyRepositoryLive.pipe(Layer.provide(database));
  return Layer.mergeAll(database, repository);
}

test('PTY process repository lists process log paths for cleanup scans', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-process-log-paths-'));
  try {
    const paths = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const id = yield* repository.createProcessMetadata({
          command: 'bash',
          args: [],
          cwd: '/repo/isagi',
        });
        yield* repository.updateBackendMetadata({
          ptyProcessId: id,
          backend: 'node_pty',
          backendRefJson: JSON.stringify({
            schemaVersion: 1,
            backend: 'node_pty',
            ptyProcessId: id,
            pid: null,
          }),
          logMode: 'backend_file',
          logPath: join(dataRoot, 'sessions', `${id}.ptylog`),
        });
        return yield* repository.listProcessLogPaths;
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(paths.length, 1);
    assert.match(paths[0] ?? '', /\.ptylog$/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC force-kills old orphan running processes and deletes their row and log', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-kill-orphan-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const process = yield* insertPtyProcess({
          status: 'running',
          logPath: join(sessionsPath, 'running.ptylog'),
          updatedAt: oldIso(),
        });
        writeFileSync(process.logPath, 'session log', 'utf8');
        let kills = 0;
        const backend = fakeBackend({
          inspect: () => Effect.succeed({ status: 'alive' as const }),
          kill: () =>
            Effect.sync(() => {
              kills += 1;
            }),
        });

        yield* collectPtyGarbage(repository, backend, 'test-runtime', sessionsPath, {
          nowMs: nowMs(),
        });

        return {
          process: yield* repository.findProcess(process.id),
          logExists: existsSync(process.logPath),
          kills,
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.process, null);
    assert.equal(output.logExists, false);
    assert.equal(output.kills, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC keeps orphan running processes when backend kill fails', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-kill-failed-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const process = yield* insertPtyProcess({
          status: 'running',
          logPath: join(sessionsPath, 'running.ptylog'),
          updatedAt: oldIso(),
        });
        writeFileSync(process.logPath, 'session log', 'utf8');
        const backend = fakeBackend({
          inspect: () => Effect.succeed({ status: 'alive' as const }),
          kill: () =>
            Effect.fail(new PtyKillError({ ptyProcessId: process.id, cause: new Error('nope') })),
        });

        yield* collectPtyGarbage(repository, backend, 'test-runtime', sessionsPath, {
          nowMs: nowMs(),
        });

        return {
          process: yield* repository.findProcess(process.id),
          logExists: existsSync(process.logPath),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.notEqual(output.process, null);
    assert.equal(output.logExists, true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC keeps orphan running processes when their backend is unavailable in this runtime', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-backend-mismatch-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const process = yield* insertPtyProcess({
          status: 'running',
          logPath: join(sessionsPath, 'running.ptylog'),
          updatedAt: oldIso(),
        });
        writeFileSync(process.logPath, 'session log', 'utf8');
        // The row was created by the node_pty backend, but the runtime only has
        // a tmux backend available, so it cannot reach the live process.
        const backend = fakeBackend({
          name: 'tmux',
          inspect: () => Effect.die('a backend must not inspect another backend’s process'),
          kill: () => Effect.die('a backend must not kill another backend’s process'),
        });

        yield* collectPtyGarbage(repository, backend, 'test-runtime', sessionsPath, {
          nowMs: nowMs(),
        });

        return {
          process: yield* repository.findProcess(process.id),
          logExists: existsSync(process.logPath),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.notEqual(output.process, null);
    assert.equal(output.logExists, true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC keeps orphan running processes when backend inspection is unavailable', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-inspect-unavailable-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const process = yield* insertPtyProcess({
          status: 'running',
          logPath: join(sessionsPath, 'running.ptylog'),
          updatedAt: oldIso(),
        });
        writeFileSync(process.logPath, 'session log', 'utf8');
        let kills = 0;
        const backend = fakeBackend({
          inspect: () =>
            Effect.fail(
              new PtyInspectError({ ptyProcessId: process.id, cause: new Error('down') }),
            ),
          kill: () =>
            Effect.sync(() => {
              kills += 1;
            }),
        });

        yield* collectPtyGarbage(repository, backend, 'test-runtime', sessionsPath, {
          nowMs: nowMs(),
        });

        return {
          process: yield* repository.findProcess(process.id),
          logExists: existsSync(process.logPath),
          kills,
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.notEqual(output.process, null);
    assert.equal(output.logExists, true);
    assert.equal(output.kills, 0);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC keeps orphan running processes whose backend ref cannot be decoded', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-undecodable-ref-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const process = yield* insertPtyProcess({
          status: 'running',
          logPath: join(sessionsPath, 'running.ptylog'),
          updatedAt: oldIso(),
          backendRefJson: 'not-valid-json',
        });
        writeFileSync(process.logPath, 'session log', 'utf8');
        const backend = fakeBackend({
          inspect: () => Effect.die('an undecodable ref must not be inspected'),
          kill: () => Effect.die('an undecodable ref must not be killed'),
        });

        yield* collectPtyGarbage(repository, backend, 'test-runtime', sessionsPath, {
          nowMs: nowMs(),
        });

        return {
          process: yield* repository.findProcess(process.id),
          logExists: existsSync(process.logPath),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.notEqual(output.process, null);
    assert.equal(output.logExists, true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC keeps orphan processes whose retention window has not elapsed', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-retention-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const process = yield* insertPtyProcess({
          status: 'running',
          logPath: join(sessionsPath, 'running.ptylog'),
          updatedAt: recentIso(),
        });
        writeFileSync(process.logPath, 'session log', 'utf8');
        let kills = 0;
        const backend = fakeBackend({
          inspect: () => Effect.succeed({ status: 'alive' as const }),
          kill: () =>
            Effect.sync(() => {
              kills += 1;
            }),
        });

        yield* collectPtyGarbage(repository, backend, 'test-runtime', sessionsPath, {
          nowMs: nowMs(),
        });

        return {
          process: yield* repository.findProcess(process.id),
          logExists: existsSync(process.logPath),
          kills,
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.notEqual(output.process, null);
    assert.equal(output.logExists, true);
    assert.equal(output.kills, 0);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC deletes old orphan terminal processes without backend inspection', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-terminal-orphan-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const process = yield* insertPtyProcess({
          status: 'killed',
          logPath: join(sessionsPath, 'missing.ptylog'),
          updatedAt: oldIso(),
        });
        const backend = fakeBackend({
          inspect: () => Effect.die('terminal rows should not be inspected'),
        });

        yield* collectPtyGarbage(repository, backend, 'test-runtime', sessionsPath, {
          nowMs: nowMs(),
        });

        return yield* repository.findProcess(process.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output, null);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC keeps orphan rows when log deletion fails', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-log-failed-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const logPath = join(sessionsPath, 'log-path-is-directory.ptylog');
        mkdirSync(logPath);
        const process = yield* insertPtyProcess({
          status: 'killed',
          logPath,
          updatedAt: oldIso(),
        });

        yield* collectPtyGarbage(repository, fakeBackend(), 'test-runtime', sessionsPath, {
          nowMs: nowMs(),
        });

        return {
          process: yield* repository.findProcess(process.id),
          logExists: existsSync(logPath),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.notEqual(output.process, null);
    assert.equal(output.logExists, true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC deletes stray orphan log files without a process row', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-stray-log-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const logPath = join(sessionsPath, 'stray.ptylog');
        writeFileSync(logPath, 'old log', 'utf8');
        const old = new Date(oldIso());
        utimesSync(logPath, old, old);

        yield* collectPtyGarbage(repository, fakeBackend(), 'test-runtime', sessionsPath, {
          nowMs: nowMs(),
        });

        return existsSync(logPath);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output, false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC keeps PTY rows referenced only by a running command state', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-command-state-ref-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const database = yield* RuntimeDatabase;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        // A terminal, orphan-aged row that the GC would otherwise delete...
        const process = yield* insertPtyProcess({
          status: 'killed',
          logPath: join(sessionsPath, 'command.ptylog'),
          updatedAt: oldIso(),
        });
        writeFileSync(process.logPath, 'command log', 'utf8');
        // ...but a running command state points at it as its active PTY, so it
        // must survive (and its log too) until the command releases it.
        yield* seedCommandStateReference(database, process.id);

        yield* collectPtyGarbage(repository, fakeBackend(), 'test-runtime', sessionsPath, {
          nowMs: nowMs(),
        });

        return {
          process: yield* repository.findProcess(process.id),
          logExists: existsSync(process.logPath),
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.notEqual(output.process, null);
    assert.equal(output.logExists, true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function seedCommandStateReference(database: RuntimeDatabaseService, ptyProcessId: number) {
  return database.use('seed_command_state_reference_for_gc_test', (db) => {
    const now = '2026-06-18T00:00:00.000Z';
    const project = db
      .insert(projects)
      .values({
        name: 'isagi',
        rootPath: `/repo/isagi-${ptyProcessId}`,
        status: 'present',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      })
      .returning({ id: projects.id })
      .get();
    const worktree = db
      .insert(worktrees)
      .values({
        projectId: project.id,
        path: `/repo/isagi-${ptyProcessId}/wt`,
        branch: 'main',
        head: 'abcdef0',
        createdAt: now,
        updatedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning({ id: worktrees.id })
      .get();
    db.insert(worktreeCommandStates)
      .values({
        worktreeId: worktree.id,
        commandName: 'dev',
        status: 'running',
        activePtyProcessId: ptyProcessId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
}

function insertPtyProcess(input: {
  readonly status: 'running' | 'killed';
  readonly logPath: string;
  readonly updatedAt: string;
  readonly backendRefJson?: string;
}) {
  return Effect.gen(function* () {
    const repository = yield* PtyRepository;
    const database = yield* RuntimeDatabase;
    const id = yield* repository.createProcessMetadata({
      command: 'bash',
      args: [],
      cwd: '/repo/isagi',
    });
    yield* repository.updateBackendMetadata({
      ptyProcessId: id,
      backend: 'node_pty',
      backendRefJson:
        input.backendRefJson ??
        JSON.stringify({
          schemaVersion: 1,
          backend: 'node_pty',
          ptyProcessId: id,
          pid: null,
        }),
      logMode: 'backend_file',
      logPath: input.logPath,
    });
    yield* repository.transitionProcess({
      ptyProcessId: id,
      status: input.status,
      statusReason: input.status === 'killed' ? 'user_requested' : null,
    });
    yield* database.use('age_pty_process_for_gc_test', (db) => {
      db.update(ptyProcesses)
        .set({ updatedAt: input.updatedAt })
        .where(eq(ptyProcesses.id, id))
        .run();
    });
    return { id, logPath: input.logPath };
  });
}

function fakeBackend(
  overrides: Partial<Pick<PtyBackend, 'name' | 'inspect' | 'kill' | 'collectGarbage'>> = {},
): PtyBackend {
  return {
    name: 'node_pty',
    available: Effect.succeed(true),
    launch: () => Effect.die('launch is not used by PTY GC tests'),
    attach: () => Effect.die('attach is not used by PTY GC tests'),
    replay: () => Effect.die('replay is not used by PTY GC tests'),
    inspect: () => Effect.succeed({ status: 'missing' as const }),
    listSessions: Effect.succeed([]),
    kill: () => Effect.void,
    collectGarbage: () => Effect.succeed([]),
    ...overrides,
  };
}

function nowMs() {
  return Date.parse('2026-06-18T12:00:00.000Z');
}

function oldIso() {
  return new Date(nowMs() - 6 * 60_000).toISOString();
}

function recentIso() {
  return new Date(nowMs() - 60_000).toISOString();
}
