import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Effect } from 'effect';

import {
  DatabaseError,
  type RuntimeDatabaseService,
  type RuntimeDrizzleDatabase,
} from '../../persistence/database.service.js';
import { migrationsDirectory } from '../../persistence/migrations.js';
import * as schema from '../../persistence/schema.js';
import {
  makeWorkflowOperationsRepository,
  type WorkflowOperationsRepositoryService,
} from './operations.repository.js';
import { makeWorkflowPayloadStore, type WorkflowPayloadStoreService } from './payload-store.js';
import {
  makeWorkflowRunsRepository,
  type WorkflowRunsRepositoryService,
} from './runs.repository.js';

export interface WorkflowPersistenceFixture {
  readonly root: string;
  readonly client: BetterSqlite.Database;
  readonly database: RuntimeDatabaseService;
  readonly payloads: WorkflowPayloadStoreService;
  readonly runs: WorkflowRunsRepositoryService;
  readonly operations: WorkflowOperationsRepositoryService;
  /** Registers a catalog row, so a run or attempt has a real pin to reference. */
  readonly seedArtifact: (artifactHash: string, rootGraphKey?: string) => void;
  /** Seeds a worktree and surface, so the claim's live-placement re-check can pass. */
  readonly seedPlacement: () => { readonly worktreeId: number; readonly surfaceId: number };
  readonly close: () => void;
}

/**
 * A real SQLite database in a throwaway directory, migrated exactly as the runtime migrates it.
 *
 * The invariants these tests exist for — natural uniqueness, the slot constraints, the partial
 * unique indexes, cascade shape — are properties of the schema, so an in-memory approximation would
 * assert nothing about them. Foreign keys are enforced here for the same reason.
 */
export function makeWorkflowPersistenceFixture(): WorkflowPersistenceFixture {
  const root = mkdtempSync(join(tmpdir(), 'isagi-workflow-persistence-'));
  const client = new BetterSqlite(join(root, 'isagi.db'));
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  const drizzled = drizzle(client, { schema });
  migrate(drizzled, { migrationsFolder: migrationsDirectory() });

  const database: RuntimeDatabaseService = {
    use: (operation, execute) =>
      Effect.try({
        try: () => execute(drizzled as unknown as RuntimeDrizzleDatabase),
        catch: (cause) => new DatabaseError({ operation, cause }),
      }),
    transaction: (operation, execute) =>
      Effect.try({
        try: () =>
          drizzled.transaction((transaction) =>
            execute(transaction as unknown as RuntimeDrizzleDatabase),
          ),
        catch: (cause) => new DatabaseError({ operation, cause }),
      }),
  };

  const payloads = makeWorkflowPayloadStore(join(root, 'workflow-payloads'), database);
  // Each placement gets its own project path: `projects.root_path` is uniquely indexed, and a test
  // that needs two independent runs would otherwise collide on the second seed.
  let placements = 0;

  return {
    root,
    client,
    database,
    payloads,
    runs: makeWorkflowRunsRepository(database, payloads),
    operations: makeWorkflowOperationsRepository(database, payloads),
    seedArtifact: (artifactHash, rootGraphKey = 'root') => {
      client
        .prepare(
          `INSERT OR IGNORE INTO workflow_artifacts (
             artifact_hash, workflow_key, contract_version, manifest_version, descriptor_version,
             sdk_version, verifier_version, source_hash, structure_hash, root_graph_key,
             descriptor_inline, first_seen_at
           ) VALUES (?, 'fixture', 2, 2, 1, '0.1.0', '0.1.0', ?, ?, ?, '{}', '2026-01-01T00:00:00.000Z')`,
        )
        .run(artifactHash, 's'.repeat(64), 'h'.repeat(64), rootGraphKey);
    },
    seedPlacement: () => {
      placements += 1;
      const path = placements === 1 ? '/repo/fixture' : `/repo/fixture-${placements}`;
      const project = client
        .prepare(
          `INSERT INTO projects (name, root_path, kind, status, sort_order, created_at, updated_at)
           VALUES ('fixture', ?, 'git', 'present', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(path);
      const worktree = client
        .prepare(
          `INSERT INTO worktrees (project_id, path, branch, head, sort_order, created_at, updated_at, first_seen_at)
           VALUES (?, ?, 'main', NULL, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(project.lastInsertRowid, path);
      const surface = client
        .prepare(
          `INSERT INTO worktree_surfaces (worktree_id, title, layout_json, sort_order, created_at, updated_at)
           VALUES (?, 'Surface', '{}', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(worktree.lastInsertRowid);
      return {
        worktreeId: Number(worktree.lastInsertRowid),
        surfaceId: Number(surface.lastInsertRowid),
      };
    },
    close: () => {
      client.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Composes the operands a claim needs, the way a dispatcher would.
 *
 * A caller is the only party that knows what a segment's input *is*, so tests compose one here
 * rather than letting the repository invent it: the state boundary the segment is about to run
 * against, plus the position and pin it was read under. Tests that care about a specific envelope
 * or a deliberately stale preparation build their own.
 */
export async function prepareClaim(fixture: WorkflowPersistenceFixture, runId: number) {
  const current = (await run(fixture.runs.findRun(runId)))!;
  const frame = current.activeFrameId
    ? await run(fixture.runs.findFrame(current.activeFrameId))
    : null;
  const state = frame?.state ? await run(fixture.payloads.resolve(frame.state)) : null;
  return {
    runId: current.id,
    controlRevision: current.controlRevision,
    input: { value: { segment: current.position.kind, state } },
    preparation: {
      position: current.position,
      artifactHash: current.artifactHash,
      frameStates: frame ? [{ frameId: frame.id, state: frame.state }] : [],
    },
  };
}

/** Runs a repository Effect and fails the test on an unexpected error rather than swallowing it. */
export function run<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, never>);
}
