import { eq, getTableColumns } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { AttentionSource, AttentionState, TerminalAttentionState } from '@isagi/contracts';

import { DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import {
  agentSessions,
  ptyProcesses,
  surfacePanes,
  terminalSessions,
  worktreeSurfaces,
} from '../persistence/schema.js';
import { PtyForegroundState, type PtyForegroundStateService } from '../pty-processes/index.js';
import { deriveAgentSessionState } from '../surfaces/session-status.js';
import type { AgentSessionRow, PtyProcessRow, TerminalSessionRow } from '../surfaces/types.js';
import { deriveLastKnownHarnessAttention } from './harness/attention.js';
import { AgentSessionArtifacts, type AgentSessionHarnessMetadataRead } from './harness/ledger.js';
import { HarnessLedgerObserver } from './harness/observer.service.js';
import type { HarnessObservationProjection } from './harness/projection.js';

export interface AgentSessionAttentionProjectionService {
  readonly reconcileAgentSession: (agentSessionId: number) => Effect.Effect<void>;
  readonly agentSessionAttention: (session: AgentSessionRow) => Effect.Effect<AttentionState>;
  readonly terminalSessionAttention: (session: TerminalSessionRow) => TerminalAttentionState;
  readonly listAttentionSources: Effect.Effect<readonly AttentionSource[], DatabaseError>;
}

export const AgentSessionAttentionProjection =
  Context.GenericTag<AgentSessionAttentionProjectionService>(
    'isagi/AgentSessionAttentionProjection',
  );

export const AgentSessionAttentionProjectionLive = Layer.effect(
  AgentSessionAttentionProjection,
  Effect.gen(function* () {
    const artifacts = yield* AgentSessionArtifacts;
    const foreground = yield* PtyForegroundState;
    const database = yield* RuntimeDatabase;
    const observer = yield* HarnessLedgerObserver;

    const service: AgentSessionAttentionProjectionService = {
      reconcileAgentSession: observer.reconcileAgentSession,
      agentSessionAttention: (session) =>
        Effect.gen(function* () {
          const projection = yield* observer.getProjection(session.id);
          return deriveAgentSessionAttention(session, projection);
        }),
      terminalSessionAttention: (session) => deriveTerminalSessionAttention(session, foreground),
      listAttentionSources: Effect.suspend(() =>
        listAttentionSources(artifacts, database, service),
      ),
    };

    return service;
  }),
);

function listAttentionSources(
  artifacts: import('./harness/ledger.js').AgentSessionArtifactsService,
  database: import('../persistence/index.js').RuntimeDatabaseService,
  attention: Pick<
    AgentSessionAttentionProjectionService,
    'agentSessionAttention' | 'terminalSessionAttention'
  >,
) {
  return Effect.gen(function* () {
    const rows = yield* database.use('list_attention_sources', (db) => {
      const ptyColumns = getTableColumns(ptyProcesses);
      return {
        agents: db
          .select({
            worktreeId: worktreeSurfaces.worktreeId,
            surfaceId: surfacePanes.surfaceId,
            paneId: surfacePanes.id,
            session: agentSessions,
            process: ptyColumns,
          })
          .from(surfacePanes)
          .innerJoin(worktreeSurfaces, eq(surfacePanes.surfaceId, worktreeSurfaces.id))
          .innerJoin(agentSessions, eq(surfacePanes.sessionId, agentSessions.id))
          .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id))
          .where(eq(surfacePanes.sessionKind, 'agent_session'))
          .all(),
        terminals: db
          .select({
            worktreeId: worktreeSurfaces.worktreeId,
            surfaceId: surfacePanes.surfaceId,
            paneId: surfacePanes.id,
            session: terminalSessions,
            process: ptyColumns,
          })
          .from(surfacePanes)
          .innerJoin(worktreeSurfaces, eq(surfacePanes.surfaceId, worktreeSurfaces.id))
          .innerJoin(terminalSessions, eq(surfacePanes.sessionId, terminalSessions.id))
          .leftJoin(ptyProcesses, eq(terminalSessions.activePtyProcessId, ptyProcesses.id))
          .where(eq(surfacePanes.sessionKind, 'terminal_session'))
          .all(),
      };
    });

    const agentSources = yield* Effect.all(
      rows.agents.map((row) =>
        Effect.gen(function* () {
          const session = yield* agentSessionRow(artifacts, row.session, row.process);
          return {
            worktreeId: row.worktreeId,
            surfaceId: row.surfaceId,
            paneId: row.paneId,
            source: { kind: 'agent_session', id: session.id },
            attention: yield* attention.agentSessionAttention(session),
          } satisfies AttentionSource;
        }),
      ),
    );
    const terminalSources = rows.terminals.map((row) => {
      const session = terminalSessionRow(row.session, row.process);
      return {
        worktreeId: row.worktreeId,
        surfaceId: row.surfaceId,
        paneId: row.paneId,
        source: { kind: 'terminal_session', id: session.id },
        attention: attention.terminalSessionAttention(session),
      } satisfies AttentionSource;
    });

    return [...agentSources, ...terminalSources].sort((left, right) =>
      attentionSourceKey(left).localeCompare(attentionSourceKey(right)),
    );
  });
}

