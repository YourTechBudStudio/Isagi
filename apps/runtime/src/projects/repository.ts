import { and, eq, max, ne, sql, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type {
  ProjectKind,
  ProjectOrderRejectionReason,
  WorktreeOrderRejectionReason,
} from '@isagi/contracts';

import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDrizzleDatabase,
  compactedRankChanges,
  moveBefore,
} from '../platform/persistence/index.js';
import { projects, worktrees } from './tables.js';
import type { DiscoveredWorktree, ProjectRow, WorktreeRow } from './types.js';

type ProjectRecord = InferSelectModel<typeof projects>;
type WorktreeRecord = InferSelectModel<typeof worktrees>;

type ReconciledWorktreeSummary = Pick<WorktreeRow, 'id' | 'path' | 'branch'>;

export interface WorkspaceReconcileProjectWorktreesResult {
  readonly added: readonly ReconciledWorktreeSummary[];
  readonly missing: readonly ReconciledWorktreeSummary[];
}

/**
 * Reorder outcomes are returned as values, never thrown: a plain throw inside
 * `database.transaction` becomes a `DatabaseError`, which would report an
 * expected rejection as a runtime fault. A rejection writes nothing, so it needs
 * no rollback. The workspace service converts it into its tagged domain error.
 */
export type ProjectOrderMoveResult =
  | { readonly status: 'moved' }
  | { readonly status: 'rejected'; readonly reason: ProjectOrderRejectionReason };

export type WorktreeOrderMoveResult =
  | { readonly status: 'moved' }
  | { readonly status: 'rejected'; readonly reason: WorktreeOrderRejectionReason };

