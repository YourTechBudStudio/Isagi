import { and, eq, getTableColumns, inArray, isNotNull } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type {
  PaneSessionKind,
  SurfaceLayoutNode,
  SurfaceOrderRejectionReason,
} from '@isagi/contracts';

import {
  AgentSessionArtifacts,
  type AgentSessionArtifactsService,
} from '../agent-sessions/harness/ledger.js';
import { editorContextRow, type EditorContextRow } from '../editor-contexts/index.js';
import { compactedRankChanges, moveBefore } from '../lib/sibling-order.js';
import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDatabaseService,
} from '../persistence/index.js';
import {
  agentSessions,
  editorContexts,
  ptyProcesses,
  surfacePanes,
  terminalSessions,
  worktreeEnvironmentStates,
  worktrees,
  worktreeSurfaces,
} from '../persistence/schema.js';
import { planSurfacePaneDelete } from './delete-plan.js';
import {
  decodeSurfaceLayout,
  encodeSurfaceLayout,
  insertPaneIntoLayout,
  layoutContainsPane,
  leafForPane,
} from './layout.js';
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
  CreateEmptySurfaceInput,
  CreateEmptySurfaceOutput,
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  DeletePaneRowsOutput,
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
  StartSurfacePaneInput,
  StartSurfacePaneResult,
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
  /**
   * Read composition for editor panes, shaped exactly like its terminal
   * sibling. The editor domain owns the row and its decoder; this joins it onto
   * panes for projection and never mutates it.
   */
  readonly listEditorContextsForPanes: (
    paneIds: readonly number[],
  ) => Effect.Effect<EditorContextRow[], DatabaseError>;
  readonly listPaneSessionBindings: Effect.Effect<PaneSessionBinding[], DatabaseError>;
  /**
   * The sessions named by pane bindings, by session id. For cleanup after a
   * delete, when the pane rows — and so the pane join — are already gone.
   */
  readonly listSessionsBoundTo: (
    panes: readonly SurfacePaneRow[],
  ) => Effect.Effect<
    { readonly agents: AgentSessionRow[]; readonly terminals: TerminalSessionRow[] },
    DatabaseError
  >;
  readonly findPaneForSession: (input: {
    readonly sessionKind: PaneSessionKind;
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
    surfaceId: number,
  ) => Effect.Effect<DeleteSurfaceRowsOutput, DatabaseError>;
  /**
   * Removes a pane, planning from the rows as they are inside the transaction,
   * so two concurrent deletes can never each write a layout the other made
   * stale. Removes nothing when the pane is already gone.
   */
  readonly deleteSurfacePane: (input: {
    readonly surfaceId: number;
    readonly paneId: number;
  }) => Effect.Effect<DeletePaneRowsOutput, DatabaseError>;
  readonly createSinglePaneSurface: (
    input: CreateSinglePaneSurfaceInput,
  ) => Effect.Effect<CreateSinglePaneSurfaceOutput, DatabaseError>;
  /** A surface with no panes, focused with no active pane. */
  readonly createEmptySurface: (
    input: CreateEmptySurfaceInput,
  ) => Effect.Effect<CreateEmptySurfaceOutput, DatabaseError>;
  /**
   * The first pane of an empty surface, focused. Refused, with nothing written, when the surface is
   * gone or already has panes.
   */
  readonly startSurfacePane: (
    input: StartSurfacePaneInput,
  ) => Effect.Effect<StartSurfacePaneResult, DatabaseError>;
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
  /**
   * Binds a session to a pane, moving it off any pane it was on. Both ends are
   * checked inside the transaction and nothing changes when either is gone: the
   * pane (its surface closed while the session was being created) or the
   * session (deleted by orphan GC after the caller last saw it — `session_id` has no
   * foreign key, so nothing else would stop a pane pointing at a missing row).
   */
  readonly claimPaneSession: (input: {
    readonly paneId: number;
    readonly sessionKind: 'agent_session' | 'terminal_session';
    readonly sessionId: number;
  }) => Effect.Effect<PaneSessionClaimResult, DatabaseError>;
  readonly setEnvironmentFocus: (
    input: EnvironmentFocusRow,
  ) => Effect.Effect<EnvironmentFocusRow, DatabaseError>;
  readonly moveSurfaceOrder: (input: {
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly beforeSurfaceId: number | null;
  }) => Effect.Effect<SurfaceOrderMoveResult, DatabaseError>;
}

