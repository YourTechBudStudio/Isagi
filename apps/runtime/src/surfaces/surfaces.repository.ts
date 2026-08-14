import { and, eq, getTableColumns, inArray, isNotNull } from 'drizzle-orm';
import { Context, Effect, Layer, Schema } from 'effect';

import {
  surfaceLayoutNodeSchema,
  type SurfaceLayoutNode,
  type SurfaceOrderRejectionReason,
} from '@isagi/contracts';

import {
  AgentSessionArtifacts,
  type AgentSessionArtifactsService,
} from '../agent-sessions/harness/ledger.js';
import { compactedRankChanges, moveBefore } from '../lib/sibling-order.js';
import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDatabaseService,
} from '../persistence/index.js';
import {
  agentSessions,
  ptyProcesses,
  surfacePanes,
  terminalSessions,
  worktreeEnvironmentStates,
  worktrees,
  worktreeSurfaces,
} from '../persistence/schema.js';
import type { SurfacePaneDeletePlan } from './delete-plan.js';
import { insertPaneIntoLayout, layoutContainsPane } from './layout.js';
import {
  agentSessionRow,
  focusRow,
  paneRow,
  surfaceMetadataRow,
  surfaceRow,
  terminalSessionRow,
} from './row-mappers.js';
import type {
  AgentSessionRow,
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  DeleteSurfaceRowsOutput,
  EnvironmentFocusRow,
  RenameSurfaceOutput,
  SetSurfaceLayoutOutput,
  SurfaceDeleteTarget,
  SurfaceMetadataRow,
  SurfacePaneRow,
  SurfaceRow,
  PaneSessionBinding,
  SplitSurfacePaneInput,
  SplitSurfacePaneOutput,
  TerminalSessionRow,
} from './types.js';

export interface SurfaceRepositoryService {
  readonly worktreeExists: (worktreeId: number) => Effect.Effect<boolean, DatabaseError>;
  readonly findSurface: (surfaceId: number) => Effect.Effect<SurfaceRow | null, DatabaseError>;
  readonly findPane: (paneId: number) => Effect.Effect<SurfacePaneRow | null, DatabaseError>;
  readonly findWorktreePath: (worktreeId: number) => Effect.Effect<string | null, DatabaseError>;
  readonly findEnvironmentFocus: (
    worktreeId: number,
  ) => Effect.Effect<EnvironmentFocusRow | null, DatabaseError>;
  readonly listWorkspaceSurfaceMetadata: Effect.Effect<SurfaceMetadataRow[], DatabaseError>;
  readonly listEnvironmentFocusStates: Effect.Effect<EnvironmentFocusRow[], DatabaseError>;
  readonly listPanesForSurface: (
    surfaceId: number,
  ) => Effect.Effect<SurfacePaneRow[], DatabaseError>;
  readonly listAgentSessionsForPanes: (
    paneIds: readonly number[],
  ) => Effect.Effect<AgentSessionRow[], DatabaseError>;
  readonly listTerminalSessionsForPanes: (
    paneIds: readonly number[],
  ) => Effect.Effect<TerminalSessionRow[], DatabaseError>;
  readonly listPaneSessionBindings: Effect.Effect<PaneSessionBinding[], DatabaseError>;
  readonly findPaneForSession: (input: {
    readonly sessionKind: 'agent_session' | 'terminal_session';
    readonly sessionId: number;
  }) => Effect.Effect<
    { readonly worktreeId: number; readonly surfaceId: number; readonly paneId: number } | null,
    DatabaseError
  >;
  readonly findSurfaceDeleteTarget: (
    surfaceId: number,
  ) => Effect.Effect<SurfaceDeleteTarget | null, DatabaseError>;
  readonly renameSurface: (input: {
    readonly surfaceId: number;
    readonly title: string;
  }) => Effect.Effect<RenameSurfaceOutput, DatabaseError>;
  readonly deleteSurface: (
    target: SurfaceDeleteTarget,
  ) => Effect.Effect<DeleteSurfaceRowsOutput, DatabaseError>;
  readonly deleteSurfacePane: (input: {
    readonly target: SurfaceDeleteTarget;
    readonly plan: SurfacePaneDeletePlan;
  }) => Effect.Effect<DeleteSurfaceRowsOutput, DatabaseError>;
  readonly createSinglePaneSurface: (
    input: CreateSinglePaneSurfaceInput,
  ) => Effect.Effect<CreateSinglePaneSurfaceOutput, DatabaseError>;
  readonly splitSurfacePane: (
    input: SplitSurfacePaneInput,
  ) => Effect.Effect<SplitSurfacePaneOutput | null, DatabaseError>;
  readonly setSurfaceLayout: (input: {
    readonly surfaceId: number;
    readonly layout: SurfaceLayoutNode;
  }) => Effect.Effect<SetSurfaceLayoutOutput, DatabaseError>;
  readonly setPaneSession: (input: {
    readonly paneId: number;
    readonly sessionKind: 'agent_session' | 'terminal_session' | null;
    readonly sessionId: number | null;
  }) => Effect.Effect<void, DatabaseError>;
  readonly claimPaneSession: (input: {
    readonly paneId: number;
    readonly sessionKind: 'agent_session' | 'terminal_session';
    readonly sessionId: number;
  }) => Effect.Effect<void, DatabaseError>;
  readonly setEnvironmentFocus: (
    input: EnvironmentFocusRow,
  ) => Effect.Effect<EnvironmentFocusRow, DatabaseError>;
  readonly moveSurfaceOrder: (input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly beforeSurfaceId: number | null;
  }) => Effect.Effect<SurfaceOrderMoveResult, DatabaseError>;
}

