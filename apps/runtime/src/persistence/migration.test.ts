import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import BetterSqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Effect, Layer } from 'effect';

import { WorkspaceRepository, WorkspaceRepositoryLive } from '../workspace/workspace.repository.js';
import { buildWorkspaceSnapshot } from '../workspace/workspace.snapshot.js';
import { DataDirectory } from './data-directory.service.js';
import { RuntimeDatabase, RuntimeDatabaseLive } from './database.service.js';
import { migrationsDirectory } from './migrations.js';
import { projects, worktrees } from './schema.js';
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
function historicalMigrationsFolder(root: string) {
  const source = migrationsDirectory();
  const folder = join(root, 'migrations');
  mkdirSync(join(folder, 'meta'), { recursive: true });

  for (const tag of HISTORICAL_TAGS) {
    copyFileSync(join(source, `${tag}.sql`), join(folder, `${tag}.sql`));
  }

  const journal = JSON.parse(readFileSync(join(source, 'meta/_journal.json'), 'utf8')) as Journal;
  const entries = journal.entries.filter((entry) =>
    HISTORICAL_TAGS.includes(entry.tag as (typeof HISTORICAL_TAGS)[number]),
  );
  assert.equal(
    entries.length,
    HISTORICAL_TAGS.length,
    'Expected the committed journal to still contain the pre-0002 migrations.',
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
 * columns `0002` adds. Everything not listed here has to come back unchanged —
 * note that `worktree_surfaces.sort_order` predates `0002` and so is *not*
 * excused from the comparison.
 */
const ADDED_COLUMNS = {
  projects: ['sort_order'],
  worktrees: ['sort_order'],
  worktree_surfaces: [],
} as const satisfies Record<string, readonly string[]>;

type PreservedTable = keyof typeof ADDED_COLUMNS;
type RawRow = Record<string, unknown>;

/**
 * Reads every column of every row, dropping the columns the migration adds so
 * the same shape is comparable on both sides of the upgrade.
 */
function readHistoricalRows(client: BetterSqlite.Database) {
  const snapshot = {} as Record<PreservedTable, RawRow[]>;
  for (const table of Object.keys(ADDED_COLUMNS) as PreservedTable[]) {
    const added: readonly string[] = ADDED_COLUMNS[table];
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

    return readHistoricalRows(client);
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
      assert.deepEqual(readHistoricalRows(reopened), seeded);
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
