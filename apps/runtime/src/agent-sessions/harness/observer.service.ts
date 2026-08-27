import { eq, inArray } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { AgentHarness, AttentionState, SessionStatus } from '@isagi/contracts';

import { RuntimeDatabase } from '../../persistence/index.js';
import { agentSessions, ptyProcesses } from '../../persistence/schema.js';
import { InternalRuntimeEventBus, type InternalRuntimeEvent } from '../../runtime-events/index.js';
import { activeCodexStreamCandidates, selectConfirmedCodexPrimary } from './codex/identity.js';
import { type CodexRolloutEntry, type CodexRolloutPath } from './codex/native-artifacts.js';
import { harnessDefinition } from './definitions.js';
import {
  discoverHarnessJsonlFiles,
  jsonlFileState,
  readJsonlBytes,
  splitCompleteJsonlLines,
} from './jsonl-tailer.js';
import {
  AgentSessionArtifacts,
  parseJsonlRecord,
  type AgentSessionHarnessJsonlRecord,
} from './ledger.js';
import { type HarnessLifecycleDiagnostic } from './lifecycle.js';
import {
  commitAgentObserverState,
  createAgentObserverState,
  diagnosticKey,
  edgeKey,
  markerString,
  metadataMarker,
  projectAgentObserverState,
  type AgentObserverState,
  type FileCursor,
  type ObservedHarnessTurnEdge,
  type ProcessFact,
} from './observer-state.js';
import { type HarnessObservationProjection, type HarnessObservationRecord } from './projection.js';

export interface HarnessLedgerObserverService {
  readonly getProjection: (
    agentSessionId: number,
  ) => Effect.Effect<HarnessObservationProjection | undefined>;
  readonly getTurnEdges: (
    agentSessionId: number,
  ) => Effect.Effect<readonly ObservedHarnessTurnEdge[]>;
  readonly getAttention: (agentSessionId: number) => Effect.Effect<AttentionState | undefined>;
}

export interface HarnessLedgerObserverTestControlService {
  readonly pollOnce: Effect.Effect<void, unknown>;
  readonly pollAgentSession: (agentSessionId: number) => Effect.Effect<void, unknown>;
}

export const HarnessLedgerObserver = Context.GenericTag<HarnessLedgerObserverService>(
  'isagi/HarnessLedgerObserver',
);

const testControls = new WeakMap<object, HarnessLedgerObserverTestControlService>();

/** @internal Explicit manual clock seam for fixture tests. */
export function pollHarnessLedgerObserverForTest(
  observer: HarnessLedgerObserverService,
  agentSessionId?: number,
) {
  const control = testControls.get(observer);
  if (!control) return Effect.die('Harness observer test control is unavailable.');
  return agentSessionId === undefined ? control.pollOnce : control.pollAgentSession(agentSessionId);
}

type InventoryRow = {
  readonly agentSessionId: number;
  readonly harness: AgentHarness;
  readonly activePtyProcessId: number | null;
  readonly status: SessionStatus | null;
  readonly statusReason: string | null;
};

export type { ObservedHarnessTurnEdge } from './observer-state.js';

