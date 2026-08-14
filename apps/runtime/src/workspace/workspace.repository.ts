import { and, eq, inArray, max, ne, sql, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type {
  DurableSessionInventory,
  ProjectOrderRejectionReason,
  WorktreeOrderRejectionReason,
} from '@isagi/contracts';

import { compactedRankChanges, moveBefore } from '../lib/sibling-order.js';
import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDatabaseService,
} from '../persistence/index.js';
import {
  agentSessions,
  projects,
  surfacePanes,
  terminalSessions,
  worktreeCommandRuns,
  worktreeCommandStates,
  worktrees,
  worktreeSurfaces,
} from '../persistence/schema.js';
import type { DiscoveredWorktree, ProjectRow, WorktreeRow } from './types.js';

type ProjectRecord = InferSelectModel<typeof projects>;
type WorktreeRecord = InferSelectModel<typeof worktrees>;

type ReconciledWorktreeSummary = Pick<WorktreeRow, 'id' | 'path' | 'branch'>;

export interface WorkspaceReconcileProjectWorktreesResult {
  readonly added: readonly ReconciledWorktreeSummary[];
  readonly missing: readonly ReconciledWorktreeSummary[];
}

export interface WorktreeDeleteDiagnostics {
  readonly agentSessionCount: number;
  readonly agentSessionActivePtyProcessIds: readonly number[];
  readonly commandRunCount: number;
  readonly commandRunPtyProcessIds: readonly number[];
  readonly commandStateCount: number;
  readonly commandStateActivePtyProcessIds: readonly number[];
  readonly paneCount: number;
  readonly surfaceCount: number;
  readonly terminalSessionCount: number;
  readonly terminalSessionActivePtyProcessIds: readonly number[];
}

/**
 * Reorder outcomes are returned, never thrown: `database.transaction` turns any
 * throw into a `DatabaseError`, which would report an expected rejection as a
 * runtime fault. The service converts a rejection into its tagged domain error.
 */
export type ProjectOrderMoveResult =
  | { readonly status: 'moved' }
  | { readonly status: 'rejected'; readonly reason: ProjectOrderRejectionReason };

export type WorktreeOrderMoveResult =
  | { readonly status: 'moved' }
  | { readonly status: 'rejected'; readonly reason: WorktreeOrderRejectionReason };

