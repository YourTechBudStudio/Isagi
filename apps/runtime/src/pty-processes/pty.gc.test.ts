import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import {
  DatabaseError,
  DataDirectory,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type RuntimeDatabaseService,
} from '../persistence/index.js';
import {
  editorContexts,
  projects,
  ptyProcesses,
  worktreeCommandStates,
  worktrees,
} from '../persistence/schema.js';
import { makeTestDataDirectory } from '../persistence/test-support.js';
import { PtyRepository, PtyRepositoryLive } from './pty.repository.js';
import { collectPtyGarbage } from './service/gc.js';
import { fakeBackendCatalog } from './test-support.js';
import { PtyInspectError, PtyKillError, type PtyBackend } from './types.js';

function testLayer(dataRoot: string) {
  const dataDirectory = makeTestDataDirectory(dataRoot);
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
              return { terminated: true };
            }),
        });

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(backend),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
          },
        );

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

test('PTY GC keeps pinned orphan running processes', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-pinned-orphan-'));
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
              return { terminated: true };
            }),
        });

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(backend),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
            pinnedPtyProcessIds: new Set([process.id]),
          },
        );

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

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(backend),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
          },
        );

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

test('PTY GC cleans a live orphan through its own backend while another backend is configured', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-cross-backend-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const process = yield* insertPtyProcess({
          status: 'running',
          backend: 'tmux',
          logPath: join(sessionsPath, 'running.ptylog'),
          updatedAt: oldIso(),
        });
        writeFileSync(process.logPath, 'session log', 'utf8');
        // The incarnation is a tmux one while node-pty is the launch preference.
        // Before the backend catalog this row was retained indefinitely; now it
        // is reached through the transport that actually created it.
        const kills: string[] = [];
        const tmux: PtyBackend = {
          ...fakeBackend({ name: 'tmux' }),
          available: Effect.succeed(true),
          inspect: () => Effect.succeed({ status: 'alive' as const }),
          kill: (ref) =>
            Effect.sync(() => {
              kills.push(ref.backend);
              return { terminated: true };
            }),
        };
        const nodePty = fakeBackend({
          inspect: () => Effect.die('a node-pty adapter must not inspect a tmux incarnation'),
          kill: () => Effect.die('a node-pty adapter must not kill a tmux incarnation'),
        });

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(nodePty, tmux),
          'test-runtime',
          sessionsPath,
          { nowMs: nowMs() },
        );

        return {
          process: yield* repository.findProcess(process.id),
          logExists: existsSync(process.logPath),
          kills,
        };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(output.process, null);
    assert.equal(output.logExists, false);
    assert.deepEqual(output.kills, ['tmux']);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC keeps a live orphan when its own backend is unavailable', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-backend-unavailable-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const process = yield* insertPtyProcess({
          status: 'running',
          backend: 'tmux',
          logPath: join(sessionsPath, 'running.ptylog'),
          updatedAt: oldIso(),
        });
        writeFileSync(process.logPath, 'session log', 'utf8');
        // Retention now means one thing only: the row's own adapter genuinely
        // cannot answer, so the live process must not be orphaned silently.
        const tmux: PtyBackend = {
          ...fakeBackend({ name: 'tmux' }),
          available: Effect.succeed(false),
          inspect: () => Effect.succeed({ status: 'unavailable' as const }),
          kill: () => Effect.die('an unavailable backend must not be asked to kill'),
        };

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(fakeBackend(), tmux),
          'test-runtime',
          sessionsPath,
          { nowMs: nowMs() },
        );

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
              return { terminated: true };
            }),
        });

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(backend),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
          },
        );

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

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(backend),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
          },
        );

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
              return { terminated: true };
            }),
        });

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(backend),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
          },
        );

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

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(backend),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
          },
        );

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

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(fakeBackend()),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
          },
        );

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

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(fakeBackend()),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
          },
        );

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

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(fakeBackend()),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
          },
        );

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

