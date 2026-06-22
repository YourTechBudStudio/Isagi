import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { and, eq, isNotNull, or } from 'drizzle-orm';
import { Cause, Context, Effect, Layer } from 'effect';

import { DataDirectory, RuntimeDatabase } from '../../persistence/index.js';
import { agentSessions, surfacePanes } from '../../persistence/schema.js';
import { InternalRuntimeEventBus } from '../../runtime-events/index.js';
import {
  AgentSessionArtifacts,
  type AgentSessionArtifactsService,
  type AgentSessionHarnessMetadataRead,
} from './ledger.js';
import {
  buildHarnessObservationProjection,
  emptyHarnessObservationProjection,
  type HarnessObservationProjection,
  type HarnessObservationRecord,
} from './projection.js';
import { deriveHarnessTurnEdges, type HarnessTurnEdge } from './turns.js';

export interface HarnessLedgerObserverService {
  readonly reconcileAgentSession: (agentSessionId: number) => Effect.Effect<void>;
  readonly getProjection: (
    agentSessionId: number,
  ) => Effect.Effect<HarnessObservationProjection | undefined>;
}

export const HarnessLedgerObserver = Context.GenericTag<HarnessLedgerObserverService>(
  'isagi/HarnessLedgerObserver',
);

export const HarnessLedgerObserverLive = Layer.scoped(
  HarnessLedgerObserver,
  Effect.gen(function* () {
    const artifacts = yield* AgentSessionArtifacts;
    const eventBus = yield* InternalRuntimeEventBus;
    const dataDirectory = yield* DataDirectory;
    const database = yield* RuntimeDatabase;
    const root = join(dataDirectory.paths.sessionsPath, 'agent-sessions');
    const projections = new Map<number, HarnessObservationProjection>();
    const artifactFingerprints = new Map<number, string>();
    const turnStatuses = new Map<number, AgentSessionTurnStatuses>();
    const deadPtys = new Set<number>();
    const watchers = new Map<number | 'root', FSWatcher>();
    const timers = new Map<number | 'root', NodeJS.Timeout>();
    const reconcileSemaphore = yield* Effect.makeSemaphore(1);

    mkdirSync(root, { recursive: true });

    const reconcileAgentSession = (agentSessionId: number) =>
      reconcileSemaphore.withPermits(1)(reconcileAgentSessionUnlocked(agentSessionId));

    const reconcileAgentSessionUnlocked = (agentSessionId: number) =>
      Effect.gen(function* () {
        // `projections` and `artifactFingerprints` are always written together
        // below, so a cache miss implies `previous === null`. That makes the
        // read path (`getProjection` reconciling on a miss) publish-free by
        // construction: only a watcher-driven reconcile of an already-known
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
        yield* reconcileTurnEdges({
          agentSessionId,
          projection,
          turnStatuses,
          deadPtys,
          eventBus,
        });
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
    const ptyDeathSubscription = yield* eventBus.subscribe({
      types: ['pty_process_exited', 'pty_process_failed', 'pty_process_killed'],
    });
    yield* Effect.addFinalizer(() => ptyDeathSubscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* ptyDeathSubscription.take;
          if (
            event.type !== 'pty_process_exited' &&
            event.type !== 'pty_process_failed' &&
            event.type !== 'pty_process_killed'
          ) {
            return;
          }
          deadPtys.add(event.ptyProcessId);
          scheduleRootScan();
        }),
      ),
    );

    const service: HarnessLedgerObserverService = {
      reconcileAgentSession,
      getProjection: (agentSessionId) =>
        Effect.gen(function* () {
          if (!projections.has(agentSessionId)) {
            yield* reconcileAgentSession(agentSessionId);
          }
          return projections.get(agentSessionId);
        }),
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
  database: import('../../persistence/index.js').RuntimeDatabaseService,
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

function readProjection(artifacts: AgentSessionArtifactsService, agentSessionId: number) {
  return Effect.gen(function* () {
    const jsonlReads = yield* artifacts.readJsonlForAgentSession(agentSessionId);
    return buildHarnessObservationProjection(jsonlReads);
  });
}

type TurnStatus =
  | {
      readonly status: 'in_flight';
      readonly recordedAt: string;
      readonly ptyProcessId: number | null;
    }
  | { readonly status: 'terminated' };

type HarnessSessionTurnStatuses = Map<number, TurnStatus>;
type AgentSessionTurnStatuses = Map<string, HarnessSessionTurnStatuses>;

function reconcileTurnEdges(input: {
  readonly agentSessionId: number;
  readonly projection: HarnessObservationProjection;
  readonly turnStatuses: Map<number, AgentSessionTurnStatuses>;
  readonly deadPtys: ReadonlySet<number>;
  readonly eventBus: import('../../runtime-events/index.js').InternalRuntimeEventBusService;
}) {
  return Effect.gen(function* () {
    const existing = input.turnStatuses.get(input.agentSessionId);
    const shouldEmit = Boolean(existing);
    const sessionStatuses = existing ?? new Map<string, HarnessSessionTurnStatuses>();
    const streams = sortedHarnessStreams(input.projection);

    for (const [harnessSessionId, records] of streams) {
      const harness = records[0]?.harness;
      if (!harness) continue;
      let streamStatuses = sessionStatuses.get(harnessSessionId);
      if (!streamStatuses) {
        streamStatuses = new Map<number, TurnStatus>();
        sessionStatuses.set(harnessSessionId, streamStatuses);
      }
      const edges = deriveHarnessTurnEdges(harness, records);
      yield* reconcileHarnessSessionTurnEdges({
        agentSessionId: input.agentSessionId,
        harnessSessionId,
        records,
        edges,
        streamStatuses,
        shouldEmit,
        deadPtys: input.deadPtys,
        eventBus: input.eventBus,
      });
    }

    input.turnStatuses.set(input.agentSessionId, sessionStatuses);
  });
}

function reconcileHarnessSessionTurnEdges(input: {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly records: readonly HarnessObservationRecord[];
  readonly edges: readonly HarnessTurnEdge[];
  readonly streamStatuses: HarnessSessionTurnStatuses;
  readonly shouldEmit: boolean;
  readonly deadPtys: ReadonlySet<number>;
  readonly eventBus: import('../../runtime-events/index.js').InternalRuntimeEventBusService;
}) {
  return Effect.gen(function* () {
    let activeStartedSeq: number | null = null;
    for (const edge of input.edges) {
      if (edge.type === 'turn_started') {
        activeStartedSeq = edge.seq;
        if (!input.streamStatuses.has(edge.seq)) {
          const startRecord = input.records.find((record) => record.seq === edge.seq);
          input.streamStatuses.set(edge.seq, {
            status: 'in_flight',
            recordedAt: edge.recordedAt,
            ptyProcessId: startRecord?.ptyProcessId ?? null,
          });
          if (input.shouldEmit) {
            yield* input.eventBus.publish({
              type: 'turn_started',
              agentSessionId: input.agentSessionId,
              harnessSessionId: input.harnessSessionId,
              seq: edge.seq,
              recordedAt: edge.recordedAt,
            });
          }
        }
        continue;
      }

      if (activeStartedSeq === null) continue;
      const current = input.streamStatuses.get(activeStartedSeq);
      if (current?.status !== 'in_flight') {
        activeStartedSeq = null;
        continue;
      }
      input.streamStatuses.set(activeStartedSeq, { status: 'terminated' });
      activeStartedSeq = null;
      if (!input.shouldEmit) continue;
      if (edge.type === 'turn_ended') {
        yield* input.eventBus.publish({
          type: 'turn_ended',
          agentSessionId: input.agentSessionId,
          harnessSessionId: input.harnessSessionId,
          seq: edge.seq,
          recordedAt: edge.recordedAt,
        });
      } else {
        yield* input.eventBus.publish({
          type: 'turn_failed',
          agentSessionId: input.agentSessionId,
          harnessSessionId: input.harnessSessionId,
          seq: edge.seq,
          recordedAt: edge.recordedAt,
          reason: edge.reason,
        });
      }
    }

    for (const [startedSeq, status] of input.streamStatuses.entries()) {
      if (
        status.status !== 'in_flight' ||
        status.ptyProcessId === null ||
        !input.deadPtys.has(status.ptyProcessId)
      ) {
        continue;
      }
      input.streamStatuses.set(startedSeq, { status: 'terminated' });
      if (!input.shouldEmit) continue;
      yield* input.eventBus.publish({
        type: 'turn_failed',
        agentSessionId: input.agentSessionId,
        harnessSessionId: input.harnessSessionId,
        seq: null,
        recordedAt: status.recordedAt,
        reason: 'session_died',
      });
    }
  });
}

function sortedHarnessStreams(projection: HarnessObservationProjection) {
  return [...projection.recordsByHarnessSessionId.entries()].sort(
    ([, leftRecords], [, rightRecords]) =>
      earliestRecordedAt(leftRecords).localeCompare(earliestRecordedAt(rightRecords)),
  );
}

function earliestRecordedAt(records: readonly HarnessObservationRecord[]) {
  return records[0]?.recordedAt ?? '';
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
