import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { and, eq, getTableColumns, isNotNull, or } from 'drizzle-orm';
import { Cause, Context, Effect, Layer } from 'effect';

import type { AttentionSource, AttentionState } from '@isagi/contracts';

import { DataDirectory, DatabaseError, RuntimeDatabase } from '../persistence/index.js';
import {
  agentSessions,
  ptyProcesses,
  surfacePanes,
  terminalSessions,
  worktreeSurfaces,
} from '../persistence/schema.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import type { AgentSessionRow, PtyProcessRow, TerminalSessionRow } from '../surfaces/types.js';
import { AgentSessionArtifacts, type AgentSessionHarnessMetadataRead } from './artifacts.js';
import { deriveLastKnownHarnessAttention } from './harness-observation/attention.js';
import {
  buildHarnessObservationProjection,
  emptyHarnessObservationProjection,
  type HarnessObservationProjection,
} from './harness-observation/projection.js';

export interface AgentSessionAttentionProjectionService {
  readonly reconcileAgentSession: (agentSessionId: number) => Effect.Effect<void>;
  readonly agentSessionAttention: (session: AgentSessionRow) => Effect.Effect<AttentionState>;
  readonly terminalSessionAttention: (session: TerminalSessionRow) => AttentionState;
  readonly listAttentionSources: Effect.Effect<readonly AttentionSource[], DatabaseError>;
}

export const AgentSessionAttentionProjection =
  Context.GenericTag<AgentSessionAttentionProjectionService>(
    'isagi/AgentSessionAttentionProjection',
  );

export const AgentSessionAttentionProjectionLive = Layer.scoped(
  AgentSessionAttentionProjection,
  Effect.gen(function* () {
    const artifacts = yield* AgentSessionArtifacts;
    const eventBus = yield* InternalRuntimeEventBus;
    const dataDirectory = yield* DataDirectory;
    const database = yield* RuntimeDatabase;
    const root = join(dataDirectory.paths.sessionsPath, 'agent-sessions');
    const projections = new Map<number, HarnessObservationProjection>();
    const artifactFingerprints = new Map<number, string>();
    const watchers = new Map<number | 'root', FSWatcher>();
    const timers = new Map<number | 'root', NodeJS.Timeout>();

    mkdirSync(root, { recursive: true });

    const reconcileAgentSession = (agentSessionId: number) =>
      Effect.gen(function* () {
        // `projections` and `artifactFingerprints` are always written together
        // below, so a cache miss implies `previous === null`. That makes the
        // read path (`agentSessionAttention` reconciling on a miss) publish-free
        // by construction: only a watcher-driven reconcile of an already-known
        // session can flip the fingerprint and emit an event.
        const previous = artifactFingerprints.get(agentSessionId) ?? null;
        const metadata = yield* artifacts.readMetadata(agentSessionId);
        const projection = yield* readProjection(artifacts, agentSessionId).pipe(
          // A missing directory is already mapped to an empty projection inside
          // the artifact reader; reaching here means a genuine read failure
          // (e.g. permissions). Fall back to empty so attention stays derivable,
          // but leave a breadcrumb so a stuck dot is diagnosable.
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.warn(
                `[runtime] attention projection could not read harness logs for agent session ${agentSessionId}`,
                error,
              );
              return emptyHarnessObservationProjection();
            }),
          ),
        );
        const fingerprint = JSON.stringify([
          metadataProjectionFingerprint(metadata),
          projection.fingerprint,
        ]);
        projections.set(agentSessionId, projection);
        artifactFingerprints.set(agentSessionId, fingerprint);
        if (previous !== null && previous !== fingerprint) {
          yield* eventBus.publish({ type: 'agent_session_changed', agentSessionId });
        }
      });

    const reconcileKnownAgentSessions = Effect.gen(function* () {
      const artifactAgentSessionIds = yield* artifacts.listAgentSessionIds.pipe(
        Effect.orElseSucceed(() => []),
      );
      const relevantAgentSessionIds = yield* listRelevantAgentSessionIds(database).pipe(
        Effect.orElseSucceed(() => []),
      );
      const agentSessionIds = [
        ...new Set([...artifactAgentSessionIds, ...relevantAgentSessionIds]),
      ];
      for (const agentSessionId of agentSessionIds) {
        ensureAgentWatcher(agentSessionId);
        yield* reconcileAgentSession(agentSessionId);
      }
    });

    // These scans are fired detached from any request fiber and outside the
    // layer scope, so a failure or defect would otherwise vanish into a
    // discarded promise. Log the full cause before discarding so silently
    // stalled attention is traceable (extends the PTY GC timer pattern to also
    // capture defects and interruptions, not just typed failures).
    const runDetachedScan = (label: string, scan: Effect.Effect<void>) => {
      void Effect.runPromise(
        scan.pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              console.warn(
                `[runtime] attention reconciliation failed (${label})`,
                Cause.pretty(cause),
              );
            }),
          ),
        ),
      );
    };

    const scheduleRootScan = () => {
      schedule('root', () => {
        runDetachedScan('root scan', reconcileKnownAgentSessions);
      });
    };

    const scheduleAgentScan = (agentSessionId: number) => {
      schedule(agentSessionId, () => {
        runDetachedScan(`agent session ${agentSessionId}`, reconcileAgentSession(agentSessionId));
      });
    };

    const schedule = (key: number | 'root', callback: () => void) => {
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        timers.delete(key);
        callback();
      }, 75);
      timer.unref();
      timers.set(key, timer);
    };

    const ensureRootWatcher = () => {
      if (watchers.has('root')) return;
      const rootWatcher = watch(root, () => scheduleRootScan());
      watchers.set('root', rootWatcher);
    };

    const ensureAgentWatcher = (agentSessionId: number) => {
      if (watchers.has(agentSessionId)) return;
      const directory = artifacts.paths({ agentSessionId }).directory;
      try {
        watchers.set(
          agentSessionId,
          watch(directory, () => scheduleAgentScan(agentSessionId)),
        );
      } catch {
        // The startup/root scan remains the source of reconciliation if a watch
        // cannot be attached for a just-deleted or unavailable directory.
      }
    };

    yield* reconcileKnownAgentSessions;
    ensureRootWatcher();

    const service: AgentSessionAttentionProjectionService = {
      reconcileAgentSession,
      agentSessionAttention: (session) =>
        Effect.gen(function* () {
          if (!projections.has(session.id)) {
            yield* reconcileAgentSession(session.id);
          }
          return deriveAgentSessionAttention(session, projections.get(session.id));
        }),
      terminalSessionAttention: deriveTerminalSessionAttention,
      listAttentionSources: Effect.suspend(() =>
        listAttentionSources(artifacts, database, service),
      ),
    };

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.sync(() => {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        for (const watcher of watchers.values()) watcher.close();
        watchers.clear();
      }),
    );
  }),
);

