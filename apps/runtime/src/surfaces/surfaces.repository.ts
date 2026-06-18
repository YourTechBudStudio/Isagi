import { and, eq, getTableColumns, inArray, type InferSelectModel } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { AttentionState } from '@isagi/contracts';

import {
  AgentSessionArtifacts,
  type AgentSessionArtifactsService,
  type AgentSessionHarnessMetadataRead,
} from '../agent-sessions/artifacts.js';
import {
  AgentSessionAttentionProjection,
  type AgentSessionAttentionProjectionService,
} from '../agent-sessions/index.js';
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
import type {
  AgentSessionRow,
  CreateSinglePaneSurfaceInput,
  CreateSinglePaneSurfaceOutput,
  DeleteSurfaceRowsOutput,
  EnvironmentFocusRow,
  PtyProcessRow,
  RenameSurfaceOutput,
  SurfaceDeleteTarget,
  SurfaceMetadataRow,
  SurfacePaneRow,
  SurfaceRow,
  TerminalSessionRow,
} from './types.js';

type WorktreeSurfaceRecord = InferSelectModel<typeof worktreeSurfaces>;
type SurfacePaneRecord = InferSelectModel<typeof surfacePanes>;
type PtyProcessRecord = InferSelectModel<typeof ptyProcesses>;
type AgentSessionRecord = InferSelectModel<typeof agentSessions>;
type TerminalSessionRecord = InferSelectModel<typeof terminalSessions>;
type EnvironmentFocusRecord = InferSelectModel<typeof worktreeEnvironmentStates>;

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
    const artifacts = yield* AgentSessionArtifacts;
    const attention = yield* AgentSessionAttentionProjection;
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
      listWorkspaceSurfaceMetadata: listWorkspaceSurfaceMetadata(attention, artifacts, database),
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
    } satisfies SurfaceRepositoryService;
  }),
);

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