test('PTY ownership excludes a process referenced by an editor context', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-orphan-editor-owned-'));
  try {
    const orphanIds = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const database = yield* RuntimeDatabase;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const process = yield* insertPtyProcess({
          status: 'running',
          logPath: join(sessionsPath, 'editor.ptylog'),
          updatedAt: oldIso(),
        });
        // An editor context is not a pane session, so it appears in none of the
        // other four ownership tables. If this term is missing the GC reaps a
        // live editor.
        yield* seedEditorContextReference(database, process.id);

        const orphans = yield* repository.listOrphanProcesses;
        return orphans.map((row) => row.id);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(orphanIds, []);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY ownership still orphans a process whose editor handoff never committed', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-orphan-editor-unhanded-'));
  try {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const database = yield* RuntimeDatabase;
        const sessionsPath = join(dataRoot, 'sessions');
        mkdirSync(sessionsPath, { recursive: true });
        const process = yield* insertPtyProcess({
          status: 'running',
          logPath: join(sessionsPath, 'unhanded.ptylog'),
          updatedAt: oldIso(),
        });
        // The editor context exists but holds no pointer, which is exactly the
        // residue a crash between allocation and handoff leaves behind. The
        // widening above must not over-match and disable this cleanup.
        yield* seedEditorContextReference(database, null);

        const orphans = yield* repository.listOrphanProcesses;
        return { orphanIds: orphans.map((row) => row.id), processId: process.id };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.deepEqual(output.orphanIds, [output.processId]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC deletes orphan shell-integration folders and keeps live and young ones', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-shell-integration-'));
  try {
    const sessionsPath = join(dataRoot, 'sessions');
    const root = join(sessionsPath, 'shell-integration');
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        const live = yield* insertPtyProcess({
          status: 'running',
          logPath: join(sessionsPath, 'live.ptylog'),
          updatedAt: recentIso(),
        });
        plantShellIntegrationFolder(root, String(live.id), oldDate());
        plantShellIntegrationFolder(root, '900', oldDate());
        plantShellIntegrationFolder(root, '901', new Date(nowMs() - 60_000));

        yield* collectPtyGarbage(
          repository,
          nodePtyCatalog(fakeBackend()),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
          },
        );
        return { liveId: live.id };
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    assert.equal(existsSync(join(root, String(output.liveId), 'bashrc')), true);
    assert.equal(existsSync(join(root, '900')), false);
    assert.equal(existsSync(join(root, '901')), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC shell-integration collection never reaches outside its root', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-shell-integration-decoy-'));
  const worktree = plantDecoyWorktree();
  try {
    const sessionsPath = join(dataRoot, 'sessions');
    const root = join(sessionsPath, 'shell-integration');
    mkdirSync(root, { recursive: true });
    symlinkSync(worktree, join(root, '910'));
    plantShellIntegrationFolder(root, 'scratch', oldDate());
    writeFileSync(join(root, '911'), 'not a folder');
    utimesSync(join(root, '911'), oldDate(), oldDate());

    await collectShellIntegrationOnly(dataRoot, sessionsPath);

    assert.equal(existsSync(join(worktree, 'src', 'index.ts')), true);
    assert.equal(existsSync(join(root, '910')), true);
    assert.equal(existsSync(join(root, 'scratch')), true);
    assert.equal(existsSync(join(root, '911')), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

for (const linked of ['shell-integration', 'sessions'] as const) {
  test(`PTY GC skips a symlinked ${linked} directory for shell-integration collection`, async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-shell-integration-link-'));
    const worktree = plantDecoyWorktree();
    try {
      plantShellIntegrationFolder(worktree, '920', oldDate());
      const sessionsPath = join(dataRoot, 'sessions');
      if (linked === 'sessions') {
        mkdirSync(join(worktree, 'shell-integration'));
        plantShellIntegrationFolder(join(worktree, 'shell-integration'), '921', oldDate());
        symlinkSync(worktree, sessionsPath);
      } else {
        mkdirSync(sessionsPath);
        symlinkSync(worktree, join(sessionsPath, 'shell-integration'));
      }

      await collectShellIntegrationOnly(dataRoot, sessionsPath);

      assert.equal(existsSync(join(worktree, '920', 'bashrc')), true);
      assert.equal(existsSync(join(worktree, 'src', 'index.ts')), true);
      if (linked === 'sessions') {
        assert.equal(existsSync(join(worktree, 'shell-integration', '921', 'bashrc')), true);
      }
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });
}

test('PTY GC skips an unreadable shell-integration root and collects once it is restored', async (context) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    context.skip('chmod 000 does not block reads on Windows or as root.');
    return;
  }
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-shell-integration-unreadable-'));
  const sessionsPath = join(dataRoot, 'sessions');
  const root = join(sessionsPath, 'shell-integration');
  try {
    plantShellIntegrationFolder(root, '930', oldDate());
    chmodSync(root, 0o000);
    await collectShellIntegrationOnly(dataRoot, sessionsPath);
    chmodSync(root, 0o700);
    assert.equal(existsSync(join(root, '930')), true);

    await collectShellIntegrationOnly(dataRoot, sessionsPath);
    assert.equal(existsSync(join(root, '930')), false);
  } finally {
    chmodSync(root, 0o700);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC skips a shell-integration root replaced by a file and collects once it is restored', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-shell-integration-file-'));
  const sessionsPath = join(dataRoot, 'sessions');
  const root = join(sessionsPath, 'shell-integration');
  try {
    mkdirSync(sessionsPath, { recursive: true });
    writeFileSync(root, 'not a directory');
    await collectShellIntegrationOnly(dataRoot, sessionsPath);

    rmSync(root);
    plantShellIntegrationFolder(root, '931', oldDate());
    await collectShellIntegrationOnly(dataRoot, sessionsPath);
    assert.equal(existsSync(join(root, '931')), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('PTY GC contains a failure of the shell-integration phase', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-shell-integration-failure-'));
  try {
    const sessionsPath = join(dataRoot, 'sessions');
    const root = join(sessionsPath, 'shell-integration');
    plantShellIntegrationFolder(root, '940', oldDate());
    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* PtyRepository;
        // The backend phase reads processes first; the shell-integration mark is the second read.
        let reads = 0;
        const failingMark = {
          ...repository,
          listProcesses: (input?: Parameters<typeof repository.listProcesses>[0]) =>
            ++reads === 2
              ? Effect.fail(new DatabaseError({ operation: 'list_pty_processes', cause: 'boom' }))
              : repository.listProcesses(input),
        };
        yield* collectPtyGarbage(
          failingMark,
          nodePtyCatalog(fakeBackend()),
          'test-runtime',
          sessionsPath,
          {
            nowMs: nowMs(),
          },
        );
        assert.equal(reads, 2);
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );
    assert.equal(existsSync(join(root, '940')), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function collectShellIntegrationOnly(dataRoot: string, sessionsPath: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* PtyRepository;
      yield* collectPtyGarbage(
        repository,
        nodePtyCatalog(fakeBackend()),
        'test-runtime',
        sessionsPath,
        {
          nowMs: nowMs(),
        },
      );
    }).pipe(Effect.provide(testLayer(dataRoot))),
  );
}

function plantShellIntegrationFolder(root: string, name: string, modified: Date) {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'bashrc'), '# rc\n');
  utimesSync(join(folder, 'bashrc'), modified, modified);
  utimesSync(folder, modified, modified);
}

