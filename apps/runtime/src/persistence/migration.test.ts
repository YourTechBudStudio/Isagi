import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import BetterSqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Effect, Layer, Schema } from 'effect';

import { workspaceSnapshotSchema } from '@isagi/contracts';

import { WorkspaceRepository, WorkspaceRepositoryLive } from '../workspace/workspace.repository.js';
import { buildWorkspaceSnapshot } from '../workspace/workspace.snapshot.js';
import { DataDirectory } from './data-directory.service.js';
import { RuntimeDatabase, RuntimeDatabaseLive } from './database.service.js';
import { migrationsDirectory } from './migrations.js';
import {
  projects,
  workflowArtifacts,
  workflowGraphFrames,
  workflowNodeExecutions,
  workflowPayloads,
  workflowRunAttachments,
  workflowRuns,
  workflowSegmentAttempts,
  workflowTransitions,
  worktrees,
} from './schema.js';
import { makeTestDataDirectory } from './test-support.js';

/**
 * Proves the rail-ordering migration (`0002`) upgrades a database created before
 * it existed, rather than only that its generated SQL reads as additive.
 *
 * The test builds a real pre-`0002` database by running the committed `0000` and
 * `0001` artifacts through the same Drizzle migrator the runtime uses, seeds it
 * with raw SQL (the current Drizzle models name columns that do not exist yet),
 * then opens the production database layer over the same file and lets the real
 * migration path run. The comparison is whole rows read straight out of SQLite
 * before and after — every historical column, including identifiers and
 * timestamps, minus only the columns `0002` introduces. Counting rows would not
 * catch a table rebuild that dropped, regenerated, or re-sorted a column, and
 * hand-listing fields would silently stop covering any column the list forgets.
 */

/** The migration set as it stood before rail ordering added `sort_order`. */
const HISTORICAL_TAGS = ['0000_lazy_morbius', '0001_durable_workflow_artifact_pin'] as const;
const PRE_WORKFLOW_CONTROL_TAGS = [
  ...HISTORICAL_TAGS,
  '0002_daily_thor_girl',
  '0003_peaceful_squirrel_girl',
] as const;

/** The migration set as it stood before the graph-workflow replacement. */
const PRE_GRAPH_WORKFLOW_TAGS = [
  '0000_lazy_morbius',
  '0001_durable_workflow_artifact_pin',
  '0002_daily_thor_girl',
  '0003_peaceful_squirrel_girl',
  '0004_mixed_synch',
  '0005_tiny_jackal',
  '0006_stale_the_hood',
  '0007_light_supreme_intelligence',
] as const;

/** The migration set as it stood before project kind was introduced. */
const PRE_PROJECT_KIND_TAGS = [
  ...PRE_WORKFLOW_CONTROL_TAGS,
  '0004_mixed_synch',
  '0005_tiny_jackal',
  '0006_stale_the_hood',
] as const;

/** The migration set as it stood before the durable preparation record. */
const PRE_PREPARATION_TAGS = [
  '0000_lazy_morbius',
  '0001_durable_workflow_artifact_pin',
  '0002_daily_thor_girl',
  '0003_peaceful_squirrel_girl',
  '0004_mixed_synch',
  '0005_tiny_jackal',
  '0006_stale_the_hood',
  '0007_light_supreme_intelligence',
  '0008_retire_v1_workflow_store',
  '0009_graph_workflow_records',
  '0010_workflow_transition_changes',
] as const;

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

interface Journal {
  readonly entries: readonly JournalEntry[];
}

/**
 * Copies the committed historical migrations into a throwaway folder with a
 * journal truncated to them. Only the temporary copy is truncated; the committed
 * artifacts are never read for anything but their exact bytes, so the upgrade
 * being exercised is the one users actually receive.
 */
function historicalMigrationsFolder(root: string, tags: readonly string[] = HISTORICAL_TAGS) {
  const source = migrationsDirectory();
  const folder = join(root, 'migrations');
  mkdirSync(join(folder, 'meta'), { recursive: true });

  for (const tag of tags) {
    copyFileSync(join(source, `${tag}.sql`), join(folder, `${tag}.sql`));
  }

  const journal = JSON.parse(readFileSync(join(source, 'meta/_journal.json'), 'utf8')) as Journal;
  const entries = journal.entries.filter((entry) => tags.includes(entry.tag));
  assert.equal(
    entries.length,
    tags.length,
    'Expected the committed journal to contain every requested historical migration.',
  );
  writeFileSync(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return folder;
}

const SEEDED_PROJECTS = [
  {
    name: 'isagi',
    root_path: '/repo/isagi',
    status: 'present',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    last_seen_at: '2026-01-02T00:00:00.000Z',
    missing_reason: null,
  },
  {
    name: 'atlas',
    root_path: '/repo/atlas',
    status: 'present',
    created_at: '2026-01-03T00:00:00.000Z',
    updated_at: '2026-01-04T00:00:00.000Z',
    last_seen_at: '2026-01-04T00:00:00.000Z',
    missing_reason: null,
  },
  {
    name: 'ghost',
    root_path: '/repo/ghost',
    status: 'missing',
    created_at: '2026-01-05T00:00:00.000Z',
    updated_at: '2026-01-06T00:00:00.000Z',
    last_seen_at: '2026-01-05T00:00:00.000Z',
    missing_reason: 'Directory no longer exists.',
  },
] as const;

// Deliberately not in path order, so an accidental re-sort during migration
// would be visible as something other than the identifier tie-break.
const SEEDED_WORKTREES = [
  { project_id: 1, path: '/repo/isagi/wt-feature', branch: 'feature', head: 'aaaaaa1' },
  { project_id: 1, path: '/repo/isagi', branch: 'main', head: 'aaaaaa2' },
  { project_id: 1, path: '/repo/isagi/wt-fix', branch: 'fix', head: 'aaaaaa3' },
  { project_id: 2, path: '/repo/atlas', branch: 'main', head: 'bbbbbb1' },
] as const;

const SEEDED_SURFACES = [
  { worktree_id: 1, title: 'Agent', sort_order: 0 },
  { worktree_id: 1, title: 'Terminal', sort_order: 1 },
  { worktree_id: 2, title: 'Agent', sort_order: 0 },
] as const;

/**
 * Tables whose historical contents must survive the upgrade, mapped to the
 * columns added between the pre-`0002` baseline and the current migration head.
 * Everything not listed here has to come back unchanged — note that
 * `worktree_surfaces.sort_order` predates `0002` and so is *not* excused from
 * the comparison. `projects.kind` arrives later, in `0007`, and
 * `worktree_surfaces.creation_key` later still, in `0011`, but this case
 * migrates all the way to head, so both are excused here too; the dedicated
 * pre-kind case below is what actually asserts the backfilled value.
 */
const ADDED_COLUMNS = {
  projects: ['sort_order', 'kind'],
  worktrees: ['sort_order'],
  worktree_surfaces: ['creation_key'],
} as const satisfies Record<string, readonly string[]>;

type RawRow = Record<string, unknown>;

/**
 * Reads every column of every row, dropping the columns the migration adds so
 * the same shape is comparable on both sides of the upgrade.
 */
function readHistoricalRows<Table extends string>(
  client: BetterSqlite.Database,
  addedColumns: Record<Table, readonly string[]>,
) {
  const snapshot = {} as Record<Table, RawRow[]>;
  for (const table of Object.keys(addedColumns) as Table[]) {
    const added: readonly string[] = addedColumns[table];
    const rows = client.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as RawRow[];
    snapshot[table] = rows.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([column]) => !added.includes(column))),
    );
  }
  return snapshot;
}