const make = Effect.gen(function* () {
  const database = yield* RuntimeDatabase;

  return ProjectRepository.of({
    findProject: Effect.fn('ProjectRepository.findProject')(function* (projectId) {
      return yield* database.use<ProjectRow | null>('find_project', (db) => {
        const row = db.select().from(projects).where(eq(projects.id, projectId)).get();
        return row ? projectRow(row) : null;
      });
    }),
    findProjectByRootPath: Effect.fn('ProjectRepository.findProjectByRootPath')(
      function* (rootPath) {
        return yield* database.use<ProjectRow | null>('find_project_by_root_path', (db) => {
          const row = db.select().from(projects).where(eq(projects.rootPath, rootPath)).get();
          return row ? projectRow(row) : null;
        });
      },
    ),
    findWorktree: Effect.fn('ProjectRepository.findWorktree')(function* (worktreeId) {
      return yield* database.use<WorktreeRow | null>('find_worktree', (db) => {
        const row = db.select().from(worktrees).where(eq(worktrees.id, worktreeId)).get();
        return row ? worktreeRow(row) : null;
      });
    }),
    findProjectWorktree: Effect.fn('ProjectRepository.findProjectWorktree')(function* (input) {
      return yield* database.use<WorktreeRow | null>('find_project_worktree', (db) => {
        const row = db
          .select()
          .from(worktrees)
          .where(and(eq(worktrees.projectId, input.projectId), eq(worktrees.id, input.worktreeId)))
          .get();
        return row ? worktreeRow(row) : null;
      });
    }),
    findProjectRootWorktree: Effect.fn('ProjectRepository.findProjectRootWorktree')(
      function* (input) {
        return yield* database.use<WorktreeRow | null>('find_project_root_worktree', (db) => {
          const row = db
            .select()
            .from(worktrees)
            .where(
              and(eq(worktrees.projectId, input.projectId), eq(worktrees.path, input.rootPath)),
            )
            .get();
          return row ? worktreeRow(row) : null;
        });
      },
    ),
    findProjectWorktreeByBranch: Effect.fn('ProjectRepository.findProjectWorktreeByBranch')(
      function* (input) {
        return yield* database.use<WorktreeRow | null>('find_project_worktree_by_branch', (db) => {
          const row = db
            .select()
            .from(worktrees)
            .where(
              and(eq(worktrees.projectId, input.projectId), eq(worktrees.branch, input.branch)),
            )
            .get();
          return row ? worktreeRow(row) : null;
        });
      },
    ),
    findProjectWorktreeByPath: Effect.fn('ProjectRepository.findProjectWorktreeByPath')(
      function* (input) {
        return yield* database.use<WorktreeRow | null>('find_project_worktree_by_path', (db) => {
          const row = db
            .select()
            .from(worktrees)
            .where(and(eq(worktrees.projectId, input.projectId), eq(worktrees.path, input.path)))
            .get();
          return row ? worktreeRow(row) : null;
        });
      },
    ),
    deleteProject: Effect.fn('ProjectRepository.deleteProject')(
      function* (projectId, inTransaction) {
        return yield* database.transaction('delete_project', (db) => {
          inTransaction(db);
          const result = db.delete(projects).where(eq(projects.id, projectId)).run();
          return result.changes > 0;
        });
      },
    ),
    deleteWorktree: Effect.fn('ProjectRepository.deleteWorktree')(function* (worktreeId) {
      return yield* database.use('delete_worktree', (db) => {
        const result = db.delete(worktrees).where(eq(worktrees.id, worktreeId)).run();
        return result.changes > 0;
      });
    }),
    createProject: Effect.fn('ProjectRepository.createProject')(function* (input) {
      // One transaction for the whole registration unit: the appended rank is
      // read from the same present-project set the insert then joins, and a
      // folder project's sole environment is created with it. The transaction
      // is what makes this atomic — a successful registration can therefore
      // never expose a folder project with no environment.
      return yield* database.transaction('create_project', (db) => {
        const now = timestamp();
        const row = db
          .insert(projects)
          .values({
            name: input.name,
            rootPath: input.rootPath,
            kind: input.kind,
            status: 'present',
            sortOrder: nextPresentProjectOrder(db),
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
            missingReason: null,
          })
          .returning()
          .get();

        if (input.kind === 'folder') {
          // The runtime owns this environment: no branch, no head, and a path
          // equal to the project root so the existing derived `isRoot` holds.
          // It is never rediscovered and never pruned, so it is inserted
          // directly rather than through Git worktree reconciliation, which
          // upserts, prunes, and refreshes presence for externally discovered
          // membership.
          db.insert(worktrees)
            .values({
              projectId: row.id,
              path: input.rootPath,
              branch: null,
              head: null,
              sortOrder: nextProjectWorktreeOrder(db, row.id),
              createdAt: now,
              updatedAt: now,
              firstSeenAt: now,
              lastSeenAt: now,
            })
            .run();
        }

        return projectRow(row);
      });
    }),
    listProjects: database.use<ProjectRow[]>('list_projects', (db) =>
      db
        .select()
        .from(projects)
        .orderBy(...projectDisplayOrder)
        .all()
        .map(projectRow),
    ),
    listWorktrees: database.use<WorktreeRow[]>('list_worktrees', (db) =>
      db
        .select()
        .from(worktrees)
        .orderBy(worktrees.projectId, worktrees.sortOrder, worktrees.id)
        .all()
        .map(worktreeRow),
    ),
    reconcileProjectWorktrees: Effect.fn('ProjectRepository.reconcileProjectWorktrees')(
      function* (input) {
        return yield* database.transaction('reconcile_project_worktrees', (db) =>
          reconcileProjectWorktreesInTransaction(db, input),
        );
      },
    ),
    restoreProjectAtRootPath: Effect.fn('ProjectRepository.restoreProjectAtRootPath')(
      function* (input) {
        return yield* database.transaction('restore_project_at_root_path', (db) => {
          const now = timestamp();
          db.update(projects)
            .set({
              rootPath: input.rootPath,
              status: 'present',
              // Read before the write below lands, so the transition is judged
              // against the stored status rather than the caller's stale row.
              ...presenceRankPatch(db, input.projectId),
              updatedAt: now,
              lastSeenAt: now,
              missingReason: null,
            })
            .where(eq(projects.id, input.projectId))
            .run();

          return reconcileProjectWorktreesInTransaction(db, input);
        });
      },
    ),
    setProjectStatus: Effect.fn('ProjectRepository.setProjectStatus')(function* (input) {
      // Reconciliation calls this for every project on every sweep, so the
      // rank patch must read the stored status and stay empty for a project
      // that is already present. Presence metadata still refreshes.
      return yield* database.transaction('set_project_status', (db) => {
        const now = timestamp();
        db.update(projects)
          .set({
            status: input.status,
            ...(input.status === 'present' ? presenceRankPatch(db, input.id) : {}),
            updatedAt: now,
            lastSeenAt: input.status === 'present' ? now : null,
            missingReason: input.status === 'missing' ? (input.missingReason ?? null) : null,
          })
          .where(eq(projects.id, input.id))
          .run();
      });
    }),
    moveProjectOrder: Effect.fn('ProjectRepository.moveProjectOrder')(function* (input) {
      return yield* database.transaction('move_project_order', (db) =>
        moveProjectOrderInTransaction(db, input),
      );
    }),
    moveProjectWorktreeOrder: Effect.fn('ProjectRepository.moveProjectWorktreeOrder')(
      function* (input) {
        return yield* database.transaction('move_project_worktree_order', (db) =>
          moveProjectWorktreeOrderInTransaction(db, input),
        );
      },
    ),
  });
});