export const HarnessLedgerObserverLive = Layer.scoped(
  HarnessLedgerObserver,
  Effect.gen(function* () {
    const artifacts = yield* AgentSessionArtifacts;
    const database = yield* RuntimeDatabase;
    const eventBus = yield* InternalRuntimeEventBus;
    const states = new Map<number, AgentObserverState>();
    const locks = new Map<number, Effect.Semaphore>();
    const activePtyByAgent = new Map<number, number | null>();
    const harnessByAgent = new Map<number, AgentHarness>();
    const ownerByPty = new Map<number, number>();
    const processFacts = new Map<number, ProcessFact>();

    const lockFor = (agentSessionId: number) =>
      Effect.gen(function* () {
        const existing = locks.get(agentSessionId);
        if (existing) return existing;
        const lock = yield* Effect.makeSemaphore(1);
        locks.set(agentSessionId, lock);
        return lock;
      });

    const withAgentLock = <A, E, R>(agentSessionId: number, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const lock = yield* lockFor(agentSessionId);
        return yield* lock.withPermits(1)(effect);
      });

    const stateFor = (agentSessionId: number): AgentObserverState => {
      const existing = states.get(agentSessionId);
      if (existing) return existing;
      const state = createAgentObserverState({
        status: 'missing',
        metadataPath: artifacts.paths({ agentSessionId }).metadataPath,
      });
      states.set(agentSessionId, state);
      return state;
    };

    const inventoryQuery = (input: {
      readonly mode: 'all' | 'live' | 'one';
      readonly id?: number;
    }) =>
      database.use(`harness_observer_inventory_${input.mode}`, (db) => {
        const base = db
          .select({
            agentSessionId: agentSessions.id,
            harness: agentSessions.harness,
            activePtyProcessId: agentSessions.activePtyProcessId,
            status: ptyProcesses.status,
            statusReason: ptyProcesses.statusReason,
          })
          .from(agentSessions)
          .leftJoin(ptyProcesses, eq(agentSessions.activePtyProcessId, ptyProcesses.id));
        const rows =
          input.mode === 'live'
            ? base.where(inArray(ptyProcesses.status, ['starting', 'running'])).all()
            : input.mode === 'one' && input.id !== undefined
              ? base.where(eq(agentSessions.id, input.id)).all()
              : base.all();
        return rows.map((row) => row as InventoryRow);
      });

    const applyInventory = (rows: readonly InventoryRow[], replace: boolean) => {
      const present = new Set<number>();
      for (const row of rows) {
        present.add(row.agentSessionId);
        const previous = activePtyByAgent.get(row.agentSessionId);
        if (previous !== undefined && previous !== row.activePtyProcessId && previous !== null) {
          ownerByPty.delete(previous);
        }
        activePtyByAgent.set(row.agentSessionId, row.activePtyProcessId);
        harnessByAgent.set(row.agentSessionId, row.harness);
        if (row.activePtyProcessId !== null) {
          ownerByPty.set(row.activePtyProcessId, row.agentSessionId);
          if (row.status) {
            processFacts.set(row.activePtyProcessId, {
              status: row.status,
              statusReason: row.statusReason,
            });
          }
        }
      }
      if (!replace) return;
      for (const [agentSessionId, ptyProcessId] of activePtyByAgent) {
        if (present.has(agentSessionId)) continue;
        activePtyByAgent.delete(agentSessionId);
        harnessByAgent.delete(agentSessionId);
        if (ptyProcessId !== null) ownerByPty.delete(ptyProcessId);
      }
    };

    const appendLedgerRecord = (agentSessionId: number, record: AgentSessionHarnessJsonlRecord) => {
      if (record.agentSessionId !== agentSessionId) return;
      const state = stateFor(agentSessionId);
      const records = state.recordsByHarnessSessionId.get(record.harnessSessionId) ?? [];
      const seq = state.nextSeqByHarnessSessionId.get(record.harnessSessionId) ?? 0;
      records.push({
        recordedAt: record.recordedAt,
        seq,
        ptyProcessId: record.ptyProcessId,
        harness: record.harness,
        nativeEvent: record.nativeEvent,
        event: record.event,
      });
      state.recordsByHarnessSessionId.set(record.harnessSessionId, records);
      state.nextSeqByHarnessSessionId.set(record.harnessSessionId, seq + 1);
    };

    const appendCodexEntry = (
      agentSessionId: number,
      harnessSessionId: string,
      entry: CodexRolloutEntry,
    ) => {
      const state = stateFor(agentSessionId);
      const records = state.codexRecordsByHarnessSessionId.get(harnessSessionId) ?? [];
      const seq = state.nextCodexSeqByHarnessSessionId.get(harnessSessionId) ?? 0;
      records.push({
        seq,
        recordedAt: codexEntryTimestamp(entry),
        ptyProcessId: activePtyByAgent.get(agentSessionId) ?? null,
        entry,
      });
      state.codexRecordsByHarnessSessionId.set(harnessSessionId, records);
      state.nextCodexSeqByHarnessSessionId.set(harnessSessionId, seq + 1);
    };

    const readLedgerSource = (agentSessionId: number, path: string, baseline: boolean) =>
      readSourceLines(path, 0).pipe(
        Effect.map(({ file, lines, trailingBytes, invalidLineCount }) => {
          let ignoredLineCount = invalidLineCount;
          const harnessSessionIds = new Set<string>();
          for (const line of lines) {
            try {
              const record = parseJsonlRecord(line);
              if (record) {
                appendLedgerRecord(agentSessionId, record);
                harnessSessionIds.add(record.harnessSessionId);
              } else ignoredLineCount += 1;
            } catch {
              ignoredLineCount += 1;
            }
          }
          logMalformedLines({ agentSessionId, path, baseline, count: ignoredLineCount });
          stateFor(agentSessionId).ledgerCursors.set(path, {
            identity: file.identity,
            offset: file.size,
            trailingBytes,
          });
          return harnessSessionIds;
        }),
      );

    const readRolloutSource = (
      agentSessionId: number,
      source: CodexRolloutPath,
      baseline: boolean,
    ) =>
      readSourceLines(source.path, 0).pipe(
        Effect.map(({ file, lines, trailingBytes, invalidLineCount }) => {
          let ignoredLineCount = invalidLineCount;
          for (const line of lines) {
            try {
              const entry = parseObjectLine(line);
              if (entry) appendCodexEntry(agentSessionId, source.harnessSessionId, entry);
              else ignoredLineCount += 1;
            } catch {
              ignoredLineCount += 1;
            }
          }
          logMalformedLines({
            agentSessionId,
            path: source.path,
            baseline,
            count: ignoredLineCount,
          });
          stateFor(agentSessionId).rolloutCursors.set(source.path, {
            identity: file.identity,
            offset: file.size,
            trailingBytes,
            harnessSessionId: source.harnessSessionId,
          });
        }),
      );

    const nativeSources = (agentSessionId: number) =>
      Effect.gen(function* () {
        const state = stateFor(agentSessionId);
        const harness = harnessByAgent.get(agentSessionId);
        if (!harness) return [];
        const locate = harnessDefinition(harness).observation.locateNativeSources;
        if (!locate) return [];
        const streams = [...state.recordsByHarnessSessionId.entries()] as readonly [
          string,
          readonly HarnessObservationRecord[],
        ][];
        const currentHarnessSessionId =
          state.metadata.status === 'valid' ? state.metadata.metadata.harnessSessionId : null;
        const activeCandidates = activeCodexStreamCandidates(
          state.recordsByHarnessSessionId,
          activePtyByAgent.get(agentSessionId) ?? null,
        );
        const candidateIds = new Set([
          ...activeCandidates.map((candidate) => candidate.harnessSessionId),
          ...(currentHarnessSessionId ? [currentHarnessSessionId] : []),
        ]);
        const unique = new Map<string, CodexRolloutPath>();
        const confirmedHarnessSessionIds = new Set<string>();
        for (const harnessSessionId of candidateIds) {
          const cached = [...state.rolloutCursors.entries()]
            .filter(([, cursor]) => cursor.harnessSessionId === harnessSessionId)
            .map(([path]) => ({ path, harnessSessionId }))
            .filter((source) => sourceIsAvailable(source.path));
          const candidateStreams = streams.filter(([streamId]) => streamId === harnessSessionId);
          const sources = [...cached];
          if (sources.length === 0) {
            sources.push(
              ...(yield* locate({
                agentSessionId,
                harnessSessionId,
                streams: candidateStreams,
                discovery: 'index_only',
              })).filter((source) => sourceIsAvailable(source.path)),
            );
          }
          if (sources.length === 0) {
            const missCount = (state.codexLocatorMissCounts.get(harnessSessionId) ?? 0) + 1;
            state.codexLocatorMissCounts.set(harnessSessionId, missCount);
            // Native-tree discovery is the expensive compatibility path. Try
            // it immediately, then once per twenty 500 ms polls while the
            // supported hook/index locators remain unavailable.
            if (missCount === 1 || missCount % 20 === 0) {
              sources.push(
                ...(yield* locate({
                  agentSessionId,
                  harnessSessionId,
                  streams: candidateStreams,
                  discovery: 'full',
                })).filter((source) => sourceIsAvailable(source.path)),
              );
            }
          }
          if (sources.length > 0) {
            confirmedHarnessSessionIds.add(harnessSessionId);
            state.codexLocatorMissCounts.delete(harnessSessionId);
          }
          for (const source of sources) unique.set(source.path, source);
        }
        state.confirmedCodexHarnessSessionIds = confirmedHarnessSessionIds;
        const primaryHarnessSessionId = selectConfirmedCodexPrimary({
          candidates: activeCandidates,
          confirmedHarnessSessionIds,
          currentHarnessSessionId,
        });
        if (primaryHarnessSessionId && primaryHarnessSessionId !== currentHarnessSessionId) {
          const metadataPath = artifacts.paths({ agentSessionId }).metadataPath;
          const persisted = yield* sourceOrElse(
            agentSessionId,
            metadataPath,
            'codex_primary_identity_promotion',
            artifacts
              .writeHarnessSessionId({ agentSessionId, harnessSessionId: primaryHarnessSessionId })
              .pipe(Effect.as(true)),
            false,
            state.failedOperationKeys,
            `codex-primary:${metadataPath}`,
          );
          if (persisted) state.metadata = yield* artifacts.readMetadata(agentSessionId);
        }
        if (unique.size === 0) {
          const diagnostic: HarnessLifecycleDiagnostic = {
            code: 'missing_native_artifact',
            recordedAt: '',
          };
          const key = diagnosticKey(diagnostic);
          if (!state.publishedDiagnosticKeys.has(key)) {
            state.publishedDiagnosticKeys.add(key);
            logLifecycleDiagnostic(agentSessionId, diagnostic);
          }
        }
        return [...unique.values()];
      });

    const rebuildBaseline = (
      agentSessionId: number,
      reason: 'startup' | 'source_rebased',
      options: {
        readonly publishProcessFailures?: boolean;
        readonly forceSessionChanged?: boolean;
      } = {},
    ) =>
      Effect.gen(function* () {
        const state = stateFor(agentSessionId);
        const previousMarker = state.projectionMarker;
        const previousPublishedEdgeKeys = state.publishedEdgeKeys;
        state.ledgerCursors.clear();
        state.rolloutCursors.clear();
        state.recordsByHarnessSessionId.clear();
        state.codexRecordsByHarnessSessionId.clear();
        state.nextSeqByHarnessSessionId.clear();
        state.nextCodexSeqByHarnessSessionId.clear();
        state.confirmedCodexHarnessSessionIds.clear();
        state.codexLocatorMissCounts.clear();
        if (reason === 'source_rebased') state.stickyFailures.clear();
        const directory = artifacts.paths({ agentSessionId }).directory;
        const ledgerPaths = yield* sourceOrElse(
          agentSessionId,
          directory,
          `${reason}_discovery`,
          Effect.sync(() => discoverHarnessJsonlFiles(directory)),
          [],
          state.failedOperationKeys,
          `discovery:${directory}`,
        );
        for (const path of ledgerPaths) {
          yield* sourceOrElse(
            agentSessionId,
            path,
            reason,
            readLedgerSource(agentSessionId, path, true),
            new Set<string>(),
            state.failedSourcePaths,
          );
        }
        state.metadata = yield* artifacts.readMetadata(agentSessionId);
        for (const source of yield* nativeSources(agentSessionId)) {
          yield* sourceOrElse(
            agentSessionId,
            source.path,
            reason,
            readRolloutSource(agentSessionId, source, true).pipe(Effect.as(true)),
            false,
            state.failedSourcePaths,
          );
        }
        const result = projectAgentObserverState({
          agentSessionId,
          harness: harnessByAgent.get(agentSessionId),
          state,
          activePtyProcessId: activePtyByAgent.get(agentSessionId) ?? null,
          processFacts,
        });
        commitAgentObserverState(state, result);
        state.publishedEdgeKeys = new Set(result.edges.map(edgeKey));
        for (const diagnostic of result.diagnostics) {
          state.publishedDiagnosticKeys.add(diagnosticKey(diagnostic));
        }
        const wasInitialized = state.initialized;
        state.initialized = true;
        if (options.publishProcessFailures) {
          for (const edge of result.edges) {
            if (
              edge.type === 'turn_failed' &&
              edge.reason === 'session_died' &&
              !previousPublishedEdgeKeys.has(edgeKey(edge))
            ) {
              yield* eventBus.publish(edge);
            }
          }
        }
        if (options.forceSessionChanged || (wasInitialized && previousMarker !== result.marker)) {
          yield* eventBus.publish({ type: 'agent_session_changed', agentSessionId });
        }
      });

    const refreshAgent = (
      agentSessionId: number,
      options: {
        readonly publish: boolean;
        readonly forceRecompute?: boolean;
        readonly forceSessionChanged?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const state = stateFor(agentSessionId);
        if (!state.initialized) {
          yield* rebuildBaseline(agentSessionId, 'startup', {
            publishProcessFailures: options.publish && options.forceRecompute === true,
            forceSessionChanged: options.publish && options.forceSessionChanged === true,
          });
          return;
        }

        const directory = artifacts.paths({ agentSessionId }).directory;
        const discoveryKey = `discovery:${directory}`;
        const directoryRecovering = state.failedOperationKeys.has(discoveryKey);
        const ledgerPaths = yield* sourceOrElse(
          agentSessionId,
          directory,
          'live_discovery',
          Effect.sync(() => discoverHarnessJsonlFiles(directory)),
          [],
          state.failedOperationKeys,
          discoveryKey,
        );
        const ledgerInspection = yield* sourceOrElse(
          agentSessionId,
          directory,
          'ledger_source_inspection',
          Effect.sync(() => inspectSources(state.ledgerCursors)),
          emptySourceInspection,
          state.failedOperationKeys,
          `ledger-inspection:${directory}`,
        );
        const rolloutInspection = yield* sourceOrElse(
          agentSessionId,
          directory,
          'native_source_inspection',
          Effect.sync(() => inspectSources(state.rolloutCursors)),
          emptySourceInspection,
          state.failedOperationKeys,
          `native-inspection:${directory}`,
        );
        for (const path of ledgerInspection.missingPaths) state.failedSourcePaths.add(path);
        if (ledgerInspection.rebased || rolloutInspection.rebased) {
          return yield* rebuildBaseline(agentSessionId, 'source_rebased', {
            publishProcessFailures: options.publish && options.forceRecompute === true,
            forceSessionChanged: options.publish && options.forceSessionChanged === true,
          });
        }

        let changed = false;
        const baselineHarnessSessionIds = new Set<string>();
        for (const path of ledgerPaths) {
          const cursor = state.ledgerCursors.get(path);
          if (!cursor) {
            const recovering = directoryRecovering || state.failedSourcePaths.has(path);
            const harnessSessionIds = yield* sourceOrElse(
              agentSessionId,
              path,
              recovering ? 'source_recovery' : 'live_discovery',
              readLedgerSource(agentSessionId, path, recovering),
              null,
              state.failedSourcePaths,
            );
            if (harnessSessionIds) {
              changed = true;
              if (recovering) {
                for (const harnessSessionId of harnessSessionIds) {
                  baselineHarnessSessionIds.add(harnessSessionId);
                }
              }
            }
            continue;
          }
          if (
            yield* sourceOrElse(
              agentSessionId,
              path,
              'incremental_tail',
              tailLedgerSource(agentSessionId, path, cursor),
              false,
              state.failedSourcePaths,
            )
          ) {
            changed = true;
          }
        }

        const priorMetadata = metadataMarker(state.metadata);
        state.metadata = yield* artifacts.readMetadata(agentSessionId);
        const metadataChanged =
          markerString(priorMetadata) !== markerString(metadataMarker(state.metadata));
        if (metadataChanged) changed = true;

        const priorCodexResolution = codexResolutionMarker(state);
        for (const source of yield* nativeSources(agentSessionId)) {
          const cursor = state.rolloutCursors.get(source.path);
          if (!cursor) {
            if (
              yield* sourceOrElse(
                agentSessionId,
                source.path,
                'native_source_discovery',
                readRolloutSource(agentSessionId, source, false).pipe(Effect.as(true)),
                false,
                state.failedSourcePaths,
              )
            ) {
              changed = true;
            }
            continue;
          }
          if (
            yield* sourceOrElse(
              agentSessionId,
              source.path,
              'incremental_native_tail',
              tailRolloutSource(agentSessionId, source, cursor),
              false,
              state.failedSourcePaths,
            )
          ) {
            changed = true;
          }
        }
        if (priorCodexResolution !== codexResolutionMarker(state)) changed = true;

        if (changed || options.forceRecompute || options.forceSessionChanged) {
          yield* recomputeAndPublish(agentSessionId, {
            publish: options.publish,
            forceSessionChanged: options.forceSessionChanged === true,
            baselineHarnessSessionIds,
            publishProcessFailures: options.publish && options.forceRecompute === true,
          });
        }
      });

    const tailLedgerSource = (agentSessionId: number, path: string, cursor: FileCursor) =>
      Effect.sync(() => {
        const file = jsonlFileState(path);
        if (!file || file.size === cursor.offset) return false;
        const appended = readJsonlBytes(path, cursor.offset, file.size - cursor.offset);
        const split = splitCompleteJsonlLines(Buffer.concat([cursor.trailingBytes, appended]));
        let ignoredLineCount = 0;
        for (const line of split.completeLines) {
          try {
            const record = parseJsonlRecord(line);
            if (record) appendLedgerRecord(agentSessionId, record);
            else ignoredLineCount += 1;
          } catch {
            ignoredLineCount += 1;
          }
        }
        logMalformedLines({ agentSessionId, path, baseline: false, count: ignoredLineCount });
        stateFor(agentSessionId).ledgerCursors.set(path, {
          identity: file.identity,
          offset: file.size,
          trailingBytes: split.trailingBytes,
        });
        return appended.length > 0;
      });

    const tailRolloutSource = (
      agentSessionId: number,
      source: CodexRolloutPath,
      cursor: FileCursor,
    ) =>
      Effect.sync(() => {
        const file = jsonlFileState(source.path);
        if (!file || file.size === cursor.offset) return false;
        const appended = readJsonlBytes(source.path, cursor.offset, file.size - cursor.offset);
        const split = splitCompleteJsonlLines(Buffer.concat([cursor.trailingBytes, appended]));
        let ignoredLineCount = 0;
        for (const line of split.completeLines) {
          try {
            const entry = parseObjectLine(line);
            if (entry) appendCodexEntry(agentSessionId, source.harnessSessionId, entry);
            else ignoredLineCount += 1;
          } catch {
            ignoredLineCount += 1;
          }
        }
        logMalformedLines({
          agentSessionId,
          path: source.path,
          baseline: false,
          count: ignoredLineCount,
        });
        stateFor(agentSessionId).rolloutCursors.set(source.path, {
          identity: file.identity,
          offset: file.size,
          trailingBytes: split.trailingBytes,
          harnessSessionId: source.harnessSessionId,
        });
        return appended.length > 0;
      });

    const recomputeAndPublish = (
      agentSessionId: number,
      options: {
        readonly publish: boolean;
        readonly forceSessionChanged: boolean;
        readonly baselineHarnessSessionIds: ReadonlySet<string>;
        readonly publishProcessFailures: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const state = stateFor(agentSessionId);
        const result = projectAgentObserverState({
          agentSessionId,
          harness: harnessByAgent.get(agentSessionId),
          state,
          activePtyProcessId: activePtyByAgent.get(agentSessionId) ?? null,
          processFacts,
        });
        const priorMarker = state.projectionMarker;
        for (const edge of result.edges) {
          const isNewProcessFailure =
            options.publishProcessFailures &&
            edge.type === 'turn_failed' &&
            edge.reason === 'session_died' &&
            !state.publishedEdgeKeys.has(edgeKey(edge));
          if (
            options.baselineHarnessSessionIds.has(edge.harnessSessionId) &&
            !isNewProcessFailure
          ) {
            state.publishedEdgeKeys.add(edgeKey(edge));
          }
        }
        const freshEdges = result.edges.filter(
          (edge) => !state.publishedEdgeKeys.has(edgeKey(edge)),
        );
        const freshDiagnostics = result.diagnostics.filter(
          (diagnostic) => !state.publishedDiagnosticKeys.has(diagnosticKey(diagnostic)),
        );
        commitAgentObserverState(state, result);
        for (const edge of freshEdges) state.publishedEdgeKeys.add(edgeKey(edge));
        for (const diagnostic of freshDiagnostics) {
          state.publishedDiagnosticKeys.add(diagnosticKey(diagnostic));
        }
        if (!options.publish || !state.initialized) return;
        for (const diagnostic of freshDiagnostics)
          logLifecycleDiagnostic(agentSessionId, diagnostic);
        for (const edge of freshEdges) yield* eventBus.publish(edge);
        if (options.forceSessionChanged || priorMarker !== result.marker) {
          yield* eventBus.publish({ type: 'agent_session_changed', agentSessionId });
        }
      });

    const pollAgentSession = (agentSessionId: number, publish = true) =>
      withAgentLock(agentSessionId, refreshAgent(agentSessionId, { publish })).pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            console.warn('[runtime] Harness observer refresh failed', {
              agentSessionId,
              cause: String(cause),
            });
          }),
        ),
      );

    const pollOnce = Effect.gen(function* () {
      const liveInventory = yield* inventoryQuery({ mode: 'live' });
      applyInventory(liveInventory, false);
      yield* Effect.forEach(liveInventory, (row) => pollAgentSession(row.agentSessionId), {
        concurrency: 4,
        discard: true,
      });
    });

    const subscription = yield* eventBus.subscribe({
      types: [
        'pty_process_started',
        'pty_process_exited',
        'pty_process_failed',
        'pty_process_killed',
        'agent_session_active_process_changed',
      ],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if (event.type === 'agent_session_active_process_changed') {
            const inventory = yield* inventoryQuery({ mode: 'one', id: event.agentSessionId });
            applyInventory(inventory, false);
            yield* withAgentLock(
              event.agentSessionId,
              // The ownership pointer is itself a projection input even when
              // no artifact byte changed during this handoff. It is also a
              // guaranteed user-visible session transition.
              refreshAgent(event.agentSessionId, {
                publish: true,
                forceRecompute: true,
                forceSessionChanged: true,
              }),
            );
            return;
          }
          const fact = processFactFromEvent(event);
          if (!fact || !('ptyProcessId' in event)) return;
          processFacts.set(event.ptyProcessId, fact);
          const owner = ownerByPty.get(event.ptyProcessId);
          if (owner === undefined) return;
          yield* withAgentLock(
            owner,
            // Terminal events request a final artifact tail first, but process
            // facts always force projection recomputation even when no bytes
            // were appended.
            refreshAgent(owner, { publish: true, forceRecompute: true }),
          );
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() =>
              console.warn('[runtime] Harness observer event handling failed', String(cause)),
            ),
          ),
        ),
      ),
    );

    // Subscribe before inventory so no process transition can fall between the
    // snapshot and live event ownership.
    const startupInventory = yield* inventoryQuery({ mode: 'all' });
    applyInventory(startupInventory, true);
    const startupArtifactIds = yield* artifacts.listAgentSessionIds.pipe(
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          console.warn('[runtime] Harness artifact inventory could not be read', String(cause));
          return [];
        }),
      ),
    );
    const startupIds = new Set([
      ...startupArtifactIds,
      ...startupInventory.map((row) => row.agentSessionId),
    ]);
    yield* Effect.forEach(
      [...startupIds],
      (agentSessionId) => withAgentLock(agentSessionId, rebuildBaseline(agentSessionId, 'startup')),
      { concurrency: 4, discard: true },
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep('500 millis').pipe(
          Effect.zipRight(pollOnce),
          Effect.catchAllCause((cause) =>
            Effect.sync(() =>
              console.warn('[runtime] Harness observer poll failed', String(cause)),
            ),
          ),
        ),
      ),
    );

    const service: HarnessLedgerObserverService = {
      getProjection: (agentSessionId) => Effect.sync(() => states.get(agentSessionId)?.projection),
      getTurnEdges: (agentSessionId) => Effect.sync(() => states.get(agentSessionId)?.edges ?? []),
      getAttention: (agentSessionId) => Effect.sync(() => states.get(agentSessionId)?.attention),
    };
    testControls.set(service, { pollOnce, pollAgentSession });
    yield* Effect.addFinalizer(() => Effect.sync(() => testControls.delete(service)));
    return service;
  }),
);