function seedPreOrderDatabase(databasePath: string, migrationsFolder: string) {
  const client = new BetterSqlite(databasePath);
  try {
    client.pragma('foreign_keys = ON');
    migrate(drizzle(client), { migrationsFolder });

    assert.equal(
      hasColumn(client, 'projects', 'sort_order'),
      false,
      'Expected the historical schema to predate projects.sort_order.',
    );
    assert.equal(
      hasColumn(client, 'worktrees', 'sort_order'),
      false,
      'Expected the historical schema to predate worktrees.sort_order.',
    );

    const insertProject = client.prepare(
      `INSERT INTO projects (name, root_path, status, created_at, updated_at, last_seen_at, missing_reason)
       VALUES (@name, @root_path, @status, @created_at, @updated_at, @last_seen_at, @missing_reason)`,
    );
    for (const project of SEEDED_PROJECTS) insertProject.run(project);

    const insertWorktree = client.prepare(
      `INSERT INTO worktrees (project_id, path, branch, head, created_at, updated_at, first_seen_at, last_seen_at)
       VALUES (@project_id, @path, @branch, @head, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
    );
    for (const worktree of SEEDED_WORKTREES) insertWorktree.run(worktree);

    const insertSurface = client.prepare(
      `INSERT INTO worktree_surfaces (worktree_id, title, layout_json, sort_order, created_at, updated_at)
       VALUES (@worktree_id, @title, '{}', @sort_order, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    for (const surface of SEEDED_SURFACES) insertSurface.run(surface);

    return readHistoricalRows(client, ADDED_COLUMNS);
  } finally {
    client.close();
  }
}

function hasColumn(client: BetterSqlite.Database, table: string, column: string) {
  const columns = client.pragma(`table_info(${table})`) as { readonly name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

test('the rail-order migration upgrades a pre-0002 database without losing data', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-migration-'));
  const dataDirectory = makeTestDataDirectory(dataRoot);

  try {
    const seeded = seedPreOrderDatabase(
      dataDirectory.paths.databasePath,
      historicalMigrationsFolder(dataRoot),
    );

    // Opening the production layer applies the committed migration set, which is
    // the upgrade an existing installation performs on its next launch.
    const database = RuntimeDatabaseLive.pipe(
      Layer.provide(Layer.succeed(DataDirectory, dataDirectory)),
    );
    const upgraded = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* RuntimeDatabase;
        const repository = yield* WorkspaceRepository;
        const rows = yield* db.use('test_read_upgraded_rows', (connection) => ({
          projects: connection.select().from(projects).orderBy(projects.id).all(),
          worktrees: connection.select().from(worktrees).orderBy(worktrees.id).all(),
        }));
        return {
          ...rows,
          snapshot: buildWorkspaceSnapshot(
            yield* repository.listProjects,
            yield* repository.listWorktrees,
          ),
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(database, WorkspaceRepositoryLive.pipe(Layer.provide(database))),
        ),
      ),
    );

    // Every historical row, every historical column — identifiers, foreign keys,
    // timestamps, and payloads alike — read back out of the upgraded file and
    // compared against what was seeded. Only the two columns `0002` adds are
    // excluded, so a rebuild that regenerated an id or restamped a timestamp
    // fails here rather than passing as "the right number of rows".
    const reopened = new BetterSqlite(dataDirectory.paths.databasePath, { readonly: true });
    try {
      assert.deepEqual(readHistoricalRows(reopened, ADDED_COLUMNS), seeded);
    } finally {
      reopened.close();
    }
    // Guards the comparison above against passing vacuously on empty tables.
    assert.equal(seeded.projects.length, SEEDED_PROJECTS.length);
    assert.equal(seeded.worktrees.length, SEEDED_WORKTREES.length);
    assert.equal(seeded.worktree_surfaces.length, SEEDED_SURFACES.length);

    // The new columns arrive tied at the default, which is what makes the
    // identifier tie-break reproduce the pre-migration order.
    assert.deepEqual(
      upgraded.projects.map((project) => project.sortOrder),
      [0, 0, 0],
    );
    assert.deepEqual(
      upgraded.worktrees.map((worktree) => worktree.sortOrder),
      [0, 0, 0, 0],
    );

    // The visible consequence of those ties: display order falls back to the
    // identifier, present projects precede the missing one, and the derived root
    // is pinned ahead of siblings that were discovered before it.
    assert.deepEqual(
      upgraded.snapshot.projects.map((project) => project.name),
      ['isagi', 'atlas', 'ghost'],
    );
    assert.deepEqual(
      upgraded.snapshot.projects[0]?.worktrees.map((worktree) => worktree.path),
      ['/repo/isagi', '/repo/isagi/wt-feature', '/repo/isagi/wt-fix'],
    );
    assert.deepEqual(
      upgraded.snapshot.projects[0]?.worktrees.map((worktree) => worktree.isRoot),
      [true, false, false],
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

/**
 * Proves the graph-workflow replacement (`0008` + `0009`) does exactly what the epic authorized and
 * nothing more: the v1 workflow store is dropped, the retained execution model is created, and every
 * unrelated row survives byte-for-byte.
 *
 * "Unrelated data is not disposable" is the actual risk here. A workflow-only replacement is a
 * licence to drop two tables, not a licence to rebuild the database — and a SQLite table rebuild
 * that regenerated an id, restamped a timestamp or cascaded the worktree chain away would look
 * exactly like success if the assertion only counted rows. So the comparison is whole rows read
 * straight out of SQLite before and after, minus only the columns `0009` adds.
 *
 * The upgrade runs the committed migration chain through the production database layer, with foreign
 * keys enforced, rather than an approximation rebuilt from the current schema.
 */
const V1_WORKFLOW_TABLES = ['workflow_runs', 'workflow_run_events'] as const;

/** Every table the retained execution model needs. Named, not counted: a shorthand count is how a
 *  missing table goes unnoticed. */
const V2_WORKFLOW_TABLES = [
  'workflow_runs',
  'workflow_run_attachments',
  'workflow_graph_frames',
  'workflow_node_executions',
  'workflow_segment_attempts',
  'workflow_transitions',
  'workflow_waits',
  'workflow_operations',
  'workflow_artifacts',
  'workflow_version_adoptions',
  'workflow_pause_intervals',
  'workflow_payloads',
  'workflow_transition_changes',
  'workflow_run_preparations',
] as const;

/**
 * `0009` adds `creation_key` to the two owner tables that can create a keyed resource, and `0011`
 * adds it to `worktree_surfaces` as a third, separate keyspace. This case migrates all the way to
 * head, so every one of them is excused here.
 */
const PRE_GRAPH_WORKFLOW_ADDED_COLUMNS = {
  projects: [],
  worktrees: [],
  worktree_surfaces: ['creation_key'],
  surface_panes: ['creation_key'],
  agent_sessions: ['creation_key'],
  terminal_sessions: [],
  pty_processes: [],
  worktree_command_states: [],
} as const satisfies Record<string, readonly string[]>;

function tableExists(client: BetterSqlite.Database, table: string) {
  return (
    client
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) !== undefined
  );
}

/**
 * `0011` adds `creation_key` to `worktree_surfaces`, the third owner table able to create a keyed
 * resource — and the first whose keyspace is deliberately separate from the others.
 */
const PRE_PREPARATION_ADDED_COLUMNS = {
  projects: [],
  worktrees: [],
  worktree_surfaces: ['creation_key'],
  surface_panes: [],
  agent_sessions: [],
} as const satisfies Record<string, readonly string[]>;

/**
 * Builds a genuine pre-`0011` database and populates a whole graph-era run in it.
 *
 * The workflow rows go in through Drizzle rather than raw SQL, which the older cases in this file
 * need: `0011` changes only `worktree_surfaces` and adds a new table, so every workflow model here
 * already matches the pre-`0011` shape exactly. `worktree_surfaces` is still seeded with raw SQL,
 * because its model now names a column the historical schema does not have.
 */
function seedPrePreparationDatabase(databasePath: string, migrationsFolder: string) {
  const client = new BetterSqlite(databasePath);
  try {
    client.pragma('foreign_keys = ON');
    migrate(drizzle(client), { migrationsFolder });

    assert.equal(
      hasColumn(client, 'worktree_surfaces', 'creation_key'),
      false,
      'Expected the historical schema to predate worktree_surfaces.creation_key.',
    );
    assert.equal(
      tableExists(client, 'workflow_run_preparations'),
      false,
      'Expected the historical schema to predate workflow_run_preparations.',
    );

    const insertProject = client.prepare(
      `INSERT INTO projects (name, root_path, kind, status, sort_order, created_at, updated_at, last_seen_at, missing_reason)
       VALUES (@name, @root_path, 'git', @status, @sort_order, @created_at, @updated_at, @last_seen_at, @missing_reason)`,
    );
    for (const [index, project] of SEEDED_PROJECTS.entries()) {
      insertProject.run({ ...project, sort_order: (SEEDED_PROJECTS.length - index) * 10 });
    }

    const insertWorktree = client.prepare(
      `INSERT INTO worktrees (project_id, path, branch, head, sort_order, created_at, updated_at, first_seen_at, last_seen_at)
       VALUES (@project_id, @path, @branch, @head, @sort_order, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
    );
    for (const [index, worktree] of SEEDED_WORKTREES.entries()) {
      insertWorktree.run({ ...worktree, sort_order: index * 5 });
    }

    const insertSurface = client.prepare(
      `INSERT INTO worktree_surfaces (worktree_id, title, layout_json, sort_order, created_at, updated_at)
       VALUES (@worktree_id, @title, '{}', @sort_order, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    for (const surface of SEEDED_SURFACES) insertSurface.run(surface);

    const at = '2026-09-01T00:00:00.000Z';
    const artifactHash = 'c'.repeat(64);
    const db = drizzle(client);

    db.insert(workflowPayloads)
      .values({
        payloadRef: 'sha256:' + 'd'.repeat(64),
        byteSize: 12,
        mediaType: 'application/json',
        createdAt: at,
      })
      .run();

    db.insert(workflowArtifacts)
      .values({
        artifactHash,
        workflowKey: 'demo',
        contractVersion: 3,
        manifestVersion: 1,
        descriptorVersion: 1,
        sdkVersion: '0.2.0',
        verifierVersion: '0.2.0',
        sourceHash: 'e'.repeat(64),
        structureHash: 'f'.repeat(64),
        rootGraphKey: 'root',
        descriptorInline: '{}',
        descriptorRef: null,
        firstSeenAt: at,
      })
      .run();

    const run = db
      .insert(workflowRuns)
      .values({
        workflowKey: 'demo',
        title: 'Demo run',
        rootGraphKey: 'root',
        artifactHash,
        status: 'ready',
        positionJson: JSON.stringify({ kind: 'graph_entry', frameId: 1 }),
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: workflowRuns.id })
      .all()[0]!;

    const frame = db
      .insert(workflowGraphFrames)
      .values({
        runId: run.id,
        graphKey: 'root',
        entryArtifactHash: artifactHash,
        depth: 0,
        status: 'active',
        enteredAt: at,
      })
      .returning({ id: workflowGraphFrames.id })
      .all()[0]!;

    db.insert(workflowSegmentAttempts)
      .values({
        runId: run.id,
        frameId: frame.id,
        segmentKind: 'graph_entry',
        attemptIndex: 0,
        artifactHash,
        status: 'running',
        invocationKind: 'initial',
        startedAt: at,
        endCertainty: 'unknown',
      })
      .run();

    db.insert(workflowTransitions)
      .values({ runId: run.id, revision: 1, recordedAt: at, kind: 'run_started' })
      .run();

    db.insert(workflowRunAttachments)
      .values({ runId: run.id, worktreeId: 1, surfaceId: 1, attachedAt: at })
      .run();

    // Proves the seed actually populated every table the delete is expected to empty. Without this
    // the post-migration count assertions would pass on a database that never held a run.
    for (const table of [
      'workflow_runs',
      'workflow_graph_frames',
      'workflow_segment_attempts',
      'workflow_transitions',
      'workflow_run_attachments',
      'workflow_artifacts',
      'workflow_payloads',
    ]) {
      assert.equal(
        (client.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
        1,
        `Expected the seed to populate ${table} before the upgrade.`,
      );
    }

    return {
      rows: readHistoricalRows(client, PRE_PREPARATION_ADDED_COLUMNS),
      artifacts: client.prepare('SELECT * FROM workflow_artifacts').all(),
      payloads: client.prepare('SELECT * FROM workflow_payloads').all(),
    };
  } finally {
    client.close();
  }
}

function indexExists(client: BetterSqlite.Database, name: string) {
  return (
    client.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name) !==
    undefined
  );
}

function seedPreGraphWorkflowDatabase(databasePath: string, migrationsFolder: string) {
  const client = new BetterSqlite(databasePath);
  try {
    client.pragma('foreign_keys = ON');
    migrate(drizzle(client), { migrationsFolder });

    assert.equal(
      hasColumn(client, 'surface_panes', 'creation_key'),
      false,
      'Expected the historical schema to predate surface_panes.creation_key.',
    );

    const insertProject = client.prepare(
      `INSERT INTO projects (name, root_path, kind, status, sort_order, created_at, updated_at, last_seen_at, missing_reason)
       VALUES (@name, @root_path, 'git', @status, @sort_order, @created_at, @updated_at, @last_seen_at, @missing_reason)`,
    );
    for (const [index, project] of SEEDED_PROJECTS.entries()) {
      insertProject.run({ ...project, sort_order: (SEEDED_PROJECTS.length - index) * 10 });
    }

    const insertWorktree = client.prepare(
      `INSERT INTO worktrees (project_id, path, branch, head, sort_order, created_at, updated_at, first_seen_at, last_seen_at)
       VALUES (@project_id, @path, @branch, @head, @sort_order, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
    );
    for (const [index, worktree] of SEEDED_WORKTREES.entries()) {
      insertWorktree.run({ ...worktree, sort_order: index * 5 });
    }

    const insertSurface = client.prepare(
      `INSERT INTO worktree_surfaces (worktree_id, title, layout_json, sort_order, created_at, updated_at)
       VALUES (@worktree_id, @title, '{}', @sort_order, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    for (const surface of SEEDED_SURFACES) insertSurface.run(surface);

    client
      .prepare(
        `INSERT INTO surface_panes (surface_id, title, sort_order, session_kind, session_id, created_at, updated_at)
         VALUES (1, 'agent', 0, 'agent_session', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    client
      .prepare(
        `INSERT INTO agent_sessions (worktree_id, harness, cwd, active_pty_process_id, created_at, updated_at, last_seen_at)
         VALUES (1, 'claude', '/repo/isagi', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
      )
      .run();
    client
      .prepare(
        `INSERT INTO terminal_sessions (worktree_id, cwd, shell_command, shell_args_json, active_pty_process_id, created_at, updated_at)
         VALUES (1, '/repo/isagi', '/bin/zsh', '[]', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    client
      .prepare(
        `INSERT INTO pty_processes (backend, backend_ref_json, command, args_json, cwd, status, log_mode, created_at, updated_at)
         VALUES ('node_pty', '{}', '/bin/zsh', '[]', '/repo/isagi', 'exited', 'none', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    client
      .prepare(
        `INSERT INTO worktree_command_states (worktree_id, command_name, status, active_pty_process_id, resolved_ports_json, created_at, updated_at)
         VALUES (1, 'dev', 'idle', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    // The v1 workflow store, populated, so the drop is proven against real rows rather than against
    // two empty tables.
    const run = client
      .prepare(
        `INSERT INTO workflow_runs (
           workflow_key, workflow_title, workflow_artifact_hash, worktree_id, surface_id, status,
           control_revision, retrying, paused, cancel_requested, state_json, state_version,
           created_at, updated_at
         ) VALUES ('legacy', 'Legacy run', ?, 1, 1, 'waiting', 0, 0, 0, 0, '{"phase":"waiting"}', 1,
                   '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
      )
      .run('a'.repeat(64));
    client
      .prepare(
        `INSERT INTO workflow_run_events (workflow_run_id, recorded_at, state, trigger)
         VALUES (?, '2026-08-16T00:00:00.000Z', 'waiting', 'launch')`,
      )
      .run(run.lastInsertRowid);

    for (const table of V1_WORKFLOW_TABLES) {
      assert.equal(
        tableExists(client, table),
        true,
        `Expected ${table} to exist before the upgrade.`,
      );
    }

    return readHistoricalRows(client, PRE_GRAPH_WORKFLOW_ADDED_COLUMNS);
  } finally {
    client.close();
  }
}

test('a fresh database initializes the whole retained model, not only the upgrade path', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-fresh-schema-'));
  const dataDirectory = makeTestDataDirectory(dataRoot);

  try {
    // No historical fixture: the full committed chain applied to an empty file, which is what a new
    // installation actually runs. An upgrade test alone would not catch a migration that only works
    // because an earlier one already created something.
    const database = RuntimeDatabaseLive.pipe(
      Layer.provide(Layer.succeed(DataDirectory, dataDirectory)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* RuntimeDatabase;
        return yield* db.use('test_open_fresh_database', (connection) =>
          connection.select().from(workflowRuns).all(),
        );
      }).pipe(Effect.provide(database)),
    );

    const inspect = new BetterSqlite(dataDirectory.paths.databasePath, { readonly: true });
    try {
      for (const table of V2_WORKFLOW_TABLES) {
        assert.equal(tableExists(inspect, table), true, `Expected ${table} in a fresh database.`);
      }
      assert.equal(tableExists(inspect, 'workflow_run_events'), false);
      assert.equal(hasColumn(inspect, 'surface_panes', 'creation_key'), true);
      assert.equal(hasColumn(inspect, 'agent_sessions', 'creation_key'), true);
      assert.equal(hasColumn(inspect, 'worktree_surfaces', 'creation_key'), true);

      // Both uniqueness rules `0011` introduces: one preparation per run, and a surface creation
      // key that cannot name two surfaces. Without them a re-entered keyed creation could produce a
      // second surface, and a run could carry two disagreeing placement decisions.
      assert.equal(indexExists(inspect, 'workflow_run_preparations_run_unique'), true);
      assert.equal(indexExists(inspect, 'worktree_surfaces_creation_key_unique'), true);

      // The slot constraints have to be present on a fresh install too, not only implied by the
      // schema module: they are what stops a row that is simultaneously inline and referenced.
      const frames = inspect
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_graph_frames'`,
        )
        .get() as { readonly sql: string };
      assert.match(frames.sql, /CONSTRAINT "workflow_graph_frames_state_slot"/);
      assert.deepEqual(inspect.pragma('foreign_key_check'), []);
    } finally {
      inspect.close();
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('the graph-workflow migration replaces the v1 store and keeps unrelated data', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-graph-workflow-migration-'));
  const dataDirectory = makeTestDataDirectory(dataRoot);

  try {
    const seeded = seedPreGraphWorkflowDatabase(
      dataDirectory.paths.databasePath,
      historicalMigrationsFolder(dataRoot, PRE_GRAPH_WORKFLOW_TAGS),
    );

    // The production layer, which runs the committed migrations users actually receive.
    const database = RuntimeDatabaseLive.pipe(
      Layer.provide(Layer.succeed(DataDirectory, dataDirectory)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* RuntimeDatabase;
        return yield* db.use('test_open_upgraded_database', (connection) =>
          connection.select().from(workflowRuns).all(),
        );
      }).pipe(Effect.provide(database)),
    );

    const inspect = new BetterSqlite(dataDirectory.paths.databasePath, { readonly: true });
    try {
      assert.equal(
        tableExists(inspect, 'workflow_run_events'),
        false,
        'The retired JSONL-era event table must be dropped, not carried forward.',
      );
      for (const table of V2_WORKFLOW_TABLES) {
        assert.equal(tableExists(inspect, table), true, `Expected ${table} after the upgrade.`);
      }
      // Dropped and recreated, so no v1 row can survive inside the new shape.
      assert.equal(
        (inspect.prepare('SELECT count(*) AS count FROM workflow_runs').get() as { count: number })
          .count,
        0,
      );
      assert.equal(hasColumn(inspect, 'surface_panes', 'creation_key'), true);
      assert.equal(hasColumn(inspect, 'agent_sessions', 'creation_key'), true);

      // Every unrelated historical row and column, unchanged.
      assert.deepEqual(readHistoricalRows(inspect, PRE_GRAPH_WORKFLOW_ADDED_COLUMNS), seeded);

      // Guards the comparison above against passing vacuously on empty tables.
      assert.equal(seeded.projects.length, SEEDED_PROJECTS.length);
      assert.equal(seeded.worktrees.length, SEEDED_WORKTREES.length);
      assert.equal(seeded.surface_panes.length, 1);
      assert.equal(seeded.agent_sessions.length, 1);
      assert.equal(seeded.pty_processes.length, 1);

      // Foreign keys still resolve after the rebuild, in both directions.
      assert.deepEqual(inspect.pragma('foreign_key_check'), []);
    } finally {
      inspect.close();
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

/**
 * Proves the project-kind migration (`0007`) upgrades a database created before
 * it existed. Same shape as the rail-order case above: build a genuine pre-kind
 * database from the committed artifacts, seed it with raw SQL, then open the
 * production database layer over the same file and let the real migration run.
 *
 * The seed keeps the worktree → surface → pane chain because every
 * worktree-dependent table cascades from `worktrees`. An additive
 * `ALTER TABLE projects ADD COLUMN` cannot touch those tables, so the failure
 * actually worth excluding is a `projects` rebuild that dropped and recreated
 * rows and took the cascade with it. That failure is visible here. Seeding the
 * session, command and workflow tables would re-prove the same cascade at much
 * greater cost, so this case deliberately stops at panes.
 */
const PRE_KIND_ADDED_COLUMNS = {
  projects: ['kind'],
  worktrees: [],
  // Both `creation_key` columns arrive later — panes in the graph-workflow migration, surfaces in
  // the preparation one. Listing them here keeps this case about the columns `0007` adds rather
  // than about every column added since.
  worktree_surfaces: ['creation_key'],
  surface_panes: ['creation_key'],
} as const satisfies Record<string, readonly string[]>;

function seedPreKindDatabase(databasePath: string, migrationsFolder: string) {
  const client = new BetterSqlite(databasePath);
  try {
    client.pragma('foreign_keys = ON');
    migrate(drizzle(client), { migrationsFolder });

    assert.equal(
      hasColumn(client, 'projects', 'kind'),
      false,
      'Expected the historical schema to predate projects.kind.',
    );

    // Deliberately non-default sort orders and distinct timestamps, so a rebuild
    // that restamped or re-ranked anything is visible rather than coincidental.
    const insertProject = client.prepare(
      `INSERT INTO projects (name, root_path, status, sort_order, created_at, updated_at, last_seen_at, missing_reason)
       VALUES (@name, @root_path, @status, @sort_order, @created_at, @updated_at, @last_seen_at, @missing_reason)`,
    );
    for (const [index, project] of SEEDED_PROJECTS.entries()) {
      insertProject.run({ ...project, sort_order: (SEEDED_PROJECTS.length - index) * 10 });
    }

    const insertWorktree = client.prepare(
      `INSERT INTO worktrees (project_id, path, branch, head, sort_order, created_at, updated_at, first_seen_at, last_seen_at)
       VALUES (@project_id, @path, @branch, @head, @sort_order, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
    );
    for (const [index, worktree] of SEEDED_WORKTREES.entries()) {
      insertWorktree.run({ ...worktree, sort_order: index * 5 });
    }

    const insertSurface = client.prepare(
      `INSERT INTO worktree_surfaces (worktree_id, title, layout_json, sort_order, created_at, updated_at)
       VALUES (@worktree_id, @title, '{}', @sort_order, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    for (const surface of SEEDED_SURFACES) insertSurface.run(surface);

    // The cascade tail: if a `projects` rebuild took its worktrees with it,
    // these vanish too.
    const insertPane = client.prepare(
      `INSERT INTO surface_panes (surface_id, title, sort_order, session_kind, session_id, created_at, updated_at)
       VALUES (@surface_id, @title, @sort_order, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    for (let index = 0; index < SEEDED_SURFACES.length; index += 1) {
      insertPane.run({ surface_id: index + 1, title: `pane-${index + 1}`, sort_order: index });
    }

    return readHistoricalRows(client, PRE_KIND_ADDED_COLUMNS);
  } finally {
    client.close();
  }
}

test('the project-kind migration upgrades a pre-kind database and backfills git', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-project-kind-migration-'));
  const dataDirectory = makeTestDataDirectory(dataRoot);

  try {
    const seeded = seedPreKindDatabase(
      dataDirectory.paths.databasePath,
      historicalMigrationsFolder(dataRoot, PRE_PROJECT_KIND_TAGS),
    );

    const database = RuntimeDatabaseLive.pipe(
      Layer.provide(Layer.succeed(DataDirectory, dataDirectory)),
    );
    const upgraded = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkspaceRepository;
        return {
          projects: yield* repository.listProjects,
          snapshot: buildWorkspaceSnapshot(
            yield* repository.listProjects,
            yield* repository.listWorktrees,
          ),
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(database, WorkspaceRepositoryLive.pipe(Layer.provide(database))),
        ),
      ),
    );

    // Every historical row and column, minus only `kind`, read back out of the
    // upgraded file. A rebuild that regenerated an id, restamped a timestamp, or
    // cascaded the worktree/surface/pane chain away fails here.
    const reopened = new BetterSqlite(dataDirectory.paths.databasePath, { readonly: true });
    try {
      assert.deepEqual(readHistoricalRows(reopened, PRE_KIND_ADDED_COLUMNS), seeded);
    } finally {
      reopened.close();
    }
    // Guards the comparison above against passing vacuously on empty tables.
    assert.equal(seeded.projects.length, SEEDED_PROJECTS.length);
    assert.equal(seeded.worktrees.length, SEEDED_WORKTREES.length);
    assert.equal(seeded.worktree_surfaces.length, SEEDED_SURFACES.length);
    assert.equal(seeded.surface_panes.length, SEEDED_SURFACES.length);

    // Historical rows have Git-validated provenance, so every one of them —
    // including the missing project, which is not reinterpreted as a folder —
    // comes back as `git`.
    assert.deepEqual(
      upgraded.projects.map((project) => [project.status, project.kind]),
      [
        ['present', 'git'],
        ['present', 'git'],
        ['missing', 'git'],
      ],
    );

    // The upgraded rows still compose a snapshot the shared contract accepts,
    // which is what the web will decode after this migration runs.
    assert.doesNotThrow(() => Schema.decodeUnknownSync(workspaceSnapshotSchema)(upgraded.snapshot));
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

/**
 * Proves the preparation migration (`0011`) upgrades a database created before it existed, and that
 * its clean-state reset deletes exactly what it claims to.
 *
 * Story #44 makes the run summary's `preparation` field non-nullable, and there is no honest way to
 * backfill it: a synthetic preparation row would record a provenance nobody ever observed. Only
 * developer databases exist, so the migration deletes every run instead. That makes the delete the
 * riskiest statement in the plan and the one whose failure is invisible — `DELETE FROM
 * workflow_runs` relies on `ON DELETE CASCADE`, which fires only while `foreign_keys` is ON, so a
 * delete landing inside a `PRAGMA foreign_keys=OFF` table-rebuild window would leave orphaned
 * frames, attempts, transitions and attachments behind rather than removing them. The row counts
 * and the `foreign_key_check` below are what turn that from a hope into a fact.
 *
 * The seed is a fully populated graph-era run — artifact, payload, run, frame, attempt, transition
 * and attachment — so the cascade is proven against real rows, not against empty tables. The
 * artifact and payload rows are the control: they are content-addressed retained records and must
 * survive, because nothing about them becomes inconsistent when a run disappears.
 */
test('the preparation migration resets runs, keeps content-addressed records and cascades cleanly', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-preparation-migration-'));
  const dataDirectory = makeTestDataDirectory(dataRoot);

  try {
    const seeded = seedPrePreparationDatabase(
      dataDirectory.paths.databasePath,
      historicalMigrationsFolder(dataRoot, PRE_PREPARATION_TAGS),
    );

    // The production layer, which runs the committed migrations users actually receive.
    const database = RuntimeDatabaseLive.pipe(
      Layer.provide(Layer.succeed(DataDirectory, dataDirectory)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* RuntimeDatabase;
        return yield* db.use('test_open_prepared_database', (connection) =>
          connection.select().from(workflowRuns).all(),
        );
      }).pipe(Effect.provide(database)),
    );

    const inspect = new BetterSqlite(dataDirectory.paths.databasePath, { readonly: true });
    try {
      const count = (table: string) =>
        (inspect.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
          .count;

      assert.equal(tableExists(inspect, 'workflow_run_preparations'), true);
      assert.equal(hasColumn(inspect, 'worktree_surfaces', 'creation_key'), true);
      assert.equal(indexExists(inspect, 'workflow_run_preparations_run_unique'), true);
      assert.equal(indexExists(inspect, 'worktree_surfaces_creation_key_unique'), true);

      // The clean-state reset, and the cascade it depends on. Every one of these tables held a row
      // before the upgrade, which is what the seed assertions below guard.
      assert.equal(count('workflow_runs'), 0);
      assert.equal(count('workflow_graph_frames'), 0);
      assert.equal(count('workflow_segment_attempts'), 0);
      assert.equal(count('workflow_transitions'), 0);
      assert.equal(count('workflow_run_attachments'), 0);

      // The control: content-addressed retained records are explicitly left in place.
      assert.equal(count('workflow_artifacts'), 1);
      assert.equal(count('workflow_payloads'), 1);
      assert.deepEqual(
        inspect.prepare('SELECT * FROM workflow_artifacts').all(),
        seeded.artifacts,
        'The artifact catalog must come back byte-identical, not merely non-empty.',
      );
      assert.deepEqual(inspect.prepare('SELECT * FROM workflow_payloads').all(), seeded.payloads);

      // Every unrelated historical row and column, unchanged.
      assert.deepEqual(readHistoricalRows(inspect, PRE_PREPARATION_ADDED_COLUMNS), seeded.rows);
      assert.equal(seeded.rows.projects.length, SEEDED_PROJECTS.length);
      assert.equal(seeded.rows.worktrees.length, SEEDED_WORKTREES.length);
      assert.equal(seeded.rows.worktree_surfaces.length, SEEDED_SURFACES.length);

      // No dangling reference survived the delete in either direction.
      assert.deepEqual(inspect.pragma('foreign_key_check'), []);
    } finally {
      inspect.close();
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

/** The migration set as it stood before author-selected evidence and operation provenance. */
const PRE_EVIDENCE_TAGS = [
  '0000_lazy_morbius',
  '0001_durable_workflow_artifact_pin',
  '0002_daily_thor_girl',
  '0003_peaceful_squirrel_girl',
  '0004_mixed_synch',
  '0005_tiny_jackal',
  '0006_stale_the_hood',
  '0007_light_supreme_intelligence',
  '0008_retire_v1_workflow_store',
  '0009_graph_workflow_records',
  '0010_workflow_transition_changes',
  '0011_workflow_run_preparations',
] as const;

/** `0012` adds only new tables and new nullable operation columns — no owner table gains one. */
const PRE_EVIDENCE_ADDED_COLUMNS = {
  projects: [],
  worktrees: [],
  worktree_surfaces: [],
  surface_panes: [],
  agent_sessions: [],
} as const satisfies Record<string, readonly string[]>;

/** The seven columns `0012` adds to `workflow_operations`, in the order it adds them. */
const ADDED_OPERATION_COLUMNS = [
  'harness',
  'model',
  'effort',
  'cwd',
  'runtime_id',
  'incarnation_id',
  'usage_json',
] as const;

/**
 * Builds a genuine pre-`0012` database holding a whole graph-era run *including an operation*.
 *
 * `0011` deletes every run as its clean-state reset, so the pre-preparation seed cannot serve here:
 * after that migration the database holds no runs and therefore no operations, and an operation row
 * is exactly what this case needs. The seed is modelled on `seedPreGraphWorkflowDatabase` rather
 * than driving repositories, so the whole file stays readable side by side when a migration
 * misbehaves.
 *
 * `workflow_operations` goes in through raw SQL because its current Drizzle model names the seven
 * columns the historical schema does not have yet; everything else matches the pre-`0012` shape
 * exactly and goes in through Drizzle, as the pre-preparation seed does.
 */
function seedPreEvidenceDatabase(databasePath: string, migrationsFolder: string) {
  const client = new BetterSqlite(databasePath);
  try {
    client.pragma('foreign_keys = ON');
    migrate(drizzle(client), { migrationsFolder });

    assert.equal(
      tableExists(client, 'workflow_evidence'),
      false,
      'Expected the historical schema to predate workflow_evidence.',
    );
    assert.equal(
      tableExists(client, 'runtime_identity'),
      false,
      'Expected the historical schema to predate runtime_identity.',
    );
    for (const column of ADDED_OPERATION_COLUMNS) {
      assert.equal(
        hasColumn(client, 'workflow_operations', column),
        false,
        `Expected the historical schema to predate workflow_operations.${column}.`,
      );
    }

    const insertProject = client.prepare(
      `INSERT INTO projects (name, root_path, kind, status, sort_order, created_at, updated_at, last_seen_at, missing_reason)
       VALUES (@name, @root_path, 'git', @status, @sort_order, @created_at, @updated_at, @last_seen_at, @missing_reason)`,
    );
    for (const [index, project] of SEEDED_PROJECTS.entries()) {
      insertProject.run({ ...project, sort_order: (SEEDED_PROJECTS.length - index) * 10 });
    }

    const insertWorktree = client.prepare(
      `INSERT INTO worktrees (project_id, path, branch, head, sort_order, created_at, updated_at, first_seen_at, last_seen_at)
       VALUES (@project_id, @path, @branch, @head, @sort_order, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
    );
    for (const [index, worktree] of SEEDED_WORKTREES.entries()) {
      insertWorktree.run({ ...worktree, sort_order: index * 5 });
    }

    const insertSurface = client.prepare(
      `INSERT INTO worktree_surfaces (worktree_id, title, layout_json, sort_order, creation_key, created_at, updated_at)
       VALUES (@worktree_id, @title, '{}', @sort_order, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    for (const surface of SEEDED_SURFACES) insertSurface.run(surface);

    const at = '2026-09-10T00:00:00.000Z';
    const artifactHash = 'c'.repeat(64);
    const db = drizzle(client);

    db.insert(workflowPayloads)
      .values({
        payloadRef: 'sha256:' + 'd'.repeat(64),
        byteSize: 12,
        mediaType: 'application/json',
        createdAt: at,
      })
      .run();

    db.insert(workflowArtifacts)
      .values({
        artifactHash,
        workflowKey: 'demo',
        contractVersion: 3,
        manifestVersion: 1,
        descriptorVersion: 1,
        sdkVersion: '0.2.0',
        verifierVersion: '0.2.0',
        sourceHash: 'e'.repeat(64),
        structureHash: 'f'.repeat(64),
        rootGraphKey: 'root',
        descriptorInline: '{}',
        descriptorRef: null,
        firstSeenAt: at,
      })
      .run();

    const run = db
      .insert(workflowRuns)
      .values({
        workflowKey: 'demo',
        title: 'Demo run',
        rootGraphKey: 'root',
        artifactHash,
        status: 'ready',
        positionJson: JSON.stringify({ kind: 'graph_entry', frameId: 1 }),
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: workflowRuns.id })
      .all()[0]!;

    const frame = db
      .insert(workflowGraphFrames)
      .values({
        runId: run.id,
        graphKey: 'root',
        entryArtifactHash: artifactHash,
        depth: 0,
        status: 'active',
        enteredAt: at,
      })
      .returning({ id: workflowGraphFrames.id })
      .all()[0]!;

    const execution = db
      .insert(workflowNodeExecutions)
      .values({
        runId: run.id,
        frameId: frame.id,
        nodeId: 'work',
        nodeKind: 'operation',
        visitIndex: 0,
        status: 'running',
        startedAt: at,
        endCertainty: 'unknown',
      })
      .returning({ id: workflowNodeExecutions.id })
      .all()[0]!;

    const attempt = db
      .insert(workflowSegmentAttempts)
      .values({
        runId: run.id,
        frameId: frame.id,
        executionId: execution.id,
        segmentKind: 'node_callback',
        attemptIndex: 0,
        artifactHash,
        status: 'running',
        invocationKind: 'initial',
        startedAt: at,
        endCertainty: 'unknown',
      })
      .returning({ id: workflowSegmentAttempts.id })
      .all()[0]!;

    client
      .prepare(
        `INSERT INTO workflow_operations (
           operation_key, run_id, frame_id, execution_id, origin_attempt_id, capability, call_index,
           request_fingerprint, request_inline, artifact_hash, state, target_kind, attribution,
           stop_state, created_at
         ) VALUES ('wop_legacy', ?, ?, ?, ?, 'run_headless_agent', 0, ?, '{"prompt":"judge"}', ?,
                   'completed', 'pty_process', 'not_applicable', 'not_requested', ?)`,
      )
      .run(run.id, frame.id, execution.id, attempt.id, 'b'.repeat(64), artifactHash, at);

    db.insert(workflowTransitions)
      .values({ runId: run.id, revision: 1, recordedAt: at, kind: 'run_started' })
      .run();

    db.insert(workflowRunAttachments)
      .values({ runId: run.id, worktreeId: 1, surfaceId: 1, attachedAt: at })
      .run();

    // Without this the post-migration assertions could pass on a database that never held a run.
    for (const table of [
      'workflow_runs',
      'workflow_graph_frames',
      'workflow_node_executions',
      'workflow_segment_attempts',
      'workflow_operations',
      'workflow_payloads',
    ]) {
      assert.equal(
        (client.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
        1,
        `Expected the seed to populate ${table} before the upgrade.`,
      );
    }

    return {
      rows: readHistoricalRows(client, PRE_EVIDENCE_ADDED_COLUMNS),
      operations: client.prepare('SELECT * FROM workflow_operations').all(),
      payloads: client.prepare('SELECT * FROM workflow_payloads').all(),
    };
  } finally {
    client.close();
  }
}

/**
 * Proves the evidence migration (`0012`) upgrades a database created before it existed.
 *
 * The load-bearing assertion is the one about pre-existing operations. Criterion 6 asks for
 * provenance on every relevant operation *and* for unknowns to be explicit; an operation recorded
 * before these columns existed has no provenance and never will, so the only honest thing the
 * migration can leave behind is `NULL` in all seven — not a backfilled guess, and not a default
 * that would read as a real value. Reading them back individually is what turns that from a claim
 * about the generated SQL into a fact about a real upgraded database.
 *
 * `workflow_payloads` is the control: this migration must not touch it at all, which is also what
 * keeps the byte-identity assertions in the older cases above true.
 */
test('the evidence migration adds its tables and leaves historical operations explicitly unknown', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-evidence-migration-'));
  const dataDirectory = makeTestDataDirectory(dataRoot);

  try {
    const seeded = seedPreEvidenceDatabase(
      dataDirectory.paths.databasePath,
      historicalMigrationsFolder(dataRoot, PRE_EVIDENCE_TAGS),
    );

    // The production layer, which runs the committed migrations users actually receive.
    const database = RuntimeDatabaseLive.pipe(
      Layer.provide(Layer.succeed(DataDirectory, dataDirectory)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* RuntimeDatabase;
        return yield* db.use('test_open_evidence_database', (connection) =>
          connection.select().from(workflowRuns).all(),
        );
      }).pipe(Effect.provide(database)),
    );

    const inspect = new BetterSqlite(dataDirectory.paths.databasePath, { readonly: true });
    try {
      // The three DDL results.
      assert.equal(tableExists(inspect, 'workflow_evidence'), true);
      assert.equal(tableExists(inspect, 'runtime_identity'), true);
      for (const column of ADDED_OPERATION_COLUMNS) {
        assert.equal(
          hasColumn(inspect, 'workflow_operations', column),
          true,
          `Expected workflow_operations.${column} after the upgrade.`,
        );
      }
      assert.equal(indexExists(inspect, 'workflow_evidence_key_unique'), true);
      // One capture call position holds at most one evidence row, enforced by the database rather
      // than by the code that writes it.
      assert.equal(indexExists(inspect, 'workflow_evidence_operation_unique'), true);
      assert.equal(indexExists(inspect, 'workflow_evidence_run_idx'), true);
      assert.equal(indexExists(inspect, 'workflow_evidence_execution_idx'), true);
      assert.equal(indexExists(inspect, 'workflow_evidence_run_role_idx'), true);
      assert.equal(indexExists(inspect, 'workflow_evidence_source_operation_idx'), true);
      assert.equal(indexExists(inspect, 'runtime_identity_runtime_id_unique'), true);

      // Nothing is created by the migration: the identity row is the service's to insert at
      // startup, because Drizzle Kit emits DDL only.
      assert.equal(
        (
          inspect.prepare('SELECT count(*) AS count FROM runtime_identity').get() as {
            count: number;
          }
        ).count,
        0,
      );

      // The run survived — `0012` has no clean-state reset — and its operation reads back with
      // every pre-existing column untouched and every new column explicitly unknown.
      const upgraded = inspect.prepare('SELECT * FROM workflow_operations').all() as Record<
        string,
        unknown
      >[];
      assert.equal(upgraded.length, 1);
      const operation = upgraded[0]!;
      for (const column of ADDED_OPERATION_COLUMNS) {
        assert.equal(
          operation[column],
          null,
          `A pre-existing operation must read ${column} as an explicit NULL, never a backfilled value.`,
        );
      }
      const before = seeded.operations[0] as Record<string, unknown>;
      for (const [column, value] of Object.entries(before)) {
        assert.deepEqual(
          operation[column],
          value,
          `The upgrade must not disturb workflow_operations.${column}.`,
        );
      }

      // The control: this migration does not touch payload storage.
      assert.deepEqual(inspect.prepare('SELECT * FROM workflow_payloads').all(), seeded.payloads);

      // Every unrelated historical row and column, unchanged.
      assert.deepEqual(readHistoricalRows(inspect, PRE_EVIDENCE_ADDED_COLUMNS), seeded.rows);

      // No dangling reference in either direction, which is what the new foreign keys could break.
      assert.deepEqual(inspect.pragma('foreign_key_check'), []);
    } finally {
      inspect.close();
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

/** The migration set as it stood before checkpoints. */
const PRE_CHECKPOINT_TAGS = [...PRE_EVIDENCE_TAGS, '0012_glossy_baron_zemo'] as const;

/** `0013` adds only two new tables — no existing table gains a column. */
const PRE_CHECKPOINT_ADDED_COLUMNS = {
  projects: [],
  worktrees: [],
  worktree_surfaces: [],
  workflow_runs: [],
  workflow_graph_frames: [],
  workflow_node_executions: [],
  workflow_segment_attempts: [],
  workflow_evidence: [],
} as const satisfies Record<string, readonly string[]>;

/**
 * Proves the checkpoint migration (`0013`) upgrades a database created before it existed: it adds
 * its two tables, their indexes and their representation constraints, and touches nothing else.
 */
test('the checkpoint migration adds its tables and leaves every historical row untouched', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-checkpoint-migration-'));
  const dataDirectory = makeTestDataDirectory(dataRoot);

  try {
    const client = new BetterSqlite(dataDirectory.paths.databasePath);
    let before: ReturnType<typeof readHistoricalRows<keyof typeof PRE_CHECKPOINT_ADDED_COLUMNS>>;
    try {
      client.pragma('foreign_keys = ON');
      migrate(drizzle(client), {
        migrationsFolder: historicalMigrationsFolder(dataRoot, PRE_CHECKPOINT_TAGS),
      });
      assert.equal(tableExists(client, 'workflow_checkpoints'), false);
      assert.equal(tableExists(client, 'workflow_checkpoint_entries'), false);

      const at = '2026-09-23T00:00:00.000Z';
      const artifactHash = 'c'.repeat(64);
      const db = drizzle(client);
      db.insert(workflowArtifacts)
        .values({
          artifactHash,
          workflowKey: 'demo',
          contractVersion: 3,
          manifestVersion: 1,
          descriptorVersion: 1,
          sdkVersion: '0.3.0',
          verifierVersion: '0.3.0',
          sourceHash: 'e'.repeat(64),
          structureHash: 'f'.repeat(64),
          rootGraphKey: 'root',
          descriptorInline: '{}',
          descriptorRef: null,
          firstSeenAt: at,
        })
        .run();
      const run = db
        .insert(workflowRuns)
        .values({
          workflowKey: 'demo',
          title: 'Demo run',
          rootGraphKey: 'root',
          artifactHash,
          status: 'ready',
          positionJson: JSON.stringify({ kind: 'graph_entry', frameId: 1 }),
          createdAt: at,
          updatedAt: at,
        })
        .returning({ id: workflowRuns.id })
        .get();
      db.insert(workflowGraphFrames)
        .values({
          runId: run.id,
          graphKey: 'root',
          entryArtifactHash: artifactHash,
          depth: 0,
          status: 'active',
          enteredAt: at,
        })
        .run();
      before = readHistoricalRows(client, PRE_CHECKPOINT_ADDED_COLUMNS);
      assert.equal(before.workflow_runs.length, 1);
    } finally {
      client.close();
    }

    const database = RuntimeDatabaseLive.pipe(
      Layer.provide(Layer.succeed(DataDirectory, dataDirectory)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* RuntimeDatabase;
        return yield* db.use('test_open_checkpoint_database', (connection) =>
          connection.select().from(workflowRuns).all(),
        );
      }).pipe(Effect.provide(database)),
    );

    const inspect = new BetterSqlite(dataDirectory.paths.databasePath, { readonly: true });
    try {
      assert.equal(tableExists(inspect, 'workflow_checkpoints'), true);
      assert.equal(tableExists(inspect, 'workflow_checkpoint_entries'), true);
      for (const index of [
        'workflow_checkpoints_key_unique',
        // One checkpoint per visit, enforced by the database rather than the code that writes it.
        'workflow_checkpoints_execution_unique',
        'workflow_checkpoints_run_idx',
        'workflow_checkpoint_entries_seq_unique',
        'workflow_checkpoint_entries_file_key_unique',
        'workflow_checkpoint_entries_kind_idx',
      ]) {
        assert.equal(indexExists(inspect, index), true, `Expected index ${index}.`);
      }
      const ddl = (table: string) =>
        (
          inspect
            .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
            .get(table) as { readonly sql: string }
        ).sql;
      assert.match(ddl('workflow_checkpoints'), /CONSTRAINT "workflow_checkpoints_base_shape"/);
      assert.match(
        ddl('workflow_checkpoint_entries'),
        /CONSTRAINT "workflow_checkpoint_entries_kind_shape"/,
      );
      assert.match(
        ddl('workflow_checkpoint_entries'),
        /CONSTRAINT "workflow_checkpoint_entries_file_key_files_only"/,
      );
      assert.deepEqual(readHistoricalRows(inspect, PRE_CHECKPOINT_ADDED_COLUMNS), before);
      assert.deepEqual(inspect.pragma('foreign_key_check'), []);
    } finally {
      inspect.close();
    }
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