/**
 * Returned rather than thrown: `database.transaction` converts a throw into a
 * `DatabaseError`, which would report an expected rejection as a runtime fault.
 */
export type SurfaceOrderMoveResult =
  | { readonly status: 'moved' }
  | { readonly status: 'rejected'; readonly reason: SurfaceOrderRejectionReason };

export class SurfaceRepositoryWorktreeMissing extends Error {
  constructor(readonly worktreeId: number) {
    super(`Worktree ${worktreeId} was not found.`);
  }
}

export const SurfaceRepository =
  Context.GenericTag<SurfaceRepositoryService>('isagi/SurfaceRepository');

export const SurfaceRepositoryLive = Layer.effect(
  SurfaceRepository,
  Effect.gen(function* () {
    const database = yield* RuntimeDatabase;
    const artifacts = yield* AgentSessionArtifacts;
    const ptyColumns = getTableColumns(ptyProcesses);

    return {
      worktreeExists: (worktreeId) =>
        database.use('surface_worktree_exists', (db) =>
          Boolean(
            db
              .select({ id: worktrees.id })
              .from(worktrees)
              .where(eq(worktrees.id, worktreeId))
              .get(),
          ),
        ),
      findSurface: (surfaceId) =>
        database.use('find_surface', (db) => {
          const row = db
            .select()
            .from(worktreeSurfaces)
            .where(eq(worktreeSurfaces.id, surfaceId))
            .get();
          return row ? surfaceRow(row) : null;
        }),
      findPane: (paneId) =>
        database.use('find_surface_pane', (db) => {
          const row = db.select().from(surfacePanes).where(eq(surfacePanes.id, paneId)).get();
          return row ? paneRow(row) : null;
        }),
      findWorktreePath: (worktreeId) =>
        database.use('find_surface_worktree_path', (db) => {
          const row = db
            .select({ path: worktrees.path })
            .from(worktrees)
            .where(eq(worktrees.id, worktreeId))
            .get();
          return row?.path ?? null;
        }),
      findEnvironmentFocus: (worktreeId) =>
        database.use('find_worktree_environment_focus', (db) => {
          const row = db
            .select()
            .from(worktreeEnvironmentStates)
            .where(eq(worktreeEnvironmentStates.worktreeId, worktreeId))
            .get();
          return row ? focusRow(row) : null;
        }),
      listWorkspaceSurfaceMetadata: listWorkspaceSurfaceMetadata(database),
      listEnvironmentFocusStates: database.use('list_worktree_environment_focus_states', (db) =>
        db.select().from(worktreeEnvironmentStates).all().map(focusRow),
      ),
      listPanesForSurface: (surfaceId) =>
        database.use('list_surface_panes', (db) =>
          db
            .select()
            .from(surfacePanes)
            .where(eq(surfacePanes.surfaceId, surfaceId))
            .orderBy(surfacePanes.sortOrder, surfacePanes.id)
            .all()
            .map(paneRow),
        ),
      listAgentSessionsForPanes: (paneIds) =>
        listAgentSessionsForPanes(artifacts, database, ptyColumns, paneIds),
      listTerminalSessionsForPanes: (paneIds) =>
        listTerminalSessionsForPanes(database, ptyColumns, paneIds),
      listPaneSessionBindings: listPaneSessionBindings(database),
      findPaneForSession: (input) =>
        database.use('find_pane_for_session', (db) => {
          const row = db
            .select({
              worktreeId: worktreeSurfaces.worktreeId,
              surfaceId: surfacePanes.surfaceId,
              paneId: surfacePanes.id,
            })
            .from(surfacePanes)
            .innerJoin(worktreeSurfaces, eq(surfacePanes.surfaceId, worktreeSurfaces.id))
            .where(
              and(
                eq(surfacePanes.sessionKind, input.sessionKind),
                eq(surfacePanes.sessionId, input.sessionId),
              ),
            )
            .get();
          return row ?? null;
        }),
      findSurfaceDeleteTarget: (surfaceId) =>
        Effect.gen(function* () {
          const surface = yield* database.use('find_surface_delete_target_surface', (db) => {
            const row = db
              .select()
              .from(worktreeSurfaces)
              .where(eq(worktreeSurfaces.id, surfaceId))
              .get();
            return row ? surfaceRow(row) : null;
          });
          if (!surface) return null;
          const panes = yield* database.use('find_surface_delete_target_panes', (db) =>
            db
              .select()
              .from(surfacePanes)
              .where(eq(surfacePanes.surfaceId, surfaceId))
              .orderBy(surfacePanes.sortOrder, surfacePanes.id)
              .all()
              .map(paneRow),
          );
          return deleteTarget(surface, panes);
        }),
      renameSurface: (input) =>
        database.use('rename_surface', (db) => {
          db.update(worktreeSurfaces)
            .set({ title: input.title, updatedAt: timestamp() })
            .where(eq(worktreeSurfaces.id, input.surfaceId))
            .run();
          return { surfaceId: input.surfaceId, title: input.title };
        }),
      deleteSurface: (target) =>
        database.transaction('delete_surface', (db) => {
          db.delete(worktreeSurfaces).where(eq(worktreeSurfaces.id, target.surface.id)).run();
          return {
            deletedSurfaceId: target.surface.id,
            deletedPaneIds: target.panes.map(({ pane }) => pane.id),
          };
        }),
      deleteSurfacePane: (input) =>
        database.transaction('delete_surface_pane', (db) => {
          if (input.plan.deletedPaneIds.length === 0)
            return { deletedSurfaceId: null, deletedPaneIds: [] };
          if (input.plan.deletedSurfaceId !== null) {
            db.delete(worktreeSurfaces)
              .where(eq(worktreeSurfaces.id, input.target.surface.id))
              .run();
            return {
              deletedSurfaceId: input.target.surface.id,
              deletedPaneIds: input.plan.deletedPaneIds,
            };
          }
          const deletedPaneId = input.plan.deletedPaneIds[0];
          if (!deletedPaneId || !input.plan.nextLayout)
            return { deletedSurfaceId: null, deletedPaneIds: [] };
          const now = timestamp();
          db.update(worktreeSurfaces)
            .set({ layoutJson: JSON.stringify(input.plan.nextLayout), updatedAt: now })
            .where(eq(worktreeSurfaces.id, input.target.surface.id))
            .run();
          db.delete(surfacePanes).where(eq(surfacePanes.id, deletedPaneId)).run();
          return { deletedSurfaceId: null, deletedPaneIds: [deletedPaneId] };
        }),
      createSinglePaneSurface: (input) =>
        database.transaction('create_single_pane_surface', (db) => {
          const worktree = db
            .select()
            .from(worktrees)
            .where(eq(worktrees.id, input.worktreeId))
            .get();
          if (!worktree) throw new SurfaceRepositoryWorktreeMissing(input.worktreeId);
          const surface = createSinglePaneSurfaceRows(db, input);
          const now = timestamp();
          const focus = db
            .select({ id: worktreeEnvironmentStates.id })
            .from(worktreeEnvironmentStates)
            .where(eq(worktreeEnvironmentStates.worktreeId, input.worktreeId))
            .get();
          const focusValues = {
            activeSurfaceId: surface.surfaceId,
            activePaneId: surface.paneId,
            updatedAt: now,
          };
          if (focus) {
            db.update(worktreeEnvironmentStates)
              .set(focusValues)
              .where(eq(worktreeEnvironmentStates.id, focus.id))
              .run();
          } else {
            db.insert(worktreeEnvironmentStates)
              .values({ worktreeId: input.worktreeId, ...focusValues, createdAt: now })
              .run();
          }
          return { ...surface, cwd: worktree.path };
        }),
      splitSurfacePane: (input) =>
        database.transaction('split_surface_pane', (db) => {
          const surface = db
            .select()
            .from(worktreeSurfaces)
            .where(eq(worktreeSurfaces.id, input.surfaceId))
            .get();
          if (!surface) return null;
          const existingPanes = db
            .select({ title: surfacePanes.title, sortOrder: surfacePanes.sortOrder })
            .from(surfacePanes)
            .where(eq(surfacePanes.surfaceId, input.surfaceId))
            .all();
          const layout = decodeLayout(surface.layoutJson);
          if (!layoutContainsPane(layout, input.sourcePaneId)) return null;

          const now = timestamp();
          const title = duplicateSafeTitle(
            input.titleBase,
            existingPanes.map((pane) => pane.title),
          );
          const sortOrder =
            existingPanes.reduce((max, pane) => Math.max(max, pane.sortOrder), -1) + 1;
          const pane = db
            .insert(surfacePanes)
            .values({
              surfaceId: input.surfaceId,
              title,
              sortOrder,
              sessionKind: null,
              sessionId: null,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: surfacePanes.id })
            .get();
          const nextLayout = insertPaneIntoLayout(
            layout,
            input.sourcePaneId,
            pane.id,
            input.direction,
          );
          db.update(worktreeSurfaces)
            .set({ layoutJson: JSON.stringify(nextLayout), updatedAt: now })
            .where(eq(worktreeSurfaces.id, input.surfaceId))
            .run();
          return { surfaceId: input.surfaceId, paneId: pane.id, title };
        }),
      setSurfaceLayout: (input) =>
        database.use('set_surface_layout', (db) => {
          db.update(worktreeSurfaces)
            .set({ layoutJson: JSON.stringify(input.layout), updatedAt: timestamp() })
            .where(eq(worktreeSurfaces.id, input.surfaceId))
            .run();
          return { surfaceId: input.surfaceId, layout: input.layout };
        }),
      setPaneSession: (input) =>
        database.use('set_surface_pane_session', (db) => {
          db.update(surfacePanes)
            .set({
              sessionKind: input.sessionKind,
              sessionId: input.sessionId,
              updatedAt: timestamp(),
            })
            .where(eq(surfacePanes.id, input.paneId))
            .run();
        }),
      claimPaneSession: (input) =>
        database.transaction('claim_surface_pane_session', (db) => {
          const now = timestamp();
          db.update(surfacePanes)
            .set({ sessionKind: null, sessionId: null, updatedAt: now })
            .where(
              and(
                eq(surfacePanes.sessionKind, input.sessionKind),
                eq(surfacePanes.sessionId, input.sessionId),
              ),
            )
            .run();
          db.update(surfacePanes)
            .set({
              sessionKind: input.sessionKind,
              sessionId: input.sessionId,
              updatedAt: now,
            })
            .where(eq(surfacePanes.id, input.paneId))
            .run();
        }),
      setEnvironmentFocus: (input) =>
        database.use('set_worktree_environment_focus', (db) => {
          const now = timestamp();
          const existing = db
            .select({ id: worktreeEnvironmentStates.id })
            .from(worktreeEnvironmentStates)
            .where(eq(worktreeEnvironmentStates.worktreeId, input.worktreeId))
            .get();
          const values = {
            activeSurfaceId: input.activeSurfaceId,
            activePaneId: input.activePaneId,
            updatedAt: now,
          };
          if (existing) {
            db.update(worktreeEnvironmentStates)
              .set(values)
              .where(eq(worktreeEnvironmentStates.id, existing.id))
              .run();
          } else {
            db.insert(worktreeEnvironmentStates)
              .values({ worktreeId: input.worktreeId, ...values, createdAt: now })
              .run();
          }
          return input;
        }),
      moveSurfaceOrder: (input) =>
        database.transaction('move_surface_order', (db) =>
          moveSurfaceOrderInTransaction(db, input),
        ),
    } satisfies SurfaceRepositoryService;
  }),
);