function readSourceLines(path: string, offset: number) {
  return Effect.sync(() => {
    const file = jsonlFileState(path);
    if (!file) throw new Error(`Observation source disappeared: ${path}`);
    const bytes = readJsonlBytes(path, offset, file.size - offset);
    const split = splitCompleteJsonlLines(bytes);
    return {
      file,
      lines: split.completeLines,
      trailingBytes: split.trailingBytes,
      invalidLineCount: 0,
    };
  });
}

const emptySourceInspection = { rebased: false, missingPaths: [] as string[] };

function inspectSources(cursors: ReadonlyMap<string, FileCursor>) {
  const missingPaths: string[] = [];
  for (const [path, cursor] of cursors) {
    const file = jsonlFileState(path);
    if (!file) {
      missingPaths.push(path);
      continue;
    }
    if (file.identity !== cursor.identity || file.size < cursor.offset) {
      return { rebased: true, missingPaths };
    }
  }
  return { rebased: missingPaths.length > 0, missingPaths };
}

function sourceIsAvailable(path: string) {
  try {
    return jsonlFileState(path) !== null;
  } catch {
    return false;
  }
}

function processFactFromEvent(event: InternalRuntimeEvent): ProcessFact | null {
  switch (event.type) {
    case 'pty_process_started':
      return { status: event.status, statusReason: null };
    case 'pty_process_exited':
      return { status: event.status, statusReason: null };
    case 'pty_process_failed':
    case 'pty_process_killed':
      return { status: event.status, statusReason: event.statusReason };
    default:
      return null;
  }
}

