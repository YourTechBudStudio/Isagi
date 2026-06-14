import { eq, getTableColumns, inArray, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import {
  DatabaseError,
  RuntimeDatabase,
  type RuntimeDatabaseService,
} from '../persistence/index.js';
import {
  ptySessions,
  surfacePanes,
  worktreeEnvironmentStates,
  worktrees,
  worktreeSurfaces,
} from '../persistence/schema.js';
import type { SurfacePaneDeletePlan } from './delete-plan.js';
import type {
  CreatePtySessionMetadataInput,
  CreateSinglePanePtySessionSurfaceInput,
  CreateSinglePanePtySessionSurfaceOutput,
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  DeleteSurfaceRowsOutput,
  EnvironmentFocusRow,
  PtySessionRow,
  RenameSurfaceOutput,
  SurfaceDeleteTarget,
  SurfaceMetadataRow,
  SurfacePaneRow,
  SurfaceRow,
} from './types.js';

type WorktreeSurfaceRecord = InferSelectModel<typeof worktreeSurfaces>;
type SurfacePaneRecord = InferSelectModel<typeof surfacePanes>;
type PtySessionRecord = InferSelectModel<typeof ptySessions>;
type PtySessionRecordWithSurface = PtySessionRecord & {
  readonly surfaceId: number;
};
type EnvironmentFocusRecord = InferSelectModel<typeof worktreeEnvironmentStates>;

export interface SurfaceRepositoryService {
  readonly worktreeExists: (worktreeId: number) => Effect.Effect<boolean, DatabaseError>;
  readonly findSurface: (surfaceId: number) => Effect.Effect<SurfaceRow | null, DatabaseError>;
  readonly findPane: (paneId: number) => Effect.Effect<SurfacePaneRow | null, DatabaseError>;
  readonly findEnvironmentFocus: (
    worktreeId: number,
  ) => Effect.Effect<EnvironmentFocusRow | null, DatabaseError>;
  readonly listWorkspaceSurfaceMetadata: Effect.Effect<SurfaceMetadataRow[], DatabaseError>;
  readonly listEnvironmentFocusStates: Effect.Effect<EnvironmentFocusRow[], DatabaseError>;
  readonly listPanesForSurface: (
    surfaceId: number,
  ) => Effect.Effect<SurfacePaneRow[], DatabaseError>;
  readonly listPtySessionsForPanes: (
    paneIds: readonly number[],
  ) => Effect.Effect<PtySessionRow[], DatabaseError>;
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
  readonly createPtySessionMetadata: (
    input: CreatePtySessionMetadataInput,
  ) => Effect.Effect<number, DatabaseError>;
  readonly createSinglePanePtySessionSurface: (
    input: CreateSinglePanePtySessionSurfaceInput,
  ) => Effect.Effect<CreateSinglePanePtySessionSurfaceOutput, DatabaseError>;
  readonly setEnvironmentFocus: (
    input: EnvironmentFocusRow,
  ) => Effect.Effect<EnvironmentFocusRow, DatabaseError>;
}

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
    const ptySessionColumns = getTableColumns(ptySessions);

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
      findEnvironmentFocus: (worktreeId) =>
        database.use('find_worktree_environment_focus', (db) => {
          const row = db
            .select()
            .from(worktreeEnvironmentStates)
            .where(eq(worktreeEnvironmentStates.worktreeId, worktreeId))
            .get();
          return row ? focusRow(row) : null;
        }),
      listWorkspaceSurfaceMetadata: database.use('list_workspace_surface_metadata', (db) =>
        db
          .select()
          .from(worktreeSurfaces)
          .orderBy(worktreeSurfaces.worktreeId, worktreeSurfaces.sortOrder, worktreeSurfaces.id)
          .all()
          .map(surfaceMetadataRow),
      ),
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
      listPtySessionsForPanes: (paneIds) =>
        database.use('list_pty_sessions_for_panes', (db) => {
          if (paneIds.length === 0) {
            return [];
          }
          return db
            .select({ ...ptySessionColumns, surfaceId: surfacePanes.surfaceId })
            .from(ptySessions)
            .innerJoin(surfacePanes, eq(ptySessions.paneId, surfacePanes.id))
            .where(inArray(ptySessions.paneId, [...paneIds]))
            .all()
            .map(ptySessionRow);
        }),
      findSurfaceDeleteTarget: (surfaceId) =>
        database.use('find_surface_delete_target', (db) => {
          const surface = db
            .select()
            .from(worktreeSurfaces)
            .where(eq(worktreeSurfaces.id, surfaceId))
            .get();
          if (!surface) {
            return null;
          }

          const panes = db
            .select()
            .from(surfacePanes)
            .where(eq(surfacePanes.surfaceId, surfaceId))
            .orderBy(surfacePanes.sortOrder, surfacePanes.id)
            .all()
            .map(paneRow);
          const sessions =
            panes.length === 0
              ? []
              : db
                  .select({
                    ...ptySessionColumns,
                    surfaceId: surfacePanes.surfaceId,
                  })
                  .from(ptySessions)
                  .innerJoin(surfacePanes, eq(ptySessions.paneId, surfacePanes.id))
                  .where(
                    inArray(
                      ptySessions.paneId,
                      panes.map((pane) => pane.id),
                    ),
                  )
                  .all()
                  .map(ptySessionRow);
          const sessionByPaneId = new Map(sessions.map((session) => [session.paneId, session]));

          return {
            surface: surfaceRow(surface),
            panes: panes.map((pane) => ({
              pane,
              ptySession: sessionByPaneId.get(pane.id) ?? null,
            })),
          } satisfies SurfaceDeleteTarget;
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
          if (input.plan.deletedPaneIds.length === 0) {
            return { deletedSurfaceId: null, deletedPaneIds: [] };
          }

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
          if (!deletedPaneId || !input.plan.nextLayout) {
            return { deletedSurfaceId: null, deletedPaneIds: [] };
          }

          const now = timestamp();
          db.update(worktreeSurfaces)
            .set({
              layoutJson: JSON.stringify(input.plan.nextLayout),
              updatedAt: now,
            })
            .where(eq(worktreeSurfaces.id, input.target.surface.id))
            .run();
          db.delete(surfacePanes).where(eq(surfacePanes.id, deletedPaneId)).run();
          return { deletedSurfaceId: null, deletedPaneIds: [deletedPaneId] };
        }),
      createSinglePaneSurface: (input) =>
        database.transaction('create_single_pane_surface', (db) =>
          createSinglePaneSurfaceRows(db, input),
        ),
      createSinglePanePtySessionSurface: (input) =>
        database.transaction('create_single_pane_pty_session_surface', (db) => {
          const worktree = db
            .select()
            .from(worktrees)
            .where(eq(worktrees.id, input.worktreeId))
            .get();
          if (!worktree) {
            throw new SurfaceRepositoryWorktreeMissing(input.worktreeId);
          }

          const now = timestamp();
          const surface = createSinglePaneSurfaceRows(db, input);

          const session = db
            .insert(ptySessions)
            .values({
              paneId: surface.paneId,
              worktreeId: input.worktreeId,
              // Temporary non-null DB invariant. PtyService owns backend selection and
              // overwrites backend/ref/log fields before launching the operational backend.
              backend: 'node_pty',
              backendRefJson: JSON.stringify({
                schemaVersion: 1,
                backend: 'node_pty',
                ptySessionId: 0,
                pid: null,
              }),
              purpose: input.purpose,
              harness: input.harness,
              command: input.command,
              cwd: worktree.path,
              status: 'starting',
              statusReason: null,
              exitCode: null,
              signal: null,
              logMode: 'none',
              logPath: null,
              createdAt: now,
              updatedAt: now,
              exitedAt: null,
              lastSeenAt: null,
            })
            .returning({ id: ptySessions.id })
            .get();
          const ptySessionId = session.id;
          db.update(ptySessions)
            .set({
              backendRefJson: JSON.stringify({
                schemaVersion: 1,
                backend: 'node_pty',
                ptySessionId,
                pid: null,
              }),
              updatedAt: now,
            })
            .where(eq(ptySessions.id, ptySessionId))
            .run();

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
              .values({
                worktreeId: input.worktreeId,
                ...focusValues,
                createdAt: now,
              })
              .run();
          }

          return {
            worktreeId: input.worktreeId,
            surfaceId: surface.surfaceId,
            paneId: surface.paneId,
            ptySessionId,
            command: input.command,
            cwd: worktree.path,
            logPath: null,
          } satisfies CreateSinglePanePtySessionSurfaceOutput;
        }),
      createPtySessionMetadata: (input) =>
        database.use('create_pty_session_metadata', (db) => {
          const now = timestamp();
          const pane = db
            .select({ worktreeId: worktreeSurfaces.worktreeId })
            .from(surfacePanes)
            .innerJoin(worktreeSurfaces, eq(surfacePanes.surfaceId, worktreeSurfaces.id))
            .where(eq(surfacePanes.id, input.paneId))
            .get();

          if (!pane) {
            throw new Error(`Cannot create PTY session metadata for missing pane ${input.paneId}.`);
          }

          const row = db
            .insert(ptySessions)
            .values({
              paneId: input.paneId,
              worktreeId: pane.worktreeId,
              backend: input.backend,
              backendRefJson: input.backendRefJson,
              purpose: input.purpose,
              harness: input.harness,
              command: input.command,
              cwd: input.cwd,
              status: input.status,
              statusReason: input.statusReason ?? null,
              exitCode: input.exitCode ?? null,
              signal: input.signal ?? null,
              logMode: input.logMode,
              logPath: input.logPath,
              createdAt: now,
              updatedAt: now,
              exitedAt: input.exitedAt ?? null,
              lastSeenAt: input.lastSeenAt ?? null,
            })
            .returning({ id: ptySessions.id })
            .get();
          return row.id;
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
              .values({
                worktreeId: input.worktreeId,
                ...values,
                createdAt: now,
              })
              .run();
          }
          return input;
        }),
    } satisfies SurfaceRepositoryService;
  }),
);

