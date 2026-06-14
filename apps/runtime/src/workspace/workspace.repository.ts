import { and, eq, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDatabaseService,
} from '../persistence/index.js';
import { projects, worktrees } from '../persistence/schema.js';
import type { DiscoveredWorktree, ProjectRow, WorktreeRow } from './types.js';

type ProjectRecord = InferSelectModel<typeof projects>;
type WorktreeRecord = InferSelectModel<typeof worktrees>;

type ReconciledWorktreeSummary = Pick<WorktreeRow, 'id' | 'path' | 'branch'>;

export interface WorkspaceReconcileProjectWorktreesResult {
  readonly added: readonly ReconciledWorktreeSummary[];
  readonly missing: readonly ReconciledWorktreeSummary[];
}

export interface WorkspaceRepositoryService {
  readonly findProject: (projectId: number) => Effect.Effect<ProjectRow | null, DatabaseError>;
  readonly findProjectByRootPath: (
    rootPath: string,
  ) => Effect.Effect<ProjectRow | null, DatabaseError>;
  readonly findWorktree: (worktreeId: number) => Effect.Effect<WorktreeRow | null, DatabaseError>;
  readonly findProjectWorktree: (input: {
    readonly projectId: number;
    readonly worktreeId: number;
  }) => Effect.Effect<WorktreeRow | null, DatabaseError>;
  readonly findProjectRootWorktree: (input: {
    readonly projectId: number;
    readonly rootPath: string;
  }) => Effect.Effect<WorktreeRow | null, DatabaseError>;
  readonly findProjectWorktreeByBranch: (input: {
    readonly projectId: number;
    readonly branch: string;
  }) => Effect.Effect<WorktreeRow | null, DatabaseError>;
  readonly deleteProject: (projectId: number) => Effect.Effect<boolean, DatabaseError>;
  readonly deleteWorktree: (worktreeId: number) => Effect.Effect<boolean, DatabaseError>;
  readonly insertProject: (input: {
    readonly name: string;
    readonly rootPath: string;
  }) => Effect.Effect<number, DatabaseError>;
  readonly listProjects: Effect.Effect<ProjectRow[], DatabaseError>;
  readonly listWorktrees: Effect.Effect<WorktreeRow[], DatabaseError>;
  readonly reconcileProjectWorktrees: (input: {
    readonly projectId: number;
    readonly discovered: readonly DiscoveredWorktree[];
  }) => Effect.Effect<WorkspaceReconcileProjectWorktreesResult, DatabaseError>;
  readonly restoreProjectAtRootPath: (input: {
    readonly discovered: readonly DiscoveredWorktree[];
    readonly projectId: number;
    readonly rootPath: string;
  }) => Effect.Effect<WorkspaceReconcileProjectWorktreesResult, DatabaseError>;
  readonly setProjectStatus: (input: {
    readonly id: number;
    readonly missingReason?: string | undefined;
    readonly status: 'present' | 'missing';
  }) => Effect.Effect<void, DatabaseError>;
}

export const WorkspaceRepository = Context.GenericTag<WorkspaceRepositoryService>(
  'isagi/WorkspaceRepository',
);

