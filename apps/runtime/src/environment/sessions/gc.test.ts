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

import { Effect, Exit, Layer, Scope } from 'effect';
import { TestClock } from 'effect/testing';

import { makeLogCapture } from '../../../test/test-support.js';
import { AgentSessionArtifacts } from '../../harnesses/index.js';
import { InternalEvents } from '../../platform/events/index.js';
import { EntityLock } from '../../platform/locks/index.js';
import {
  DatabaseError,
  DataDirectory,
  emptyOrphanSweepStats,
  RuntimeDatabase,
} from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { projects, worktrees } from '../../projects/tables.js';
import { AgentSessionRepository } from '../agent-sessions/repository.js';
import { agentSessions } from '../tables.js';
import { TerminalSessionRepository } from '../terminal-sessions/repository.js';
import { collectSessionGarbage, SessionGc } from './gc.js';
import { SessionLifecycle } from './lifecycle.js';
import type { AgentSessionRow } from './types.js';

const runWithTestClock = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);

// Two hours: past the one-hour folder grace and the one-minute row grace.
const oldDate = new Date(Date.now() - 2 * 60 * 60_000);

test('the session GC tick deletes orphan agent folders and keeps live, young and still-written ones', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-session-gc-folders-')));
  try {
    const root = join(dataRoot, 'sessions', 'agent-sessions');
    await runWithSessionGc(dataRoot, ({ artifacts }) =>
      Effect.gen(function* () {
        yield* seedWorktree();
        yield* seedAgentSession(11, new Date().toISOString());
        for (const id of [10, 11, 12, 13]) yield* artifacts.initializeMetadata(id);
        backdateFolder(join(root, '10'));
        backdateFolder(join(root, '11'));
        backdateFolder(join(root, '13'));
        writeFileSync(join(root, '13', 'ledger.harness.jsonl'), '{}\n');

        yield* collectSessionGarbage;
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
    await runWithSessionGc(dataRoot, ({ agents, artifacts }) =>
      Effect.gen(function* () {
        yield* seedWorktree();
        yield* seedAgentSession(10, new Date().toISOString());
        yield* artifacts.initializeMetadata(10);

        yield* agents.delete(10);
        assert.equal(yield* agents.find(10), null);
        assert.equal(existsSync(folder), true);

        backdateFolder(folder);
        yield* collectSessionGarbage;
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

    await runWithSessionGc(dataRoot, () => collectSessionGarbage);

    assert.equal(existsSync(join(worktree, 'index.ts')), true);
    assert.equal(existsSync(join(worktree, '31')), true);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('a defect in the folder phase is logged and the next tick still runs the row phase', async () => {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isagi-session-gc-defect-')));
  const logs = makeLogCapture();
  try {
    await runWithSessionGc(
      dataRoot,
      ({ agents }) =>
        Effect.gen(function* () {
          yield* seedWorktree();
          yield* seedAgentSession(10, oldDate.toISOString());
          yield* collectSessionGarbage;
          assert.equal(yield* agents.find(10), null);

          yield* seedAgentSession(11, oldDate.toISOString());
          yield* collectSessionGarbage;
          assert.equal(yield* agents.find(11), null);
        }).pipe(Effect.provide(logs.layer)),
      (artifacts) => ({
        ...artifacts,
        collectOrphanFolders: () =>
          Effect.promise(() => Promise.reject(new Error('folder phase exploded'))),
      }),
    );

    const folderFailures = logs.lines.filter(
      (line) => line.message === 'Orphan agent folder GC failed',
    );
    assert.equal(folderFailures.length, 2);
    assert.equal(folderFailures[0]?.level, 'Warn');
    assert.match(folderFailures[0]?.cause ?? '', /folder phase exploded/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('the GC tick runs once per interval on the layer scope', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const fake = makeFakeSessions([{ id: 1, worktreeId: 9 }]);
      yield* Layer.build(SessionGc.layerNoDeps.pipe(Layer.provide(fake.layer)));
      assert.equal(fake.state.listCalls, 0);
      yield* TestClock.adjust('59 seconds');
      assert.equal(fake.state.listCalls, 0);
      yield* TestClock.adjust('1 second');
      assert.equal(fake.state.listCalls, 1);
      assert.equal(fake.state.folderPasses, 1);
      assert.deepEqual(fake.state.rows, []);
      assert.deepEqual(fake.state.deletedEvents, [1]);
      yield* TestClock.adjust('1 minute');
      assert.equal(fake.state.listCalls, 2);
      assert.equal(fake.state.folderPasses, 2);
    }),
  ));

test('a failed tick is logged as a warning and the next tick still runs', () => {
  const logs = makeLogCapture();
  return runWithTestClock(
    Effect.gen(function* () {
      const fake = makeFakeSessions([{ id: 1, worktreeId: 9 }]);
      yield* Layer.build(SessionGc.layerNoDeps.pipe(Layer.provide(fake.layer)));
      fake.state.failNext = true;
      yield* TestClock.adjust('1 minute');
      assert.deepEqual(
        logs.lines.map((line) => [line.level, line.message]),
        [['Warn', 'Orphan session GC failed']],
      );
      assert.match(logs.lines[0]?.cause ?? '', /disk I\/O error/);
      assert.deepEqual(
        fake.state.rows.map((row) => row.id),
        [1],
      );
      // The folder phase ran although the row phase failed.
      assert.equal(fake.state.folderPasses, 1);
      yield* TestClock.adjust('1 minute');
      assert.deepEqual(fake.state.rows, []);
      assert.equal(logs.lines.length, 1);
    }).pipe(Effect.provide(logs.layer)),
  );
});

test('closing the layer scope stops the tick fiber (no leaked timer)', () =>
  runWithTestClock(
    Effect.gen(function* () {
      const fake = makeFakeSessions([]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(SessionGc.layerNoDeps.pipe(Layer.provide(fake.layer)), scope);
      yield* TestClock.adjust('1 minute');
      assert.equal(fake.state.listCalls, 1);
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust('10 minutes');
      assert.equal(fake.state.listCalls, 1);
      assert.equal(fake.state.folderPasses, 1);
    }),
  ));

/**
 * In-memory session rows behind partial repository fakes, with call counters and an injectable list failure. Only
 * agent rows are seeded; terminal rows are always empty.
 */
function makeFakeSessions(
  seed: ReadonlyArray<{ readonly id: number; readonly worktreeId: number }>,
) {
  const state = {
    rows: [...seed],
    listCalls: 0,
    folderPasses: 0,
    failNext: false,
    deletedEvents: [] as number[],
  };
  const layer = Layer.mergeAll(
    Layer.mock(AgentSessionRepository)({
      listOrphans: () =>
        Effect.suspend(() => {
          state.listCalls++;
          if (state.failNext) {
            state.failNext = false;
            return Effect.fail(
              new DatabaseError({
                operation: 'list_orphan_agent_sessions',
                cause: new Error('disk I/O error'),
              }),
            );
          }
          return Effect.succeed(state.rows.map((row) => fakeAgentRow(row.id, row.worktreeId)));
        }),
      delete: (id) =>
        Effect.sync(() => {
          state.rows = state.rows.filter((row) => row.id !== id);
        }),
      listIds: Effect.sync(() => new Set(state.rows.map((row) => row.id))),
    }),
    Layer.mock(TerminalSessionRepository)({ listOrphans: () => Effect.succeed([]) }),
    Layer.mock(SessionLifecycle)({
      hasActiveAttachment: () => Effect.succeed(false),
      supersedeAttachment: () => Effect.void,
    }),
    Layer.mock(AgentSessionArtifacts)({
      paths: () => assert.fail('paths is not used by the session GC'),
      collectOrphanFolders: () =>
        Effect.sync(() => {
          state.folderPasses++;
          return emptyOrphanSweepStats;
        }),
    }),
    Layer.mock(InternalEvents)({
      publish: (event) =>
        Effect.sync(() => {
          if (event.type === 'durable_session_deleted') {
            state.deletedEvents.push(event.identity.sessionId);
          }
        }),
    }),
  );
  return { state, layer };
}

function fakeAgentRow(id: number, worktreeId: number): AgentSessionRow {
  return {
    id,
    worktreeId,
    harness: 'pi',
    cwd: '/repo/isagi',
    harnessSessionId: null,
    harnessMetadataStatus: 'valid',
    harnessMetadataDiagnostic: null,
    activePtyProcessId: null,
    createdAt: oldDate.toISOString(),
    updatedAt: oldDate.toISOString(),
    lastSeenAt: null,
    activePtyProcess: null,
  };
}

/** Runs `body` against real repositories over a temporary data root, with the live clock. */
function runWithSessionGc<E>(
  dataRoot: string,
  body: (input: {
    readonly agents: AgentSessionRepository['Service'];
    readonly artifacts: AgentSessionArtifacts['Service'];
  }) => Effect.Effect<
    void,
    E,
    | RuntimeDatabase
    | AgentSessionArtifacts
    | AgentSessionRepository
    | InternalEvents
    | SessionLifecycle
    | TerminalSessionRepository
  >,
  wrapArtifacts: (
    artifacts: AgentSessionArtifacts['Service'],
  ) => AgentSessionArtifacts['Service'] = (artifacts) => artifacts,
) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabase.layer.pipe(Layer.provide(directory));
  const artifacts = Layer.effect(
    AgentSessionArtifacts,
    Effect.gen(function* () {
      return wrapArtifacts(yield* AgentSessionArtifacts);
    }),
  ).pipe(Layer.provide(AgentSessionArtifacts.layer.pipe(Layer.provide(directory))));
  const layer = Layer.mergeAll(
    AgentSessionRepository.layerNoDeps,
    TerminalSessionRepository.layer,
    SessionLifecycle.layerNoDeps.pipe(Layer.provide(EntityLock.layer)),
    InternalEvents.layer,
  ).pipe(Layer.provideMerge(artifacts), Layer.provideMerge(database));

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const agents = yield* AgentSessionRepository;
        yield* body({ agents, artifacts: yield* AgentSessionArtifacts });
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