/**
 * Moves one surface within the worktree named in the route.
 *
 * The parent is the trust boundary: the surface row knows its own worktree, but
 * a surface belonging to a different one is rejected rather than adopted, so a
 * stale or hostile client cannot reparent through this endpoint. Source and
 * anchor are looked up globally for that reason — scoping the query to the
 * worktree would report a cross-worktree surface as merely missing.
 */
function moveSurfaceOrderInTransaction(
  db: RuntimeDatabaseConnection,
  input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly beforeSurfaceId: number | null;
  },
): SurfaceOrderMoveResult {
  const worktree = db
    .select({ id: worktrees.id })
    .from(worktrees)
    .where(eq(worktrees.id, input.worktreeId))
    .get();
  if (!worktree) return { status: 'rejected', reason: 'worktree_not_found' };

  const source = db
    .select({ id: worktreeSurfaces.id, worktreeId: worktreeSurfaces.worktreeId })
    .from(worktreeSurfaces)
    .where(eq(worktreeSurfaces.id, input.surfaceId))
    .get();
  if (!source) return { status: 'rejected', reason: 'surface_not_found' };
  if (source.worktreeId !== worktree.id)
    return { status: 'rejected', reason: 'surface_worktree_mismatch' };

  if (input.beforeSurfaceId !== null) {
    const anchor = db
      .select({ id: worktreeSurfaces.id, worktreeId: worktreeSurfaces.worktreeId })
      .from(worktreeSurfaces)
      .where(eq(worktreeSurfaces.id, input.beforeSurfaceId))
      .get();
    if (!anchor) return { status: 'rejected', reason: 'before_surface_not_found' };
    if (anchor.worktreeId !== worktree.id)
      return { status: 'rejected', reason: 'before_surface_worktree_mismatch' };
  }

  const siblings = db
    .select({ id: worktreeSurfaces.id, sortOrder: worktreeSurfaces.sortOrder })
    .from(worktreeSurfaces)
    .where(eq(worktreeSurfaces.worktreeId, worktree.id))
    .orderBy(worktreeSurfaces.sortOrder, worktreeSurfaces.id)
    .all();

  const now = timestamp();
  for (const change of compactedRankChanges(
    siblings,
    moveBefore(
      siblings.map((sibling) => sibling.id),
      input.surfaceId,
      input.beforeSurfaceId,
    ),
  )) {
    db.update(worktreeSurfaces)
      .set({ sortOrder: change.sortOrder, updatedAt: now })
      .where(eq(worktreeSurfaces.id, change.id))
      .run();
  }

  return { status: 'moved' };
}