export const WorkspaceRepositoryLive = Layer.effect(
  WorkspaceRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;

    return {
      findProject: (projectId) =>
        database.use<ProjectRow | null>('find_project', (db) => {
          const row = db.select().from(projects).where(eq(projects.id, projectId)).get();
          return row ? projectRow(row) : null;
        }),
      findProjectByRootPath: (rootPath) =>
        database.use<ProjectRow | null>('find_project_by_root_path', (db) => {
          const row = db.select().from(projects).where(eq(projects.rootPath, rootPath)).get();
          return row ? projectRow(row) : null;
        }),
      findWorktree: (worktreeId) =>
        database.use<WorktreeRow | null>('find_worktree', (db) => {
          const row = db.select().from(worktrees).where(eq(worktrees.id, worktreeId)).get();
          return row ? worktreeRow(row) : null;
        }),
      findProjectWorktree: (input) =>
        database.use<WorktreeRow | null>('find_project_worktree', (db) => {
          const row = db
            .select()
            .from(worktrees)
            .where(
              and(eq(worktrees.projectId, input.projectId), eq(worktrees.id, input.worktreeId)),
            )
            .get();
          return row ? worktreeRow(row) : null;
        }),
      findProjectRootWorktree: (input) =>
        database.use<WorktreeRow | null>('find_project_root_worktree', (db) => {
          const row = db
            .select()
            .from(worktrees)
            .where(
              and(eq(worktrees.projectId, input.projectId), eq(worktrees.path, input.rootPath)),
            )
            .get();
          return row ? worktreeRow(row) : null;
        }),
      findProjectWorktreeByBranch: (input) =>
        database.use<WorktreeRow | null>('find_project_worktree_by_branch', (db) => {
          const row = db
            .select()
            .from(worktrees)
            .where(
              and(eq(worktrees.projectId, input.projectId), eq(worktrees.branch, input.branch)),
            )
            .get();
          return row ? worktreeRow(row) : null;
        }),
      deleteProject: (projectId) =>
        database.use('delete_project', (db) => {
          const result = db.delete(projects).where(eq(projects.id, projectId)).run();
          return result.changes > 0;
        }),
      deleteWorktree: (worktreeId) =>
        database.use('delete_worktree', (db) => {
          const result = db.delete(worktrees).where(eq(worktrees.id, worktreeId)).run();
          return result.changes > 0;
        }),
      insertProject: (input) =>
        database.use('insert_project', (db) => {
          const now = timestamp();
          const row = db
            .insert(projects)
            .values({
              name: input.name,
              rootPath: input.rootPath,
              status: 'present',
              createdAt: now,
              updatedAt: now,
              lastSeenAt: now,
              missingReason: null,
            })
            .returning({ id: projects.id })
            .get();
          return row.id;
        }),
      listProjects: database.use<ProjectRow[]>('list_projects', (db) =>
        db.select().from(projects).orderBy(projects.id).all().map(projectRow),
      ),
      listWorktrees: database.use<WorktreeRow[]>('list_worktrees', (db) =>
        db
          .select()
          .from(worktrees)
          .orderBy(worktrees.projectId, worktrees.id)
          .all()
          .map(worktreeRow),
      ),
      reconcileProjectWorktrees: (input) =>
        database.transaction('reconcile_project_worktrees', (db) =>
          reconcileProjectWorktreesInTransaction(db, input),
        ),
      restoreProjectAtRootPath: (input) =>
        database.transaction('restore_project_at_root_path', (db) => {
          const now = timestamp();
          db.update(projects)
            .set({
              rootPath: input.rootPath,
              status: 'present',
              updatedAt: now,
              lastSeenAt: now,
              missingReason: null,
            })
            .where(eq(projects.id, input.projectId))
            .run();

          return reconcileProjectWorktreesInTransaction(db, input);
        }),
      setProjectStatus: (input) =>
        database.use('set_project_status', (db) => {
          const now = timestamp();
          db.update(projects)
            .set({
              status: input.status,
              updatedAt: now,
              lastSeenAt: input.status === 'present' ? now : null,
              missingReason: input.status === 'missing' ? (input.missingReason ?? null) : null,
            })
            .where(eq(projects.id, input.id))
            .run();
        }),
    } satisfies WorkspaceRepositoryService;
  }),
);

function reconcileProjectWorktreesInTransaction(
  db: RuntimeDatabaseConnection,
  input: {
    readonly projectId: number;
    readonly discovered: readonly DiscoveredWorktree[];
  },
) {
  const now = timestamp();
  const added: ReconciledWorktreeSummary[] = [];

  for (const worktree of input.discovered) {
    const existing =
      db
        .select()
        .from(worktrees)
        .where(and(eq(worktrees.projectId, input.projectId), eq(worktrees.path, worktree.path)))
        .get() ?? null;

    if (existing) {
      db.update(worktrees)
        .set({
          branch: worktree.branch,
          head: worktree.head,
          updatedAt: now,
          lastSeenAt: now,
        })
        .where(eq(worktrees.id, existing.id))
        .run();
    } else {
      const inserted = db
        .insert(worktrees)
        .values({
          projectId: input.projectId,
          path: worktree.path,
          branch: worktree.branch,
          head: worktree.head,
          createdAt: now,
          updatedAt: now,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .returning({ id: worktrees.id, path: worktrees.path, branch: worktrees.branch })
        .get();
      added.push(inserted);
    }
  }

  const existingWorktrees = db
    .select()
    .from(worktrees)
    .where(eq(worktrees.projectId, input.projectId))
    .all();

  const missing = prunedWorktreeIds({
    discovered: input.discovered,
    existing: existingWorktrees,
  })
    .map((id) => existingWorktrees.find((worktree) => worktree.id === id))
    .filter((worktree): worktree is WorktreeRecord => Boolean(worktree))
    .map((worktree) => ({ id: worktree.id, path: worktree.path, branch: worktree.branch }));

  for (const worktree of missing) {
    db.delete(worktrees).where(eq(worktrees.id, worktree.id)).run();
  }

  return { added, missing } satisfies WorkspaceReconcileProjectWorktreesResult;
}

export function prunedWorktreeIds(input: {
  readonly discovered: readonly Pick<DiscoveredWorktree, 'path'>[];
  readonly existing: readonly Pick<WorktreeRow, 'id' | 'path'>[];
}): readonly number[] {
  const discoveredPaths = new Set(input.discovered.map((worktree) => worktree.path));
  return input.existing
    .filter((worktree) => !discoveredPaths.has(worktree.path))
    .map((worktree) => worktree.id);
}

function projectRow(row: ProjectRecord): ProjectRow {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastSeenAt: row.lastSeenAt,
    missingReason: row.missingReason,
  };
}

function worktreeRow(row: WorktreeRecord): WorktreeRow {
  return {
    id: row.id,
    projectId: row.projectId,
    path: row.path,
    branch: row.branch,
    head: row.head,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function timestamp() {
  return new Date().toISOString();
}

type RuntimeDatabaseConnection = Parameters<
  Parameters<RuntimeDatabaseService['transaction']>[1]
>[0];