function attentionSourceKey(source: AttentionSource) {
  return `${source.source.kind}:${source.source.id}`;
}

function agentSessionRow(
  artifacts: import('./harness/ledger.js').AgentSessionArtifactsService,
  row: typeof agentSessions.$inferSelect,
  process: typeof ptyProcesses.$inferSelect | null,
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
      activePtyProcess: process ? ptyProcessRow(process) : null,
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
  row: typeof terminalSessions.$inferSelect,
  process: typeof ptyProcesses.$inferSelect | null,
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
    activePtyProcess: process ? ptyProcessRow(process) : null,
  };
}

function ptyProcessRow(row: typeof ptyProcesses.$inferSelect): PtyProcessRow {
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

function deriveAgentSessionAttention(
  session: AgentSessionRow,
  projection: HarnessObservationProjection | undefined,
): AttentionState {
  // Attention is a function of the single derived session state shared with the
  // surface projection (`deriveAgentSessionState`), so the rail dot and the pane
  // dot — which read the same runtime sources — can never disagree. Only a
  // genuinely running session reflects live harness activity; every other state
  // is calm (resumable / cleanly stopped) or a genuine error. A stale "waiting"
  // never survives a dead process: a stopped session is idle, and its pane shows
  // a resume prompt rather than nagging from the rail.
  const state = deriveAgentSessionState(session);
  switch (state.status) {
    case 'running':
      return deriveObservedHarnessAttention(session, projection);
    case 'starting':
      // Spinning up, or resumable with no live process yet — calm until it runs.
      return 'idle';
    case 'exited':
      // Cleanly stopped and resumable; the pane's resume prompt carries the action.
      return 'idle';
    case 'killed':
      return killedAgentAttention(session.activePtyProcess);
    case 'failed':
      // Metadata missing/invalid, resume failed, launch failed, process missing or
      // attach failed — a genuine failure the user must recover from.
      return 'error';
  }
}

function deriveObservedHarnessAttention(
  session: AgentSessionRow,
  projection: HarnessObservationProjection | undefined,
): AttentionState {
  const records = session.harnessSessionId
    ? (projection?.recordsByHarnessSessionId.get(session.harnessSessionId) ?? [])
    : [];
  return deriveLastKnownHarnessAttention(session.harness, records);
}

function killedAgentAttention(process: PtyProcessRow | null): AttentionState {
  return process && isBenignKillReason(process.statusReason) ? 'idle' : 'error';
}

// A killed PTY is only "clean" when the stop was deliberate. `user_requested`
// and `runtime_shutdown` are the sole benign reasons in `PtyProcessStatusReason`;
// every failure reason (`backend_unavailable`, `backend_process_missing`,
// `backend_attach_failed`, `backend_launch_failed`, `runtime_ephemeral_lost`)
// and an absent reason are genuine errors and surface as `error`. Kept in one
// place so the agent overlay and terminal derivation never drift, and so a newly
// added kill reason defaults to `error` until someone decides otherwise here.
function isBenignKillReason(statusReason: string | null): boolean {
  return statusReason === 'user_requested' || statusReason === 'runtime_shutdown';
}

function deriveTerminalSessionAttention(
  session: TerminalSessionRow,
  foreground: PtyForegroundStateService,
): TerminalAttentionState {
  const process = session.activePtyProcess;
  if (!session.activePtyProcessId) return 'idle';
  if (!process) return 'error';
  switch (process.status) {
    case 'starting':
      return 'idle';
    case 'running':
      return foreground.isWorking(process.id) ? 'working' : 'idle';
    case 'exited':
      return 'idle';
    case 'killed':
      return isBenignKillReason(process.statusReason) ? 'idle' : 'error';
    case 'failed':
      return 'error';
  }
}