function listAgentSessionsForPanes(
  artifacts: AgentSessionArtifactsService,
  database: RuntimeDatabaseService,
  ptyColumns: ReturnType<typeof getTableColumns<typeof ptyProcesses>>,
  paneIds: readonly number[],
) {
  return Effect.gen(function* () {
    const rows = yield* database.use('list_agent_sessions_for_panes', (db) => {
      if (paneIds.length === 0) return [];
      return db
        .select({ session: agentSessions, process: ptyColumns })
        .from(surfacePanes)
        .innerJoin(agentSessions, eq(surfacePanes.sessionId, agentSessions.id))
        .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id))
        .where(
          and(
            inArray(surfacePanes.id, [...paneIds]),
            eq(surfacePanes.sessionKind, 'agent_session'),
          ),
        )
        .all();
    });
    return yield* Effect.all(
      rows.map((row) => agentSessionRow(artifacts, row.session, row.process)),
    );
  });
}

function listWorkspaceSurfaceMetadata(database: RuntimeDatabaseService) {
  return database.use('list_workspace_surface_metadata_rows', (db) => {
    const rows = db
      .select({
        surface: worktreeSurfaces,
        paneSessionKind: surfacePanes.sessionKind,
      })
      .from(worktreeSurfaces)
      .leftJoin(surfacePanes, eq(surfacePanes.surfaceId, worktreeSurfaces.id))
      .orderBy(
        worktreeSurfaces.worktreeId,
        worktreeSurfaces.sortOrder,
        worktreeSurfaces.id,
        surfacePanes.sortOrder,
        surfacePanes.id,
      )
      .all();

    const surfaces = new Map<
      number,
      Omit<SurfaceMetadataRow, 'paneKinds'> & {
        readonly paneKinds: ('agent_session' | 'terminal_session')[];
      }
    >();
    for (const row of rows) {
      const existing = surfaces.get(row.surface.id);
      if (existing) {
        if (row.paneSessionKind) {
          existing.paneKinds.push(row.paneSessionKind);
        }
        continue;
      }

      surfaces.set(row.surface.id, {
        ...surfaceMetadataRow(row.surface),
        paneKinds: row.paneSessionKind ? [row.paneSessionKind] : [],
      });
    }
    return [...surfaces.values()];
  });
}