function listWorkspaceSurfaceMetadata(
  attention: AgentSessionAttentionProjectionService,
  artifacts: AgentSessionArtifactsService,
  database: RuntimeDatabaseService,
): Effect.Effect<SurfaceMetadataRow[], DatabaseError> {
  return Effect.gen(function* () {
    const rows = yield* database.use('list_workspace_surface_metadata_rows', (db) => ({
      surfaces: db
        .select()
        .from(worktreeSurfaces)
        .orderBy(worktreeSurfaces.worktreeId, worktreeSurfaces.sortOrder, worktreeSurfaces.id)
        .all(),
      panes: db.select().from(surfacePanes).all(),
    }));
    const panes = rows.panes.map(paneRow);
    const paneIds = panes.map((pane) => pane.id);
    const ptyColumns = getTableColumns(ptyProcesses);
    const [agentRows, terminalRows] = yield* Effect.all([
      listAgentSessionsForPanes(artifacts, database, ptyColumns, paneIds),
      listTerminalSessionsForPanes(database, ptyColumns, paneIds),
    ]);
    const paneAttention = yield* paneAttentionMap(attention, panes, agentRows, terminalRows);
    return rows.surfaces.map((surface) =>
      surfaceMetadataRow(
        surface,
        aggregateAttention(
          panes
            .filter((pane) => pane.surfaceId === surface.id)
            .map((pane) => paneAttention.get(pane.id) ?? 'idle'),
        ),
      ),
    );
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
      kind: input.kind,
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

function surfaceMetadataRow(
  row: WorktreeSurfaceRecord,
  attention: AttentionState = 'idle',
): SurfaceMetadataRow {
  return {
    id: row.id,
    worktreeId: row.worktreeId,
    kind: row.kind,
    title: row.title,
    attention,
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
    sortOrder: row.sortOrder,
    sessionKind: row.sessionKind,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function paneAttentionMap(
  attention: AgentSessionAttentionProjectionService,
  panes: readonly SurfacePaneRow[],
  agentRows: readonly AgentSessionRow[],
  terminalRows: readonly TerminalSessionRow[],
) {
  return Effect.gen(function* () {
    const entries = yield* Effect.all(
      panes.map((pane) =>
        Effect.gen(function* () {
          if (pane.sessionKind === 'agent_session' && pane.sessionId !== null) {
            const agent = agentRows.find((candidate) => candidate.id === pane.sessionId);
            return [
              pane.id,
              agent ? yield* attention.agentSessionAttention(agent) : 'error',
            ] as const;
          }
          if (pane.sessionKind === 'terminal_session' && pane.sessionId !== null) {
            const terminal = terminalRows.find((candidate) => candidate.id === pane.sessionId);
            return [
              pane.id,
              terminal ? attention.terminalSessionAttention(terminal) : 'error',
            ] as const;
          }
          return [pane.id, 'idle'] as const;
        }),
      ),
    );
    return new Map(entries);
  });
}

function aggregateAttention(attentions: readonly AttentionState[]): AttentionState {
  if (attentions.includes('error')) return 'error';
  if (attentions.includes('waiting')) return 'waiting';
  if (attentions.includes('working')) return 'working';
  return 'idle';
}
function ptyProcessRow(row: PtyProcessRecord | null): PtyProcessRow | null {
  if (!row) return null;
  return {
    id: row.id,
    backend: row.backend,
    backendRefJson: row.backendRefJson,
    command: row.command,
    args: decodeArgs(row.argsJson),
    argsJson: row.argsJson,
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
function agentSessionRow(
  artifacts: AgentSessionArtifactsService,
  row: AgentSessionRecord,
  process: PtyProcessRecord | null,
): Effect.Effect<AgentSessionRow> {
  return Effect.gen(function* () {
    const metadata = yield* artifacts.readMetadata(row.id);
    return {
      ...agentMetadataFields(metadata),
      id: row.id,
      worktreeId: row.worktreeId,
      harness: row.harness,
      cwd: row.cwd,
      activePtyProcessId: row.activePtyProcessId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastSeenAt: row.lastSeenAt,
      activePtyProcess: ptyProcessRow(process),
    };
  });
}

function agentMetadataFields(metadata: AgentSessionHarnessMetadataRead) {
  switch (metadata.status) {
    case 'valid':
      return {
        harnessSessionId: metadata.metadata.harnessSessionId,
        harnessMetadataStatus: 'valid' as const,
        harnessMetadataDiagnostic: null,
      };
    case 'missing':
      return {
        harnessSessionId: null,
        harnessMetadataStatus: 'missing' as const,
        harnessMetadataDiagnostic: `Harness metadata file is missing: ${metadata.metadataPath}`,
      };
    case 'invalid':
      return {
        harnessSessionId: null,
        harnessMetadataStatus: 'invalid' as const,
        harnessMetadataDiagnostic: metadata.diagnostic,
      };
  }
}
function terminalSessionRow(
  row: TerminalSessionRecord,
  process: PtyProcessRecord | null,
): TerminalSessionRow {
  return {
    id: row.id,
    worktreeId: row.worktreeId,
    cwd: row.cwd,
    shellCommand: row.shellCommand,
    shellArgs: decodeArgs(row.shellArgsJson),
    shellArgsJson: row.shellArgsJson,
    activePtyProcessId: row.activePtyProcessId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    activePtyProcess: ptyProcessRow(process),
  };
}
function focusRow(row: EnvironmentFocusRecord): EnvironmentFocusRow {
  return {
    worktreeId: row.worktreeId,
    activeSurfaceId: row.activeSurfaceId,
    activePaneId: row.activePaneId,
  };
}
function decodeArgs(json: string) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}
function timestamp() {
  return new Date().toISOString();
}

type RuntimeDatabaseConnection = Parameters<
  Parameters<RuntimeDatabaseService['transaction']>[1]
>[0];
