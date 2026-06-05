import { and, eq, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import { projects, worktrees } from '../persistence/schema.js';
import type { DiscoveredWorktree, ProjectRow, WorktreeRow } from './types.js';

type ProjectRecord = InferSelectModel<typeof projects>;
type WorktreeRecord = InferSelectModel<typeof worktrees>;

export interface WorkspaceRepositoryService {
  readonly findProjectByRootPath: (
    rootPath: string,
  ) => Effect.Effect<ProjectRow | null, DatabaseError>;
  readonly findWorktree: (worktreeId: number) => Effect.Effect<WorktreeRow | null, DatabaseError>;
  readonly insertProject: (input: {
    readonly name: string;
    readonly rootPath: string;
  }) => Effect.Effect<number, DatabaseError>;
  readonly listProjects: Effect.Effect<ProjectRow[], DatabaseError>;
  readonly listWorktrees: Effect.Effect<WorktreeRow[], DatabaseError>;
  readonly reconcileProjectWorktrees: (input: {
    readonly projectId: number;
    readonly discovered: readonly DiscoveredWorktree[];
  }) => Effect.Effect<void, DatabaseError>;
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
          .orderBy(worktrees.projectId, worktrees.isRoot, worktrees.id)
          .all()
          .map(worktreeRow),
      ),
      reconcileProjectWorktrees: (input) =>
        database.transaction('reconcile_project_worktrees', (db) => {
          const now = timestamp();
          const discoveredPaths = new Set(input.discovered.map((worktree) => worktree.path));

          for (const worktree of input.discovered) {
            const existing =
              db
                .select()
                .from(worktrees)
                .where(
                  and(eq(worktrees.projectId, input.projectId), eq(worktrees.path, worktree.path)),
                )
                .get() ?? null;

            if (existing) {
              db.update(worktrees)
                .set({
                  branch: worktree.branch,
                  head: worktree.head,
                  isRoot: worktree.isRoot ? 1 : 0,
                  status: 'present',
                  updatedAt: now,
                  lastSeenAt: now,
                })
                .where(eq(worktrees.id, existing.id))
                .run();
            } else {
              db.insert(worktrees)
                .values({
                  projectId: input.projectId,
                  path: worktree.path,
                  branch: worktree.branch,
                  head: worktree.head,
                  isRoot: worktree.isRoot ? 1 : 0,
                  status: 'present',
                  createdAt: now,
                  updatedAt: now,
                  firstSeenAt: now,
                  lastSeenAt: now,
                })
                .run();
            }
          }

          const existingWorktrees = db
            .select()
            .from(worktrees)
            .where(eq(worktrees.projectId, input.projectId))
            .all();

          for (const existing of existingWorktrees) {
            if (!discoveredPaths.has(existing.path) && existing.status !== 'gone') {
              db.update(worktrees)
                .set({ status: 'gone', updatedAt: now })
                .where(eq(worktrees.id, existing.id))
                .run();
            }
          }
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
    isRoot: row.isRoot,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function timestamp() {
  return new Date().toISOString();
}