export interface WorkspaceRepositoryService {
  /**
   * Every durable session the runtime still owns, with its worktree scope. This is the
   * authoritative set clients reconcile their cached terminals against, so it is required:
   * an absent implementation would otherwise read as "all durable sessions are gone".
   */
  readonly listDurableSessions: Effect.Effect<DurableSessionInventory, DatabaseError>;
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
  readonly readWorktreeDeleteDiagnostics: (
    worktreeId: number,
  ) => Effect.Effect<WorktreeDeleteDiagnostics, DatabaseError>;
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

export const WorkspaceRepository = Context.GenericTag<WorkspaceRepositoryService>(
  'isagi/WorkspaceRepository',
);

export const WorkspaceRepositoryLive = Layer.effect(
  WorkspaceRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;

    return {
      listDurableSessions: Effect.all([
        database.use('list_agent_session_identities', (db) =>
          db
            .select({ sessionId: agentSessions.id, worktreeId: agentSessions.worktreeId })
            .from(agentSessions)
            .orderBy(agentSessions.id)
            .all(),
        ),
        database.use('list_terminal_session_identities', (db) =>
          db
            .select({ sessionId: terminalSessions.id, worktreeId: terminalSessions.worktreeId })
            .from(terminalSessions)
            .orderBy(terminalSessions.id)
            .all(),
        ),
      ]).pipe(
        Effect.map(([agents, terminals]) => ({
          sessions: [
            ...agents.map((identity) => ({ kind: 'agent_session' as const, ...identity })),
            ...terminals.map((identity) => ({ kind: 'terminal_session' as const, ...identity })),
          ],
        })),
      ),
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
      readWorktreeDeleteDiagnostics: (worktreeId) =>
        database.use('read_worktree_delete_diagnostics', (db) => {
          const surfaces = db
            .select({ id: worktreeSurfaces.id })
            .from(worktreeSurfaces)
            .where(eq(worktreeSurfaces.worktreeId, worktreeId))
            .all();
          const surfaceIds = surfaces.map((surface) => surface.id);
          const panes =
            surfaceIds.length === 0
              ? []
              : db
                  .select({ id: surfacePanes.id })
                  .from(surfacePanes)
                  .where(inArray(surfacePanes.surfaceId, surfaceIds))
                  .all();
          const agents = db
            .select({
              activePtyProcessId: agentSessions.activePtyProcessId,
            })
            .from(agentSessions)
            .where(eq(agentSessions.worktreeId, worktreeId))
            .all();
          const terminals = db
            .select({
              activePtyProcessId: terminalSessions.activePtyProcessId,
            })
            .from(terminalSessions)
            .where(eq(terminalSessions.worktreeId, worktreeId))
            .all();
          const commandStates = db
            .select({
              activePtyProcessId: worktreeCommandStates.activePtyProcessId,
            })
            .from(worktreeCommandStates)
            .where(eq(worktreeCommandStates.worktreeId, worktreeId))
            .all();
          const commandRuns = db
            .select({
              ptyProcessId: worktreeCommandRuns.ptyProcessId,
            })
            .from(worktreeCommandRuns)
            .where(eq(worktreeCommandRuns.worktreeId, worktreeId))
            .all();

          return {
            agentSessionCount: agents.length,
            agentSessionActivePtyProcessIds: compactIds(
              agents.map((agent) => agent.activePtyProcessId),
            ),
            commandRunCount: commandRuns.length,
            commandRunPtyProcessIds: compactIds(commandRuns.map((run) => run.ptyProcessId)),
            commandStateCount: commandStates.length,
            commandStateActivePtyProcessIds: compactIds(
              commandStates.map((state) => state.activePtyProcessId),
            ),
            paneCount: panes.length,
            surfaceCount: surfaces.length,
            terminalSessionCount: terminals.length,
            terminalSessionActivePtyProcessIds: compactIds(
              terminals.map((terminal) => terminal.activePtyProcessId),
            ),
          } satisfies WorktreeDeleteDiagnostics;
        }),
      insertProject: (input) =>
        // A transaction, not a plain read/write pair: the appended rank is read
        // from the same present-project set the insert then joins.
        database.transaction('insert_project', (db) => {
          const now = timestamp();
          const row = db
            .insert(projects)
            .values({
              name: input.name,
              rootPath: input.rootPath,
              status: 'present',
              sortOrder: nextPresentProjectOrder(db),
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
        }),
      setProjectStatus: (input) =>
        // Reconciliation calls this for every project on every sweep, so the
        // rank patch must read the stored status and stay empty for a project
        // that is already present. Presence metadata still refreshes.
        database.transaction('set_project_status', (db) => {
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
        }),
      moveProjectOrder: (input) =>
        database.transaction('move_project_order', (db) =>
          moveProjectOrderInTransaction(db, input),
        ),
      moveProjectWorktreeOrder: (input) =>
        database.transaction('move_project_worktree_order', (db) =>
          moveProjectWorktreeOrderInTransaction(db, input),
        ),
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
    .select({ id: projects.id, status: projects.status, rootPath: projects.rootPath })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return { status: 'rejected', reason: 'project_not_found' };
  if (project.status !== 'present') return { status: 'rejected', reason: 'project_not_present' };

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

function compactIds(ids: readonly (number | null)[]) {
  return ids.filter((id): id is number => id !== null);
}

type RuntimeDatabaseConnection = Parameters<
  Parameters<RuntimeDatabaseService['transaction']>[1]
>[0];