function listTerminalSessionsForPanes(
  database: RuntimeDatabaseService,
  ptyColumns: ReturnType<typeof getTableColumns<typeof ptyProcesses>>,
  paneIds: readonly number[],
) {
  return database.use('list_terminal_sessions_for_panes', (db) => {
    if (paneIds.length === 0) return [];
    return db
      .select({ session: terminalSessions, process: ptyColumns })
      .from(surfacePanes)
      .innerJoin(terminalSessions, eq(surfacePanes.sessionId, terminalSessions.id))
      .leftJoin(ptyProcesses, eq(terminalSessions.activePtyProcessId, ptyProcesses.id))
      .where(
        and(
          inArray(surfacePanes.id, [...paneIds]),
          eq(surfacePanes.sessionKind, 'terminal_session'),
        ),
      )
      .all()
      .map((row) => terminalSessionRow(row.session, row.process));
  });
}

function listPaneSessionBindings(database: RuntimeDatabaseService) {
  return database.use('list_pane_session_bindings', (db) =>
    db
      .select({
        paneId: surfacePanes.id,
        sessionKind: surfacePanes.sessionKind,
        sessionId: surfacePanes.sessionId,
        agentActivePtyProcessId: agentSessions.activePtyProcessId,
        terminalActivePtyProcessId: terminalSessions.activePtyProcessId,
      })
      .from(surfacePanes)
      .leftJoin(
        agentSessions,
        and(
          eq(surfacePanes.sessionKind, 'agent_session'),
          eq(surfacePanes.sessionId, agentSessions.id),
        ),
      )
      .leftJoin(
        terminalSessions,
        and(
          eq(surfacePanes.sessionKind, 'terminal_session'),
          eq(surfacePanes.sessionId, terminalSessions.id),
        ),
      )
      .where(and(isNotNull(surfacePanes.sessionKind), isNotNull(surfacePanes.sessionId)))
      .orderBy(surfacePanes.id)
      .all()
      .flatMap((row): PaneSessionBinding[] => {
        if (row.sessionKind === 'agent_session' && row.sessionId !== null) {
          return [
            {
              paneId: row.paneId,
              sessionKind: row.sessionKind,
              sessionId: row.sessionId,
              activePtyProcessId: row.agentActivePtyProcessId,
            },
          ];
        }
        if (row.sessionKind === 'terminal_session' && row.sessionId !== null) {
          return [
            {
              paneId: row.paneId,
              sessionKind: row.sessionKind,
              sessionId: row.sessionId,
              activePtyProcessId: row.terminalActivePtyProcessId,
            },
          ];
        }
        return [];
      }),
  );
}