export function duplicateSafeTitle(titleBase: string, existingTitles: readonly string[]) {
  const used = new Set(existingTitles);
  if (!used.has(titleBase)) {
    return titleBase;
  }
  let suffix = 2;
  while (used.has(`${titleBase} ${suffix}`)) {
    suffix += 1;
  }
  return `${titleBase} ${suffix}`;
}

function createSinglePaneSurfaceRows(
  db: RuntimeDatabaseConnection,
  input: CreateSinglePaneSurfaceInput,
): CreateSinglePaneSurfaceOutput {
  const now = timestamp();
  const existingSurfaces = db
    .select({
      title: worktreeSurfaces.title,
      sortOrder: worktreeSurfaces.sortOrder,
    })
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
      kind: input.kind,
      title,
      attention: 'idle',
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
      attention: 'idle',
      sortOrder: 0,
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

function surfaceMetadataRow(row: WorktreeSurfaceRecord): SurfaceMetadataRow {
  return {
    id: row.id,
    worktreeId: row.worktreeId,
    kind: row.kind,
    title: row.title,
    attention: row.attention,
    sortOrder: row.sortOrder,
  };
}

function surfaceRow(row: WorktreeSurfaceRecord): SurfaceRow {
  return {
    ...surfaceMetadataRow(row),
    layoutJson: row.layoutJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function paneRow(row: SurfacePaneRecord): SurfacePaneRow {
  return {
    id: row.id,
    surfaceId: row.surfaceId,
    title: row.title,
    attention: row.attention,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ptySessionRow(row: PtySessionRecordWithSurface): PtySessionRow {
  return {
    id: row.id,
    paneId: row.paneId,
    surfaceId: row.surfaceId,
    worktreeId: row.worktreeId,
    backend: row.backend,
    backendRefJson: row.backendRefJson,
    purpose: row.purpose,
    harness: row.harness,
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    statusReason: row.statusReason,
    exitCode: row.exitCode,
    signal: row.signal,
    logMode: row.logMode,
    logPath: row.logPath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    exitedAt: row.exitedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function focusRow(row: EnvironmentFocusRecord): EnvironmentFocusRow {
  return {
    worktreeId: row.worktreeId,
    activeSurfaceId: row.activeSurfaceId,
    activePaneId: row.activePaneId,
  };
}

function timestamp() {
  return new Date().toISOString();
}

type RuntimeDatabaseConnection = Parameters<
  Parameters<RuntimeDatabaseService['transaction']>[1]
>[0];
