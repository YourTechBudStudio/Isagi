import { join } from 'node:path';

import { eq, inArray, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import {
  DataDirectory,
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
import type {
  CreatePtySessionMetadataInput,
  CreateSinglePanePtySessionSurfaceInput,
  CreateSinglePanePtySessionSurfaceOutput,
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  EnvironmentFocusRow,
  PtySessionRow,
  SurfaceMetadataRow,
  SurfacePaneRow,
  SurfaceRow,
} from './types.js';

type WorktreeSurfaceRecord = InferSelectModel<typeof worktreeSurfaces>;
type SurfacePaneRecord = InferSelectModel<typeof surfacePanes>;
type PtySessionRecord = InferSelectModel<typeof ptySessions>;
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
    const directory = yield* DataDirectory;

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
            .select()
            .from(ptySessions)
            .where(inArray(ptySessions.paneId, [...paneIds]))
            .all()
            .map(ptySessionRow);
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
              adapter: 'node_pty',
              purpose: input.purpose,
              harness: input.harness,
              command: input.command,
              cwd: worktree.path,
              status: 'starting',
              exitCode: null,
              signal: null,
              logPath: '',
              logBytes: 0,
              createdAt: now,
              updatedAt: now,
              exitedAt: null,
            })
            .returning({ id: ptySessions.id })
            .get();
          const logPath = join(directory.paths.sessionsPath, `${session.id}.ptylog`);
          db.update(ptySessions)
            .set({ logPath, updatedAt: now })
            .where(eq(ptySessions.id, session.id))
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
              .values({ worktreeId: input.worktreeId, ...focusValues, createdAt: now })
              .run();
          }

          return {
            worktreeId: input.worktreeId,
            surfaceId: surface.surfaceId,
            paneId: surface.paneId,
            ptySessionId: session.id,
            command: input.command,
            cwd: worktree.path,
            logPath,
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
              adapter: input.adapter,
              purpose: input.purpose,
              harness: input.harness,
              command: input.command,
              cwd: input.cwd,
              status: input.status,
              exitCode: input.exitCode ?? null,
              signal: input.signal ?? null,
              logPath: input.logPath,
              logBytes: input.logBytes ?? 0,
              createdAt: now,
              updatedAt: now,
              exitedAt: input.exitedAt ?? null,
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

function ptySessionRow(row: PtySessionRecord): PtySessionRow {
  return {
    id: row.id,
    paneId: row.paneId,
    worktreeId: row.worktreeId,
    adapter: row.adapter,
    purpose: row.purpose,
    harness: row.harness,
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    exitCode: row.exitCode,
    signal: row.signal,
    logPath: row.logPath,
    logBytes: row.logBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    exitedAt: row.exitedAt,
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
