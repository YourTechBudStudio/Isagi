import { eq, getTableColumns } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { AttentionSource, AttentionState, TerminalAttentionState } from '@isagi/contracts';

import { AgentSessionArtifacts, HarnessLedgerObserver } from '../../harnesses/index.js';
import { DatabaseError, RuntimeDatabase } from '../../platform/persistence/index.js';
import { PtyForegroundState, type PtyProcessRow } from '../../pty-processes/index.js';
import { ptyProcesses } from '../../pty-processes/tables.js';
import { agentSessionRow, terminalSessionRow } from '../sessions/row-mappers.js';
import { deriveAgentSessionState } from '../sessions/status.js';
import type { AgentSessionRow, TerminalSessionRow } from '../sessions/types.js';
import { agentSessions, surfacePanes, terminalSessions, worktreeSurfaces } from '../tables.js';

const make = Effect.gen(function* () {
  const artifacts = yield* AgentSessionArtifacts;
  const foreground = yield* PtyForegroundState;
  const database = yield* RuntimeDatabase;
  const observer = yield* HarnessLedgerObserver;

  const service = AgentSessionAttentionProjection.of({
    // Runs once per agent row on every attention read: untraced.
    agentSessionAttention: Effect.fnUntraced(function* (session) {
      const harnessAttention = yield* observer.getAttention(session.id);
      return deriveAgentSessionAttention(session, harnessAttention ?? 'idle');
    }),
    terminalSessionAttention: (session) => deriveTerminalSessionAttention(session, foreground),
    listAttentionSources: Effect.suspend(() =>
      listAttentionSources(artifacts, database, service),
    ).pipe(Effect.withSpan('AgentSessionAttentionProjection.listAttentionSources')),
    workingAgentCount: Effect.suspend(() => workingAgentCount(artifacts, database, service)).pipe(
      Effect.withSpan('AgentSessionAttentionProjection.workingAgentCount'),
    ),
  });
  return service;
});

export class AgentSessionAttentionProjection extends Context.Service<
  AgentSessionAttentionProjection,
  {
    readonly agentSessionAttention: (session: AgentSessionRow) => Effect.Effect<AttentionState>;
    readonly terminalSessionAttention: (session: TerminalSessionRow) => TerminalAttentionState;
    readonly listAttentionSources: Effect.Effect<readonly AttentionSource[], DatabaseError>;
    readonly workingAgentCount: Effect.Effect<number, DatabaseError>;
  }
>()('isagi/runtime/environment/AgentSessionAttentionProjection') {
  static readonly layerNoDeps = Layer.effect(AgentSessionAttentionProjection, make);
  static readonly layer = AgentSessionAttentionProjection.layerNoDeps.pipe(
    Layer.provide([
      AgentSessionArtifacts.layer,
      HarnessLedgerObserver.layer,
      PtyForegroundState.layer,
    ]),
  );
}

function workingAgentCount(
  artifacts: AgentSessionArtifacts['Service'],
  database: RuntimeDatabase['Service'],
  attention: Pick<AgentSessionAttentionProjection['Service'], 'agentSessionAttention'>,
) {
  return Effect.gen(function* () {
    const rows = yield* database.use('working_agent_count', (db) =>
      db
        .select({ session: agentSessions, process: ptyProcesses })
        .from(agentSessions)
        .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id))
        .all(),
    );
    const states = yield* Effect.all(
      rows.map((row) =>
        Effect.flatMap(
          agentSessionRow(artifacts, row.session, row.process),
          attention.agentSessionAttention,
        ),
      ),
    );
    return states.filter((state) => state === 'working').length;
  });
}

function listAttentionSources(
  artifacts: AgentSessionArtifacts['Service'],
  database: RuntimeDatabase['Service'],
  attention: Pick<
    AgentSessionAttentionProjection['Service'],
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

function deriveAgentSessionAttention(
  session: AgentSessionRow,
  harnessAttention: AttentionState,
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
      return harnessAttention;
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
  foreground: PtyForegroundState['Service'],
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