export function duplicateSafeTitle(titleBase: string, existingTitles: readonly string[]) {
  const used = new Set(existingTitles);
  if (!used.has(titleBase)) return titleBase;
  let suffix = 2;
  while (used.has(`${titleBase} ${suffix}`)) suffix += 1;
  return `${titleBase} ${suffix}`;
}

function createSinglePaneSurfaceRows(
  db: RuntimeDatabaseConnection,
  input: CreateSinglePaneSurfaceInput,
): Omit<CreateSinglePaneSurfaceOutput, 'cwd'> {
  const now = timestamp();
  const existingSurfaces = db
    .select({ title: worktreeSurfaces.title, sortOrder: worktreeSurfaces.sortOrder })
    .from(worktreeSurfaces)
    .where(eq(worktreeSurfaces.worktreeId, input.worktreeId))
    .all();
  const title = duplicateSafeTitle(
    input.titleBase,
    existingSurfaces.map((surface) => surface.title),
  );
  const sortOrder =
    existingSurfaces.reduce((max, surface) => Math.max(max, surface.sortOrder), -1) + 1;
  const surface = db
    .insert(worktreeSurfaces)
    .values({
      worktreeId: input.worktreeId,
      title,
      layoutJson: '{}',
      sortOrder,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: worktreeSurfaces.id })
    .get();
  const pane = db
    .insert(surfacePanes)
    .values({
      surfaceId: surface.id,
      title,
      sortOrder: 0,
      sessionKind: null,
      sessionId: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: surfacePanes.id })
    .get();
  db.update(worktreeSurfaces)
    .set({
      layoutJson: JSON.stringify({
        kind: 'leaf',
        nodeId: `pane-${pane.id}`,
        paneId: pane.id,
        collapsed: false,
      }),
      updatedAt: now,
    })
    .where(eq(worktreeSurfaces.id, surface.id))
    .run();
  return { surfaceId: surface.id, paneId: pane.id, title };
}

function deleteTarget(surface: SurfaceRow, panes: readonly SurfacePaneRow[]): SurfaceDeleteTarget {
  return {
    surface,
    panes: panes.map((pane) => ({ pane })),
  };
}

function decodeLayout(json: string): SurfaceLayoutNode {
  return Schema.decodeUnknownSync(surfaceLayoutNodeSchema)(JSON.parse(json));
}
function timestamp() {
  return new Date().toISOString();
}

type RuntimeDatabaseConnection = Parameters<
  Parameters<RuntimeDatabaseService['transaction']>[1]
>[0];