/** A folder outside the data root standing in for a user's worktree; every file must survive. */
function plantDecoyWorktree() {
  const worktree = mkdtempSync(join(tmpdir(), 'isagi-pty-gc-worktree-'));
  mkdirSync(join(worktree, 'src'));
  writeFileSync(join(worktree, 'src', 'index.ts'), 'export {};\n');
  return worktree;
}

function oldDate() {
  return new Date(nowMs() - 6 * 60_000);
}

function seedEditorContextReference(database: RuntimeDatabaseService, ptyProcessId: number | null) {
  return database.use('seed_editor_context_reference_for_gc_test', (db) => {
    const now = '2026-06-18T00:00:00.000Z';
    const project = db
      .insert(projects)
      .values({
        name: 'isagi',
        rootPath: `/repo/isagi-editor-${ptyProcessId ?? 'none'}`,
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
        path: `/repo/isagi-editor-${ptyProcessId ?? 'none'}/wt`,
        branch: 'main',
        head: 'abcdef0',
        createdAt: now,
        updatedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning({ id: worktrees.id })
      .get();
    db.insert(editorContexts)
      .values({
        worktreeId: worktree.id,
        activePtyProcessId: ptyProcessId,
        endpointHost: ptyProcessId === null ? null : '127.0.0.1',
        endpointPort: ptyProcessId === null ? null : 41_287,
        sessionSocketPath: ptyProcessId === null ? null : '/tmp/sock/1-abc123.sock',
        attemptState: 'none',
        attemptReason: null,
        attemptDetail: null,
        attemptStartedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
}

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
  readonly backend?: 'node_pty' | 'tmux';
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
    const backend = input.backend ?? 'node_pty';
    yield* repository.updateBackendMetadata({
      ptyProcessId: id,
      backend,
      backendRefJson:
        input.backendRefJson ??
        JSON.stringify(
          backend === 'tmux'
            ? { schemaVersion: 1, backend: 'tmux', sessionName: `isagi_test-runtime_${id}` }
            : { schemaVersion: 1, backend: 'node_pty', ptyProcessId: id, pid: null },
        ),
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

// Node-pty is the launch preference throughout this file; the tmux slot is a
// real fake so the per-adapter backend-session sweep has something to call, and
// it is unavailable by default so it stays out of the way unless a test opts in.
function nodePtyCatalog(nodePty: PtyBackend, tmux: PtyBackend = unavailableTmuxBackend()) {
  return fakeBackendCatalog({ configured: 'node_pty', nodePty, tmux });
}

function unavailableTmuxBackend(): PtyBackend {
  return {
    ...fakeBackend({ name: 'tmux' }),
    available: Effect.succeed(false),
  };
}

function fakeBackend(
  overrides: Partial<Pick<PtyBackend, 'name' | 'inspect' | 'kill' | 'collectGarbage'>> = {},
): PtyBackend {
  return {
    name: 'node_pty',
    available: Effect.succeed(true),
    launch: () => Effect.die('launch is not used by PTY GC tests'),
    writeInput: () => Effect.die('writeInput is not used by PTY GC tests'),
    attach: () => Effect.die('attach is not used by PTY GC tests'),
    replay: () => Effect.die('replay is not used by PTY GC tests'),
    inspect: () => Effect.succeed({ status: 'missing' as const }),
    listSessions: Effect.succeed([]),
    kill: () => Effect.succeed({ terminated: true }),
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