export type PaneSessionClaimResult = 'claimed' | 'pane_missing' | 'session_missing';

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

/**
 * Why a transactional placement was refused. All three mean a caller reached
 * this seam with a durable entity it had no business binding here, which the
 * per-worktree editor lock plus a placement check before the call makes
 * unreachable — so it is an integrity defect, never a user-facing error.
 *
 * `foreign_worktree` is the one worth spelling out: binding another worktree's
 * editor context onto this surface would let a surface in one worktree project
 * and later operate on a different worktree's durable editor.
 */
export type InitialSessionRejectionReason = 'missing' | 'foreign_worktree' | 'already_placed';

export class SurfaceRepositoryInitialSessionRejected extends Error {
  constructor(
    readonly worktreeId: number,
    readonly sessionId: number | null,
    readonly reason: InitialSessionRejectionReason,
  ) {
    super(
      `Editor context ${sessionId ?? 'unknown'} cannot be placed in worktree ${worktreeId}: ${reason}.`,
    );
    this.name = 'SurfaceRepositoryInitialSessionRejected';
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
      listEditorContextsForPanes: (paneIds) =>
        listEditorContextsForPanes(database, ptyColumns, paneIds),
      listPaneSessionBindings: listPaneSessionBindings(database),
      listSessionsBoundTo: (panes) => listSessionsBoundTo(artifacts, database, ptyColumns, panes),
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
      deleteSurface: (surfaceId) =>
        database.transaction('delete_surface', (db) => {
          const deletedPanes = db
            .select()
            .from(surfacePanes)
            .where(eq(surfacePanes.surfaceId, surfaceId))
            .all()
            .map(paneRow);
          const deleted = db
            .delete(worktreeSurfaces)
            .where(eq(worktreeSurfaces.id, surfaceId))
            .returning({ id: worktreeSurfaces.id })
            .all();
          return deleted.length === 0
            ? { deletedSurfaceId: null, deletedPanes: [] }
            : { deletedSurfaceId: surfaceId, deletedPanes };
        }),
      deleteSurfacePane: (input) =>
        database.transaction('delete_surface_pane', (db) => {
          const surface = db
            .select()
            .from(worktreeSurfaces)
            .where(eq(worktreeSurfaces.id, input.surfaceId))
            .get();
          if (!surface) return { deletedPanes: [] };
          const panes = db
            .select()
            .from(surfacePanes)
            .where(eq(surfacePanes.surfaceId, input.surfaceId))
            .all()
            .map(paneRow);
          const plan = planSurfacePaneDelete(
            deleteTarget(surfaceRow(surface), panes),
            input.paneId,
          );
          if (plan.deletedPaneIds.length === 0) return { deletedPanes: [] };
          db.delete(surfacePanes)
            .where(
              and(
                inArray(surfacePanes.id, [...plan.deletedPaneIds]),
                eq(surfacePanes.surfaceId, input.surfaceId),
              ),
            )
            .run();
          db.update(worktreeSurfaces)
            .set({ layoutJson: encodeSurfaceLayout(plan.nextLayout), updatedAt: timestamp() })
            .where(eq(worktreeSurfaces.id, input.surfaceId))
            .run();
          return {
            deletedPanes: panes.filter((pane) => plan.deletedPaneIds.includes(pane.id)),
          };
        }),
      createSinglePaneSurface: (input) =>
        database
          .transaction('create_single_pane_surface', (db) => {
            const worktree = db
              .select()
              .from(worktrees)
              .where(eq(worktrees.id, input.worktreeId))
              .get();
            if (!worktree) throw new SurfaceRepositoryWorktreeMissing(input.worktreeId);
            const rejection = input.initialSession
              ? rejectInitialSession(db, input.worktreeId, input.initialSession)
              : null;
            // Checked before anything is inserted, so a rejection leaves no
            // surface, pane, layout, or focus residue behind.
            if (rejection) return { status: 'rejected' as const, reason: rejection };
            const surface = insertEmptySurfaceRow(db, input);
            const paneId = insertRootPaneRows(db, {
              surfaceId: surface.surfaceId,
              title: surface.title,
              initialSession: input.initialSession,
            });
            focusSurfaceRows(db, input.worktreeId, surface.surfaceId, paneId);
            return {
              status: 'created' as const,
              output: { ...surface, paneId, cwd: worktree.path },
            };
          })
          .pipe(
            Effect.flatMap((result) =>
              result.status === 'created'
                ? Effect.succeed(result.output)
                : // Converted to a defect out here rather than thrown inside the
                  // transaction: `database.transaction` wraps its body in
                  // `Effect.try`, so a throw would be laundered into a
                  // `DatabaseError` and reported as an ordinary database fault.
                  Effect.die(
                    new SurfaceRepositoryInitialSessionRejected(
                      input.worktreeId,
                      input.initialSession?.sessionId ?? null,
                      result.reason,
                    ),
                  ),
            ),
          ),
      createEmptySurface: (input) =>
        database.transaction('create_empty_surface', (db) => {
          const worktree = db
            .select({ id: worktrees.id })
            .from(worktrees)
            .where(eq(worktrees.id, input.worktreeId))
            .get();
          if (!worktree) throw new SurfaceRepositoryWorktreeMissing(input.worktreeId);
          const surface = insertEmptySurfaceRow(db, input);
          focusSurfaceRows(db, input.worktreeId, surface.surfaceId, null);
          return surface;
        }),
      startSurfacePane: (input) =>
        database
          .transaction('start_surface_pane', (db) => {
            const surface = db
              .select()
              .from(worktreeSurfaces)
              .where(eq(worktreeSurfaces.id, input.surfaceId))
              .get();
            if (!surface) return { status: 'surface_not_found' as const };
            const existingPane = db
              .select({ id: surfacePanes.id })
              .from(surfacePanes)
              .where(eq(surfacePanes.surfaceId, input.surfaceId))
              .get();
            if (existingPane || decodeSurfaceLayout(surface.layoutJson) !== null)
              return { status: 'surface_not_empty' as const, worktreeId: surface.worktreeId };
            const rejection = input.initialSession
              ? rejectInitialSession(db, surface.worktreeId, input.initialSession)
              : null;
            if (rejection) return { status: 'rejected' as const, reason: rejection, surface };
            const paneId = insertRootPaneRows(db, {
              surfaceId: surface.id,
              title: input.titleBase,
              initialSession: input.initialSession,
            });
            focusSurfaceRows(db, surface.worktreeId, surface.id, paneId);
            return {
              status: 'started' as const,
              worktreeId: surface.worktreeId,
              surfaceId: surface.id,
              paneId,
              title: input.titleBase,
            };
          })
          .pipe(
            Effect.flatMap(
              (result): Effect.Effect<StartSurfacePaneResult> =>
                result.status === 'rejected'
                  ? // A defect for the same reason as `createSinglePaneSurface`'s.
                    Effect.die(
                      new SurfaceRepositoryInitialSessionRejected(
                        result.surface.worktreeId,
                        input.initialSession?.sessionId ?? null,
                        result.reason,
                      ),
                    )
                  : Effect.succeed(result),
            ),
          ),
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
          const layout = decodeSurfaceLayout(surface.layoutJson);
          if (!layout || !layoutContainsPane(layout, input.sourcePaneId)) return null;

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
            .set({ layoutJson: encodeSurfaceLayout(nextLayout), updatedAt: now })
            .where(eq(worktreeSurfaces.id, input.surfaceId))
            .run();
          return { surfaceId: input.surfaceId, paneId: pane.id, title };
        }),
      setSurfaceLayout: (input) =>
        database.use('set_surface_layout', (db) => {
          db.update(worktreeSurfaces)
            .set({ layoutJson: encodeSurfaceLayout(input.layout), updatedAt: timestamp() })
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
          const pane = db
            .select({ id: surfacePanes.id })
            .from(surfacePanes)
            .where(eq(surfacePanes.id, input.paneId))
            .get();
          if (!pane) return 'pane_missing' as const;
          const sessionTable =
            input.sessionKind === 'agent_session' ? agentSessions : terminalSessions;
          const session = db
            .select({ id: sessionTable.id })
            .from(sessionTable)
            .where(eq(sessionTable.id, input.sessionId))
            .get();
          if (!session) return 'session_missing' as const;
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
          return 'claimed' as const;
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

function listSessionsBoundTo(
  artifacts: AgentSessionArtifactsService,
  database: RuntimeDatabaseService,
  ptyColumns: ReturnType<typeof getTableColumns<typeof ptyProcesses>>,
  panes: readonly SurfacePaneRow[],
) {
  const idsOf = (kind: 'agent_session' | 'terminal_session') =>
    panes.flatMap((pane) =>
      pane.sessionKind === kind && pane.sessionId !== null ? [pane.sessionId] : [],
    );
  const agentIds = idsOf('agent_session');
  const terminalIds = idsOf('terminal_session');
  return Effect.gen(function* () {
    const rows = yield* database.use('list_sessions_bound_to_panes', (db) => ({
      agents:
        agentIds.length === 0
          ? []
          : db
              .select({ session: agentSessions, process: ptyColumns })
              .from(agentSessions)
              .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id))
              .where(inArray(agentSessions.id, agentIds))
              .all(),
      terminals:
        terminalIds.length === 0
          ? []
          : db
              .select({ session: terminalSessions, process: ptyColumns })
              .from(terminalSessions)
              .leftJoin(ptyProcesses, eq(terminalSessions.activePtyProcessId, ptyProcesses.id))
              .where(inArray(terminalSessions.id, terminalIds))
              .all()
              .map((row) => terminalSessionRow(row.session, row.process)),
    }));
    return {
      agents: yield* Effect.all(
        rows.agents.map((row) => agentSessionRow(artifacts, row.session, row.process)),
      ),
      terminals: rows.terminals,
    };
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
        readonly paneKinds: PaneSessionKind[];
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

function listEditorContextsForPanes(
  database: RuntimeDatabaseService,
  ptyColumns: ReturnType<typeof getTableColumns<typeof ptyProcesses>>,
  paneIds: readonly number[],
) {
  if (paneIds.length === 0) return Effect.succeed<EditorContextRow[]>([]);
  return database
    .use('list_editor_contexts_for_panes', (db) =>
      db
        .select({ context: editorContexts, process: ptyColumns })
        .from(surfacePanes)
        .innerJoin(editorContexts, eq(surfacePanes.sessionId, editorContexts.id))
        .leftJoin(ptyProcesses, eq(editorContexts.activePtyProcessId, ptyProcesses.id))
        .where(
          and(
            inArray(surfacePanes.id, [...paneIds]),
            eq(surfacePanes.sessionKind, 'editor_context'),
          ),
        )
        .all(),
    )
    .pipe(
      // Decoded outside `database.use` so an impossible persisted row stays a
      // defect instead of being laundered into `DatabaseError`. The sibling
      // readers above map inside `use` because their rows carry no invariants.
      Effect.map((rows) => rows.map((row) => editorContextRow(row.context, row.process))),
    );
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
      // Emits only the two PTY-backed kinds, and that omission is structural
      // rather than an oversight: this inventory feeds boot-eager relaunch and
      // session GC, and an editor context's incarnation is recreated on demand,
      // not restored. Widening the pane-kind enum deliberately does not widen
      // this. Whether editors ever join it is story #8's call.
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

/**
 * The three facts that must hold before a durable entity may be bound to a new
 * pane: it exists, it belongs to the worktree the surface is being created in,
 * and nothing else has placed it. Returns the violated rule, or `null` when the
 * binding is sound.
 */
function rejectInitialSession(
  db: RuntimeDatabaseConnection,
  worktreeId: number,
  initialSession: NonNullable<CreateSinglePaneSurfaceInput['initialSession']>,
): InitialSessionRejectionReason | null {
  const context = db
    .select({ worktreeId: editorContexts.worktreeId })
    .from(editorContexts)
    .where(eq(editorContexts.id, initialSession.sessionId))
    .get();
  if (!context) return 'missing';
  if (context.worktreeId !== worktreeId) return 'foreign_worktree';
  const placement = db
    .select({ id: surfacePanes.id })
    .from(surfacePanes)
    .where(
      and(
        eq(surfacePanes.sessionKind, initialSession.kind),
        eq(surfacePanes.sessionId, initialSession.sessionId),
      ),
    )
    .get();
  return placement ? 'already_placed' : null;
}

/** A surface row with no panes: its layout is JSON `null`. */
function insertEmptySurfaceRow(
  db: RuntimeDatabaseConnection,
  input: { readonly worktreeId: number; readonly titleBase: string },
): CreateEmptySurfaceOutput {
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
      layoutJson: encodeSurfaceLayout(null),
      sortOrder,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: worktreeSurfaces.id })
    .get();
  return { surfaceId: surface.id, title };
}

/** The one pane of a surface that had none, and the leaf layout that places it. */
function insertRootPaneRows(
  db: RuntimeDatabaseConnection,
  input: {
    readonly surfaceId: number;
    readonly title: string;
    readonly initialSession: CreateSinglePaneSurfaceInput['initialSession'];
  },
): number {
  const now = timestamp();
  const pane = db
    .insert(surfacePanes)
    .values({
      surfaceId: input.surfaceId,
      title: input.title,
      sortOrder: 0,
      // Written here rather than by a follow-up update, so the pane is never
      // observable without its binding.
      sessionKind: input.initialSession?.kind ?? null,
      sessionId: input.initialSession?.sessionId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: surfacePanes.id })
    .get();
  db.update(worktreeSurfaces)
    .set({ layoutJson: encodeSurfaceLayout(leafForPane(pane.id)), updatedAt: now })
    .where(eq(worktreeSurfaces.id, input.surfaceId))
    .run();
  return pane.id;
}

function focusSurfaceRows(
  db: RuntimeDatabaseConnection,
  worktreeId: number,
  surfaceId: number,
  paneId: number | null,
) {
  const now = timestamp();
  const focus = db
    .select({ id: worktreeEnvironmentStates.id })
    .from(worktreeEnvironmentStates)
    .where(eq(worktreeEnvironmentStates.worktreeId, worktreeId))
    .get();
  const focusValues = { activeSurfaceId: surfaceId, activePaneId: paneId, updatedAt: now };
  if (focus) {
    db.update(worktreeEnvironmentStates)
      .set(focusValues)
      .where(eq(worktreeEnvironmentStates.id, focus.id))
      .run();
  } else {
    db.insert(worktreeEnvironmentStates)
      .values({ worktreeId, ...focusValues, createdAt: now })
      .run();
  }
}

function deleteTarget(surface: SurfaceRow, panes: readonly SurfacePaneRow[]): SurfaceDeleteTarget {
  return {
    surface,
    panes: panes.map((pane) => ({ pane })),
  };
}

function timestamp() {
  return new Date().toISOString();
}

type RuntimeDatabaseConnection = Parameters<
  Parameters<RuntimeDatabaseService['transaction']>[1]
>[0];
