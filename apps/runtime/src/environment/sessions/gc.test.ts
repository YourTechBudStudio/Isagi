import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import { AgentSessionArtifacts } from '../../harnesses/index.js';
import { InternalRuntimeEventBus } from '../../platform/events/index.js';
import { EntityLock } from '../../platform/locks/index.js';
import { DataDirectory, RuntimeDatabase } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { projects, worktrees } from '../../projects/tables.js';
import { AgentSessionRepository } from '../agent-sessions/repository.js';
import { agentSessions } from '../tables.js';
import { TerminalSessionRepository } from '../terminal-sessions/repository.js';
import { makeSessionGc } from './gc.js';
import { SessionLifecycle } from './lifecycle.js';

// Two hours: past the one-hour folder grace and the one-minute row grace.
const oldDate = new Date(Date.now() - 2 * 60 * 60_000);

test('the session GC tick deletes orphan agent folders and keeps live, young and still-written ones', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-session-gc-folders-')));
  try {
    const root = join(dataRoot, 'sessions', 'agent-sessions');
    await runWithSessionGc(dataRoot, ({ tick, artifacts }) =>
      Effect.gen(function* () {
        yield* seedWorktree();
        yield* seedAgentSession(11, new Date().toISOString());
        for (const id of [10, 11, 12, 13]) yield* artifacts.initializeMetadata(id);
        backdateFolder(join(root, '10'));
        backdateFolder(join(root, '11'));
        backdateFolder(join(root, '13'));
        writeFileSync(join(root, '13', 'ledger.harness.jsonl'), '{}\n');

        yield* tick;
      }),
    );

    assert.equal(existsSync(join(root, '10')), false);
    assert.equal(existsSync(join(root, '11')), true);
    assert.equal(existsSync(join(root, '12')), true);
    assert.equal(existsSync(join(root, '13')), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('deleting an agent session removes its row and leaves its folder to the collector', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-session-gc-row-only-')));
  try {
    const folder = join(dataRoot, 'sessions', 'agent-sessions', '10');
    await runWithSessionGc(dataRoot, ({ tick, agents, artifacts }) =>
      Effect.gen(function* () {
        yield* seedWorktree();
        yield* seedAgentSession(10, new Date().toISOString());
        yield* artifacts.initializeMetadata(10);

        yield* agents.delete(10);
        assert.equal(yield* agents.find(10), null);
        assert.equal(existsSync(folder), true);

        backdateFolder(folder);
        yield* tick;
        assert.equal(existsSync(folder), false);
      }),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('the session GC tick never follows links out of the agent folder root', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-session-gc-decoy-')));
  const worktree = mkdtempSync(join(tmpdir(), 'isagi-session-gc-worktree-'));
  try {
    writeFileSync(join(worktree, 'index.ts'), 'export {};\n');
    mkdirSync(join(worktree, '31'));
    backdateFolder(join(worktree, '31'));
    utimesSync(worktree, oldDate, oldDate);
    const root = join(dataRoot, 'sessions', 'agent-sessions');
    mkdirSync(root, { recursive: true });
    symlinkSync(worktree, join(root, '30'));

    await runWithSessionGc(dataRoot, ({ tick }) => tick);

    assert.equal(existsSync(join(worktree, 'index.ts')), true);
    assert.equal(existsSync(join(worktree, '31')), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('a defect in the folder phase is logged and the next tick still runs the row phase', async (context) => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-session-gc-defect-')));
  const warnings: unknown[][] = [];
  context.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  try {
    await runWithSessionGc(
      dataRoot,
      ({ tick, agents }) =>
        Effect.gen(function* () {
          yield* seedWorktree();
          yield* seedAgentSession(10, oldDate.toISOString());
          yield* tick;
          assert.equal(yield* agents.find(10), null);

          yield* seedAgentSession(11, oldDate.toISOString());
          yield* tick;
          assert.equal(yield* agents.find(11), null);
        }),
      (artifacts) => ({
        ...artifacts,
        collectOrphanFolders: () =>
          Effect.promise(() => Promise.reject(new Error('folder phase exploded'))),
      }),
    );

    const folderFailures = warnings.filter(
      ([message]) => message === '[runtime] orphan agent folder GC failed',
    );
    assert.equal(folderFailures.length, 2);
    assert.match(String(folderFailures[0]?.[1]), /folder phase exploded/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

function runWithSessionGc<E>(
  dataRoot: string,
  body: (input: {
    readonly tick: Effect.Effect<void>;
    readonly agents: AgentSessionRepository['Service'];
    readonly artifacts: AgentSessionArtifacts['Service'];
  }) => Effect.Effect<void, E, RuntimeDatabase>,
  wrapArtifacts: (
    artifacts: AgentSessionArtifacts['Service'],
  ) => AgentSessionArtifacts['Service'] = (artifacts) => artifacts,
) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabase.layer.pipe(Layer.provide(directory));
  const artifacts = AgentSessionArtifacts.layer.pipe(Layer.provide(directory));
  const layer = Layer.mergeAll(
    AgentSessionRepository.layer,
    TerminalSessionRepository.layer,
    SessionLifecycle.layer.pipe(Layer.provide(EntityLock.layer)),
    InternalRuntimeEventBus.layer,
    artifacts,
    database,
  ).pipe(Layer.provide(artifacts), Layer.provide(database));

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const agents = yield* AgentSessionRepository;
        const sessionArtifacts = wrapArtifacts(yield* AgentSessionArtifacts);
        const { tick } = makeSessionGc({
          agents,
          terminals: yield* TerminalSessionRepository,
          lifecycle: yield* SessionLifecycle,
          events: yield* InternalRuntimeEventBus,
          artifacts: sessionArtifacts,
        });
        yield* body({ tick, agents, artifacts: sessionArtifacts });
      }).pipe(Effect.provide(layer)),
    ),
  );
}

function seedWorktree() {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('seed_session_gc_worktree', (db) => {
      const now = new Date().toISOString();
      db.insert(projects)
        .values({
          id: 1,
          name: 'Isagi',
          rootPath: '/repo/isagi',
          status: 'present',
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          missingReason: null,
        })
        .run();
      db.insert(worktrees)
        .values({
          id: 1,
          projectId: 1,
          path: '/repo/isagi',
          branch: 'main',
          head: null,
          createdAt: now,
          updatedAt: now,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .run();
    });
  });
}

function seedAgentSession(id: number, updatedAt: string) {
  return Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    yield* database.use('seed_session_gc_agent', (db) => {
      db.insert(agentSessions)
        .values({
          id,
          worktreeId: 1,
          harness: 'pi',
          cwd: '/repo/isagi',
          activePtyProcessId: null,
          createdAt: updatedAt,
          updatedAt,
          lastSeenAt: null,
        })
        .run();
    });
  });
}

function backdateFolder(path: string) {
  for (const name of readdirSync(path)) utimesSync(join(path, name), oldDate, oldDate);
  utimesSync(path, oldDate, oldDate);
}
