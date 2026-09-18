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
  ContentPublishError,
  makeWorkflowContentStore,
  type WorkflowContentStoreService,
} from './content-store.js';
import {
  makeWorkflowOperationsRepository,
  type WorkflowOperationsRepositoryService,
} from './operations.repository.js';
import { makeWorkflowPayloadStore, type WorkflowPayloadStoreService } from './payload-store.js';
import type { WorkflowFrameRecord, WorkflowRunRecord } from './records.js';
import {
  makeWorkflowRunsRepository,
  type CreateRunInput,
  type WorkflowRunsRepositoryService,
} from './runs.repository.js';

export interface WorkflowPersistenceFixture {
  readonly root: string;
  /** Where the content store writes. What `contentPathFor` resolves references against. */
  readonly contentRoot: string;
  readonly client: BetterSqlite.Database;
  readonly database: RuntimeDatabaseService;
  readonly content: WorkflowContentStoreService;
  readonly payloads: WorkflowPayloadStoreService;
  readonly runs: WorkflowRunsRepositoryService;
  readonly operations: WorkflowOperationsRepositoryService;
  /** Registers a catalog row, so a run or attempt has a real pin to reference. */
  readonly seedArtifact: (artifactHash: string, rootGraphKey?: string) => void;
  /** Seeds a worktree and surface, so the claim's live-placement re-check can pass. */
  readonly seedPlacement: () => { readonly worktreeId: number; readonly surfaceId: number };
  /**
   * Makes exactly the next content publication fail, then restores normal behaviour.
   *
   * A publication failure is otherwise only reachable by making the filesystem refuse a write,
   * which is coarse: it fails every subsequent write too, and on some platforms it is not
   * reproducible at all. This seam lets a test fail one capture in the middle of a run and then
   * watch the run carry on.
   */
  readonly failNextPut: () => void;
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

  const contentRoot = join(root, 'workflow-payloads');
  const underlying = makeWorkflowContentStore(contentRoot, database);
  let failNext = false;
  const content: WorkflowContentStoreService = {
    ...underlying,
    put: (input) => {
      if (!failNext) return underlying.put(input);
      failNext = false;
      return Effect.fail(
        new ContentPublishError({ message: 'Injected publication failure.', cause: undefined }),
      );
    },
  };
  const payloads = makeWorkflowPayloadStore(content);
  // Each placement gets its own project path: `projects.root_path` is uniquely indexed, and a test
  // that needs two independent runs would otherwise collide on the second seed.
  let placements = 0;

  return {
    root,
    contentRoot,
    client,
    database,
    content,
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
    failNextPut: () => {
      failNext = true;
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
 * Creates a run and leaves it **preparing**: claimed at `environment_preparation`, no destination,
 * no attachment.
 *
 * The one place the `createRun` launch fixture is composed. It is shared rather than restated
 * because that input shape is still moving — this story alone took `destination` and `attachment`
 * off it and added `preparation`, and the placement request DTO moves again in phase 10. Two object
 * literals building it would both keep compiling with a field added to one and forgotten in the
 * other, since every key of `preparation` is either optional or supplied per call.
 */
export async function createPreparingRun(
  fixture: WorkflowPersistenceFixture,
  input: {
    readonly workflowKey: string;
    readonly title: string;
    readonly rootGraphKey: string;
    readonly artifactHash: string;
    readonly rootFrame: CreateRunInput['rootFrame'];
    readonly placement: { readonly worktreeId: number; readonly surfaceId: number };
    readonly worktreePath?: string;
    readonly owner?: string;
    readonly ownerIncarnation?: string;
    /** Defaults to the current/current placement nobody chose, which is what most tests want. */
    readonly preparation?: CreateRunInput['preparation'];
  },
): Promise<{
  run: WorkflowRunRecord;
  frame: WorkflowFrameRecord;
  attempt: { readonly id: number };
  worktreePath: string;
  owner: string;
  ownerIncarnation: string;
}> {
  const worktreePath = input.worktreePath ?? '/repo/fixture';
  const owner = input.owner ?? PLACEMENT_OWNER;
  const ownerIncarnation = input.ownerIncarnation ?? PLACEMENT_INCARNATION;
  const created = await run(
    fixture.runs.createRun({
      workflowKey: input.workflowKey,
      title: input.title,
      rootGraphKey: input.rootGraphKey,
      artifactHash: input.artifactHash,
      rootFrame: input.rootFrame,
      origin: {
        worktreeId: input.placement.worktreeId,
        worktreePath,
        surfaceId: input.placement.surfaceId,
        paneId: null,
        agentSessionId: null,
      },
      preparation: input.preparation ?? {
        source: 'default',
        request: { worktree: { kind: 'current' }, surface: { kind: 'current' } },
        baseCommit: null,
        checkoutPath: null,
      },
      claim: { owner, ownerIncarnation, input: { value: { segment: 'environment_preparation' } } },
    }),
  );
  if (!created.ok) {
    throw new Error(`expected a created run, got ${JSON.stringify(created.rejection)}`);
  }
  return {
    run: created.value.run,
    frame: created.value.frame,
    attempt: created.value.attempt,
    worktreePath,
    owner,
    ownerIncarnation,
  };
}

/**
 * Creates a run and places it, the way a launch does, leaving it exactly where a claim expects it.
 *
 * Creation and placement are two transactions now: `createPreparingRun` leaves the run claimed at
 * `environment_preparation` with no destination, and `commitEnvironmentPreparation` is what makes a
 * destination effective. Almost every test downstream of this is about what happens *after* a run
 * is placed, so they go through here rather than each one learning the preparation protocol — and
 * as a side benefit the real commit path is exercised by the whole suite instead of only by its own
 * file.
 *
 * A test that is about preparation itself stops at `createPreparingRun` and drives the steps.
 */
export async function createPlacedRun(
  fixture: WorkflowPersistenceFixture,
  input: {
    readonly workflowKey: string;
    readonly title: string;
    readonly rootGraphKey: string;
    readonly artifactHash: string;
    readonly rootFrame: CreateRunInput['rootFrame'];
    readonly placement: { readonly worktreeId: number; readonly surfaceId: number };
    readonly worktreePath?: string;
    readonly owner?: string;
    readonly ownerIncarnation?: string;
  },
): Promise<{ run: WorkflowRunRecord; frame: WorkflowFrameRecord }> {
  const created = await createPreparingRun(fixture, input);
  const placed = await run(
    fixture.runs.commitEnvironmentPreparation({
      runId: created.run.id,
      attemptId: created.attempt.id,
      owner: created.owner,
      ownerIncarnation: created.ownerIncarnation,
      destination: {
        worktreeId: input.placement.worktreeId,
        worktreePath: created.worktreePath,
        surfaceId: input.placement.surfaceId,
      },
    }),
  );
  if (!placed.ok) {
    throw new Error(`expected a placed run, got ${JSON.stringify(placed.rejection)}`);
  }
  const record = (await run(fixture.runs.findRun(created.run.id)))!;
  return { run: record, frame: created.frame };
}

const PLACEMENT_OWNER = 'workflow-launch:test';
const PLACEMENT_INCARNATION = 'incarnation:test';

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

/**
 * Where a reference's bytes live, for tests that need to delete or corrupt a blob.
 *
 * Re-exported from the adapter that owns the layout rather than restated here, so a test cannot
 * drift from where the store actually writes. Production code resolves references through the
 * store, never through a path, because a path read would skip verification.
 */
export { contentPathFor } from './content-store.js';
