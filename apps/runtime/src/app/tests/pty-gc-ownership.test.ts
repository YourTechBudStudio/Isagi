import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import { worktreeCommandStates } from '../../commands/tables.js';
import { editorContexts } from '../../editor/tables.js';
import { DataDirectory, RuntimeDatabase } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { projects, worktrees } from '../../projects/tables.js';
import type { PtyBackendShape as PtyBackend } from '../../pty-processes/index.js';
import { ptyProcesses } from '../../pty-processes/tables.js';
import {
  collectPtyGarbage,
  fakeBackendCatalog,
  PtyRepository,
  ptyProcessOwnerColumns,
} from '../../pty-processes/testing.js';

/**
 * PTY process GC protects a process from collection when any durable owner points at it. The PTY
 * layer is generic and cannot name its owners, so it discovers them from the foreign keys every
 * owning table declares on `pty_processes.id`. These cases need rows from several modules, which is
 * why they live here rather than in `pty-processes`.
 */

function testLayer(dataRoot: string) {
  const dataDirectory = makeTestDataDirectory(dataRoot);
  const dataDirectoryLayer = Layer.succeed(DataDirectory, dataDirectory);
  const database = RuntimeDatabase.layer.pipe(Layer.provide(dataDirectoryLayer));
  const repository = PtyRepository.layer.pipe(Layer.provide(database));
  return Layer.mergeAll(database, repository);
}

test('PTY ownership is discovered from every foreign key to pty_processes.id', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-owner-columns-'));
  try {
    const owners = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* RuntimeDatabase;
        return yield* database.use('list_pty_owner_columns_for_test', (db) =>
          ptyProcessOwnerColumns(db),
        );
      }).pipe(Effect.provide(testLayer(dataRoot))),
    );

    // Adding an owner means declaring its foreign key; this set changing is the signal that a new
    // owner joined (or an old one lost its key and is no longer protected from GC).
    assert.deepEqual(owners.map((owner) => `${owner.tableName}.${owner.columnName}`).sort(), [
      'agent_sessions.active_pty_process_id',
      'editor_contexts.active_pty_process_id',
      'terminal_sessions.active_pty_process_id',
      'worktree_command_runs.pty_process_id',
      'worktree_command_states.active_pty_process_id',
    ]);
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

function seedEditorContextReference(
  database: RuntimeDatabase['Service'],
  ptyProcessId: number | null,
) {
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

function seedCommandStateReference(database: RuntimeDatabase['Service'], ptyProcessId: number) {
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
      backendRefJson: JSON.stringify({
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

// Node-pty is the launch preference; the tmux slot is unavailable so it stays out of the way.
function nodePtyCatalog(nodePty: PtyBackend) {
  return fakeBackendCatalog({
    configured: 'node_pty',
    nodePty,
    tmux: { ...fakeBackend({ name: 'tmux' }), available: Effect.succeed(false) },
  });
}

function fakeBackend(overrides: Partial<Pick<PtyBackend, 'name'>> = {}): PtyBackend {
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
