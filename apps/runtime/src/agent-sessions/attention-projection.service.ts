import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { and, eq, isNotNull, or } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { AttentionState } from '@isagi/contracts';

import { DataDirectory, RuntimeDatabase } from '../persistence/index.js';
import { agentSessions, surfacePanes } from '../persistence/schema.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';
import type { AgentSessionRow, TerminalSessionRow } from '../surfaces/types.js';
import { AgentSessionArtifacts } from './artifacts.js';
import { deriveOpenCodeRunningAttention } from './harness-observation/opencode.js';
import { derivePiRunningAttention } from './harness-observation/pi.js';
import {
  buildHarnessObservationProjection,
  emptyHarnessObservationProjection,
  type HarnessObservationProjection,
} from './harness-observation/projection.js';

export interface AgentSessionAttentionProjectionService {
  readonly reconcileAgentSession: (agentSessionId: number) => Effect.Effect<void>;
  readonly agentSessionAttention: (session: AgentSessionRow) => Effect.Effect<AttentionState>;
  readonly terminalSessionAttention: (session: TerminalSessionRow) => AttentionState;
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
    const watchers = new Map<number | 'root', FSWatcher>();
    const timers = new Map<number | 'root', NodeJS.Timeout>();

    mkdirSync(root, { recursive: true });

    const reconcileAgentSession = (agentSessionId: number) =>
      Effect.gen(function* () {
        const previous = projections.get(agentSessionId)?.fingerprint ?? null;
        const projection = yield* readProjection(artifacts, agentSessionId).pipe(
          Effect.orElseSucceed(() => emptyHarnessObservationProjection()),
        );
        projections.set(agentSessionId, projection);
        if (previous !== null && previous !== projection.fingerprint) {
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

    const scheduleRootScan = () => {
      schedule('root', () => {
        void Effect.runPromise(reconcileKnownAgentSessions);
      });
    };

    const scheduleAgentScan = (agentSessionId: number) => {
      schedule(agentSessionId, () => {
        void Effect.runPromise(reconcileAgentSession(agentSessionId));
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

    const service = {
      reconcileAgentSession,
      agentSessionAttention: (session) =>
        Effect.gen(function* () {
          if (!projections.has(session.id)) {
            yield* reconcileAgentSession(session.id);
          }
          return deriveAgentSessionAttention(session, projections.get(session.id));
        }),
      terminalSessionAttention: deriveTerminalSessionAttention,
    } satisfies AgentSessionAttentionProjectionService;

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

function readProjection(
  artifacts: import('./artifacts.js').AgentSessionArtifactsService,
  agentSessionId: number,
) {
  return Effect.gen(function* () {
    const jsonlReads = yield* artifacts.readJsonlForAgentSession(agentSessionId);
    return buildHarnessObservationProjection(jsonlReads);
  });
}

function deriveAgentSessionAttention(
  session: AgentSessionRow,
  projection: HarnessObservationProjection | undefined,
): AttentionState {
  if (session.harnessMetadataStatus === 'missing' || session.harnessMetadataStatus === 'invalid') {
    return 'error';
  }
  const process = session.activePtyProcess;
  if (!session.activePtyProcessId) return 'idle';
  if (!process) return 'error';
  switch (process.status) {
    case 'failed':
      return 'error';
    case 'exited':
      return 'idle';
    case 'killed':
      return process.statusReason === 'user_requested' ||
        process.statusReason === 'runtime_shutdown'
        ? 'idle'
        : 'error';
    case 'starting':
      return 'idle';
    case 'running': {
      const records = projection?.recordsByPtyProcessId.get(session.activePtyProcessId) ?? [];
      if (session.harness === 'pi') return derivePiRunningAttention(records);
      if (session.harness === 'opencode') return deriveOpenCodeRunningAttention(records);
      return 'idle';
    }
  }
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
      return process.statusReason === 'user_requested' ||
        process.statusReason === 'runtime_shutdown'
        ? 'idle'
        : 'error';
    case 'failed':
      return 'error';
  }
}
