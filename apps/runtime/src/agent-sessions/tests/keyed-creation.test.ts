import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Layer } from 'effect';

import {
  DataDirectory,
  RuntimeDatabase,
  RuntimeDatabaseLive,
  type RuntimeDatabaseService,
} from '../../persistence/index.js';
import { agentSessions } from '../../persistence/schema.js';
import { makeTestDataDirectory } from '../../persistence/test-support.js';
import {
  AgentSessionRepository,
  AgentSessionRepositoryLive,
  type AgentSessionRepositoryService,
} from '../agent-sessions.repository.js';
import { AgentSessionArtifactsLive } from '../harness/ledger.js';

/**
 * The session owner's half of keyed creation.
 *
 * The workflow never writes these rows (ADR 0008); it supplies an intent key and this service
 * decides what already exists under it. These tests are at the repository because that is where the
 * key is written and where the uniqueness that makes concurrent convergence structural lives.
 */
function withRepository<A>(
  body: Effect.Effect<A, unknown, AgentSessionRepositoryService | RuntimeDatabaseService>,
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-agent-keyed-'));
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabaseLive.pipe(Layer.provide(directory));
  const artifacts = AgentSessionArtifactsLive.pipe(Layer.provide(directory));
  const seeded = Effect.gen(function* () {
    // `agent_sessions.worktree_id` cascades from a real worktree, so the row has to exist before
    // any session can. Seeded directly: this file is about the key, not about workspace creation.
    const runtimeDatabase = yield* RuntimeDatabase;
    yield* runtimeDatabase.use('test_seed_worktree', (db) => {
      db.run(
        `INSERT INTO projects (name, root_path, kind, status, sort_order, created_at, updated_at)
         VALUES ('fixture', '/repo', 'git', 'present', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')` as never,
      );
      db.run(
        `INSERT INTO worktrees (project_id, path, branch, head, sort_order, created_at, updated_at, first_seen_at)
         VALUES (1, '/repo', 'main', NULL, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')` as never,
      );
    });
    return yield* body;
  });
  return Effect.runPromise(
    Effect.scoped(
      (
        seeded as Effect.Effect<A, never, AgentSessionRepositoryService | RuntimeDatabaseService>
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            database,
            AgentSessionRepositoryLive.pipe(Layer.provide(database), Layer.provide(artifacts)),
          ),
        ),
      ),
    ),
  ).finally(() => rmSync(dataRoot, { recursive: true, force: true }));
}

test('an unkeyed creation records no key, exactly as before', async () => {
  await withRepository(
    Effect.gen(function* () {
      const repository = yield* AgentSessionRepository;
      const id = yield* repository.create({ worktreeId: 1, harness: 'claude', cwd: '/repo' });
      const found = yield* repository.find(id);
      assert.ok(found);
      assert.equal(yield* repository.findByCreationKey('wop_missing'), null);
    }),
  );
});

test('a keyed creation is findable by its key', async () => {
  await withRepository(
    Effect.gen(function* () {
      const repository = yield* AgentSessionRepository;
      const key = 'wop_22222222-2222-2222-2222-222222222222';
      const id = yield* repository.create({
        worktreeId: 1,
        harness: 'codex',
        cwd: '/repo',
        creationKey: key,
      });
      const found = yield* repository.findByCreationKey(key);
      assert.equal(found?.id, id);
      assert.equal(found?.harness, 'codex');
    }),
  );
});

test('one key names one session, enforced by the database', async () => {
  await withRepository(
    Effect.gen(function* () {
      const repository = yield* AgentSessionRepository;
      const key = 'wop_33333333-3333-3333-3333-333333333333';
      yield* repository.create({
        worktreeId: 1,
        harness: 'claude',
        cwd: '/repo',
        creationKey: key,
      });

      // A second writer that skipped the lookup — the shape a genuinely concurrent retry takes.
      // Convergence has to be structural, because two callers can both read `absent` before either
      // writes.
      const database = yield* RuntimeDatabase;
      const conflict = yield* Effect.either(
        database.use('test_duplicate_keyed_session', (db) => {
          const now = new Date().toISOString();
          db.insert(agentSessions)
            .values({
              worktreeId: 1,
              harness: 'claude',
              cwd: '/repo',
              activePtyProcessId: null,
              creationKey: key,
              createdAt: now,
              updatedAt: now,
              lastSeenAt: null,
            })
            .run();
        }),
      );
      assert.equal(conflict._tag, 'Left');
    }),
  );
});

test('several unkeyed sessions coexist, because the index is partial in effect', async () => {
  await withRepository(
    Effect.gen(function* () {
      const repository = yield* AgentSessionRepository;
      // SQLite treats NULLs as distinct in a unique index, which is what lets every ordinary
      // unkeyed session keep working unchanged.
      const first = yield* repository.create({ worktreeId: 1, harness: 'claude', cwd: '/repo' });
      const second = yield* repository.create({ worktreeId: 1, harness: 'claude', cwd: '/repo' });
      assert.notEqual(first, second);
    }),
  );
});