function listRelevantAgentSessionIds(
  database: import('../persistence/index.js').RuntimeDatabaseService,
) {
  return database.use('list_attention_relevant_agent_sessions', (db) =>
    db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .leftJoin(
        surfacePanes,
        and(
          eq(surfacePanes.sessionKind, 'agent_session'),
          eq(surfacePanes.sessionId, agentSessions.id),
        ),
      )
      .where(or(isNotNull(agentSessions.activePtyProcessId), isNotNull(surfacePanes.id)))
      .all()
      .map((row) => row.id),
  );
}

function metadataProjectionFingerprint(metadata: AgentSessionHarnessMetadataRead) {
  switch (metadata.status) {
    case 'valid':
      return ['valid', metadata.metadata.harnessSessionId] as const;
    case 'missing':
      return ['missing'] as const;
    case 'invalid':
      return ['invalid', metadata.diagnostic] as const;
  }
}

function listAttentionSources(
  artifacts: import('./artifacts.js').AgentSessionArtifactsService,
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

function readProjection(
  artifacts: import('./artifacts.js').AgentSessionArtifactsService,
  agentSessionId: number,
) {
  return Effect.gen(function* () {
    const jsonlReads = yield* artifacts.readJsonlForAgentSession(agentSessionId);
    return buildHarnessObservationProjection(jsonlReads);
  });
}

function agentSessionRow(
  artifacts: import('./artifacts.js').AgentSessionArtifactsService,
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
  if (session.harnessMetadataStatus === 'missing' || session.harnessMetadataStatus === 'invalid') {
    return 'error';
  }
  const observed = deriveObservedHarnessAttention(session, projection);
  return applyAgentProcessOverlay(session, observed);
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

function applyAgentProcessOverlay(
  session: AgentSessionRow,
  observed: AttentionState,
): AttentionState {
  if (observed === 'error') return 'error';
  const process = session.activePtyProcess;
  if (!session.activePtyProcessId) return overlayMissingOrDeadProcess(null, observed);
  if (!process) return overlayMissingOrDeadProcess('missing', observed);
  switch (process.status) {
    case 'starting':
    case 'running':
      return observed;
    case 'exited':
      return overlayMissingOrDeadProcess('exited', observed);
    case 'killed':
      return overlayKilledProcess(process.statusReason, observed);
    case 'failed':
      return overlayMissingOrDeadProcess('failed', observed);
  }
}

function overlayMissingOrDeadProcess(
  reason: 'missing' | 'exited' | 'failed' | null,
  observed: AttentionState,
): AttentionState {
  if (observed === 'working') return 'error';
  if (observed === 'waiting') return 'waiting';
  if (reason === 'missing' || reason === 'failed') return 'error';
  return 'idle';
}

function overlayKilledProcess(
  statusReason: string | null,
  observed: AttentionState,
): AttentionState {
  if (observed === 'working') return 'error';
  if (observed === 'waiting') return 'waiting';
  return isBenignKillReason(statusReason) ? 'idle' : 'error';
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

function deriveTerminalSessionAttention(session: TerminalSessionRow): AttentionState {
  const process = session.activePtyProcess;
  if (!session.activePtyProcessId) return 'idle';
  if (!process) return 'error';
  switch (process.status) {
    case 'starting':
    case 'running':
      return 'working';
    case 'exited':
      return 'idle';
    case 'killed':
      return isBenignKillReason(process.statusReason) ? 'idle' : 'error';
    case 'failed':
      return 'error';
  }
}