interface ProjectRepositoryShape {
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
  /** An exact match on the stored path, which reconciliation records as Git reports it. */
  readonly findProjectWorktreeByPath: (input: {
    readonly projectId: number;
    readonly path: string;
  }) => Effect.Effect<WorktreeRow | null, DatabaseError>;
  /** Deletes the project row; worktree-scoped rows cascade. True iff a project row was deleted. */
  readonly deleteProject: (
    projectId: number,
    /**
     * Another domain's writes that must commit or roll back with this delete (today: workflow run
     * erasure). Synchronous; runs first, inside the same transaction, even when no project row
     * matches. A throw rolls back both.
     */
    inTransaction: (db: RuntimeDrizzleDatabase) => void,
  ) => Effect.Effect<boolean, DatabaseError>;
  readonly deleteWorktree: (worktreeId: number) => Effect.Effect<boolean, DatabaseError>;
  /**
   * Creates a project and, for a folder project, its sole environment as one
   * durable unit. The caller supplies the classified kind; the repository never
   * infers or defaults it.
   */
  readonly createProject: (input: {
    readonly name: string;
    readonly rootPath: string;
    readonly kind: ProjectKind;
  }) => Effect.Effect<ProjectRow, DatabaseError>;
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
  readonly moveProjectOrder: (input: {
    readonly projectId: number;
    readonly beforeProjectId: number | null;
  }) => Effect.Effect<ProjectOrderMoveResult, DatabaseError>;
  readonly moveProjectWorktreeOrder: (input: {
    readonly projectId: number;
    readonly worktreeId: number;
    readonly beforeWorktreeId: number | null;
  }) => Effect.Effect<WorktreeOrderMoveResult, DatabaseError>;
}

export class ProjectRepository extends Context.Service<ProjectRepository, ProjectRepositoryShape>()(
  'isagi/runtime/projects/ProjectRepository',
) {
  static readonly layer = Layer.effect(ProjectRepository, make);
}