function codexEntryTimestamp(entry: CodexRolloutEntry) {
  return typeof entry.timestamp === 'string' ? entry.timestamp : '';
}

function codexResolutionMarker(state: AgentObserverState) {
  return markerString([
    metadataMarker(state.metadata),
    [...state.confirmedCodexHarnessSessionIds].toSorted(),
    [...state.codexLocatorMissCounts.entries()].toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  ]);
}

function parseObjectLine(line: string): CodexRolloutEntry | null {
  const parsed = JSON.parse(line) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as CodexRolloutEntry)
    : null;
}

function logMalformedLines(input: {
  readonly agentSessionId: number;
  readonly path: string;
  readonly baseline: boolean;
  readonly count: number;
}) {
  if (input.count === 0) return;
  console.warn('[runtime] Ignored malformed harness observation lines', input);
}

function logLifecycleDiagnostic(agentSessionId: number, diagnostic: HarnessLifecycleDiagnostic) {
  console.warn('[runtime] Harness lifecycle evidence degraded', {
    agentSessionId,
    code: diagnostic.code,
    recordedAt: diagnostic.recordedAt,
  });
}

function sourceOrElse<A, E, R>(
  agentSessionId: number,
  path: string,
  reason: string,
  effect: Effect.Effect<A, E, R>,
  fallback: A,
  failureKeys: Set<string>,
  failureKey = path,
) {
  return effect.pipe(
    Effect.map((value) => {
      failureKeys.delete(failureKey);
      return value;
    }),
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        if (!failureKeys.has(failureKey)) {
          failureKeys.add(failureKey);
          console.warn('[runtime] Harness observation source could not be refreshed', {
            agentSessionId,
            path,
            reason,
            cause: String(cause),
          });
        }
        return fallback;
      }),
    ),
  );
}