function reconcileProjectWorktreesInTransaction(
  db: RuntimeDatabaseConnection,
  input: {
    readonly projectId: number;
    readonly discovered: readonly DiscoveredWorktree[];
  },
) {
  const now = timestamp();
  const added: ReconciledWorktreeSummary[] = [];
  // Resolved on first insertion and advanced per inserted row, so a discovery
  // pass that only refreshes known worktrees consumes no ranks and leaves the
  // existing order untouched.
  let nextOrder: number | null = null;

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
      nextOrder ??= nextProjectWorktreeOrder(db, input.projectId);
      const inserted = db
        .insert(worktrees)
        .values({
          projectId: input.projectId,
          path: worktree.path,
          branch: worktree.branch,
          head: worktree.head,
          sortOrder: nextOrder,
          createdAt: now,
          updatedAt: now,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .returning({ id: worktrees.id, path: worktrees.path, branch: worktrees.branch })
        .get();
      nextOrder += 1;
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

  return { added, missing } satisfies WorkspaceReconcileProjectWorktreesResult;
}

/**
 * Moves one present project against an explicit present anchor.
 *
 * Every fact is re-read here rather than trusted from the service: this is the
 * only point at which the request's assumptions and the stored rows are known to
 * agree. The source is loaded on its own before the sibling list so a project
 * that exists but is missing reports `project_not_present` instead of vanishing
 * into "not found".
 */
function moveProjectOrderInTransaction(
  db: RuntimeDatabaseConnection,
  input: { readonly projectId: number; readonly beforeProjectId: number | null },
): ProjectOrderMoveResult {
  const source = db
    .select({ id: projects.id, status: projects.status })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!source) return { status: 'rejected', reason: 'project_not_found' };
  if (source.status !== 'present') return { status: 'rejected', reason: 'project_not_present' };

  if (input.beforeProjectId !== null) {
    const anchor = db
      .select({ id: projects.id, status: projects.status })
      .from(projects)
      .where(eq(projects.id, input.beforeProjectId))
      .get();
    if (!anchor) return { status: 'rejected', reason: 'before_project_not_found' };
    if (anchor.status !== 'present')
      return { status: 'rejected', reason: 'before_project_not_present' };
  }

  // Only present projects are ranked. A missing project's rank is meaningless by
  // Phase 02's contract, so it is neither a sibling here nor renumbered below.
  const siblings = db
    .select({ id: projects.id, sortOrder: projects.sortOrder })
    .from(projects)
    .where(eq(projects.status, 'present'))
    .orderBy(projects.sortOrder, projects.id)
    .all();

  const now = timestamp();
  for (const change of compactedRankChanges(
    siblings,
    moveBefore(
      siblings.map((sibling) => sibling.id),
      input.projectId,
      input.beforeProjectId,
    ),
  )) {
    db.update(projects)
      .set({ sortOrder: change.sortOrder, updatedAt: now })
      .where(eq(projects.id, change.id))
      .run();
  }

  return { status: 'moved' };
}

/**
 * Moves one non-root worktree within a single project.
 *
 * The derived root is loaded, refused as both source and anchor, and then left
 * out of the sibling list entirely — so its stored rank is never rewritten and
 * nothing can be placed above it. Source and anchor are looked up globally, not
 * within the project, so a worktree belonging to another project is reported as
 * a mismatch rather than as missing.
 */
function moveProjectWorktreeOrderInTransaction(
  db: RuntimeDatabaseConnection,
  input: {
    readonly projectId: number;
    readonly worktreeId: number;
    readonly beforeWorktreeId: number | null;
  },
): WorktreeOrderMoveResult {
  const project = db
    .select({
      id: projects.id,
      status: projects.status,
      kind: projects.kind,
      rootPath: projects.rootPath,
    })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return { status: 'rejected', reason: 'project_not_found' };
  if (project.status !== 'present') return { status: 'rejected', reason: 'project_not_present' };
  // Eligibility is validated here rather than in the service because this
  // function is the sole owner of reorder validation. A folder project's single
  // environment is not an ordered checkout list, so the refusal precedes the
  // worktree lookup: kind is why the operation is unavailable, regardless of
  // which worktree was named.
  if (project.kind !== 'git') return { status: 'rejected', reason: 'worktrees_not_supported' };

  const source = db
    .select({ id: worktrees.id, projectId: worktrees.projectId, path: worktrees.path })
    .from(worktrees)
    .where(eq(worktrees.id, input.worktreeId))
    .get();
  if (!source) return { status: 'rejected', reason: 'worktree_not_found' };
  if (source.projectId !== project.id)
    return { status: 'rejected', reason: 'worktree_project_mismatch' };
  if (source.path === project.rootPath)
    return { status: 'rejected', reason: 'root_worktree_fixed' };

  if (input.beforeWorktreeId !== null) {
    const anchor = db
      .select({ id: worktrees.id, projectId: worktrees.projectId, path: worktrees.path })
      .from(worktrees)
      .where(eq(worktrees.id, input.beforeWorktreeId))
      .get();
    if (!anchor) return { status: 'rejected', reason: 'before_worktree_not_found' };
    if (anchor.projectId !== project.id)
      return { status: 'rejected', reason: 'before_worktree_project_mismatch' };
    // The root contributes no insertion slot, so naming it as an anchor is the
    // only way to ask for a position above it.
    if (anchor.path === project.rootPath)
      return { status: 'rejected', reason: 'before_root_worktree_fixed' };
  }

  const siblings = db
    .select({ id: worktrees.id, sortOrder: worktrees.sortOrder })
    .from(worktrees)
    .where(and(eq(worktrees.projectId, project.id), ne(worktrees.path, project.rootPath)))
    .orderBy(worktrees.sortOrder, worktrees.id)
    .all();

  const now = timestamp();
  for (const change of compactedRankChanges(
    siblings,
    moveBefore(
      siblings.map((sibling) => sibling.id),
      input.worktreeId,
      input.beforeWorktreeId,
    ),
  )) {
    db.update(worktrees)
      .set({ sortOrder: change.sortOrder, updatedAt: now })
      .where(eq(worktrees.id, change.id))
      .run();
  }

  return { status: 'moved' };
}

/**
 * Display order for `projects`: the present section first, ranked; then the
 * disconnected section by identifier alone.
 *
 * A missing project keeps whatever rank it held, but that rank is deliberately
 * meaningless — restoration always appends — so ordering the disconnected
 * section by it would hand the value semantics it is not supposed to have.
 */
const projectDisplayOrder = [
  sql`case when ${projects.status} = 'present' then 0 else 1 end`,
  sql`case when ${projects.status} = 'present' then ${projects.sortOrder} else 0 end`,
  projects.id,
];

/**
 * The rank an appended present project should take. Missing projects are
 * excluded, so a restored project lands after every present sibling.
 */
function nextPresentProjectOrder(db: RuntimeDatabaseConnection) {
  const row = db
    .select({ highest: max(projects.sortOrder) })
    .from(projects)
    .where(eq(projects.status, 'present'))
    .get();
  return (row?.highest ?? -1) + 1;
}

function nextProjectWorktreeOrder(db: RuntimeDatabaseConnection, projectId: number) {
  const row = db
    .select({ highest: max(worktrees.sortOrder) })
    .from(worktrees)
    .where(eq(worktrees.projectId, projectId))
    .get();
  return (row?.highest ?? -1) + 1;
}

/**
 * The single rule for how a project status write touches its rank, shared by
 * both paths that can make a project present so their append semantics cannot
 * drift apart.
 *
 * Appends only on a genuine `missing -> present` transition, judged against the
 * stored row inside the caller's transaction. Every other case returns nothing,
 * which is what keeps repeated reconciliation of a present project from
 * reshuffling the rail.
 */
function presenceRankPatch(db: RuntimeDatabaseConnection, projectId: number) {
  const current = db
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!current || current.status === 'present') {
    return {};
  }
  return { sortOrder: nextPresentProjectOrder(db) };
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
    kind: row.kind,
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
  Parameters<RuntimeDatabase['Service']['transaction']>[1]
>[0];
