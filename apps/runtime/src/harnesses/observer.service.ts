import { Cause, Context, Data, Effect, Layer, Semaphore, Stream } from 'effect';

import type { AgentHarness, AttentionState } from '@isagi/contracts';

import { describeOperationalCause } from '../platform/diagnostics/index.js';
import { InternalEvents, type InternalEvent } from '../platform/events/index.js';
import { runPeriodically } from '../platform/fibers/index.js';
import type { DatabaseError } from '../platform/persistence/index.js';
import { activeCodexStreamCandidates, selectConfirmedCodexPrimary } from './codex/identity.js';
import {
  hookCodexRolloutPaths,
  type CodexRolloutEntry,
  type CodexRolloutPath,
} from './codex/native-artifacts.js';
import { harnessDefinition } from './definitions.js';
import {
  discoverJsonlFiles,
  HarnessSourceUnreadable,
  jsonlFileState,
  readJsonlBytes,
  splitCompleteJsonlLines,
} from './jsonl-tailer.js';
import {
  AgentSessionArtifacts,
  parseJsonlRecord,
  type AgentSessionArtifactError,
  type AgentSessionHarnessJsonlRecord,
} from './ledger.js';
import { type HarnessLifecycleDiagnostic } from './lifecycle.js';
import { HarnessObservationTargets, type HarnessObservationTarget } from './observation-targets.js';
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

export class HarnessObserverRefreshError extends Data.TaggedError('HarnessObserverRefreshError')<{
  readonly agentSessionId: number;
  readonly failedSources: readonly string[];
  readonly failedOperations: readonly string[];
  readonly message: string;
}> {}

/** How often the observer tails every live agent session's sources. */
const observerPollInterval = '500 millis';

/**
 * Module-internal: the observer's own poll steps, published beside it by the same layer so fixture
 * tests can drive a poll pass instead of waiting for the background interval. Not exported from the
 * module's `index.ts`; only `testing.ts` reaches it.
 */
export class HarnessLedgerObserverInternals extends Context.Service<
  HarnessLedgerObserverInternals,
  {
    /** One background poll pass: the live inventory, then every live session's sources. */
    readonly pollOnce: Effect.Effect<void, DatabaseError>;
    /** One session's poll step, as the background pass runs it (failures logged, never raised). */
    readonly pollAgentSession: (agentSessionId: number) => Effect.Effect<void>;
  }
>()('isagi/runtime/harnesses/HarnessLedgerObserverInternals') {}

type InventoryRow = HarnessObservationTarget;

export type { ObservedHarnessTurnEdge } from './observer-state.js';

const make = Effect.gen(function* () {
  const artifacts = yield* AgentSessionArtifacts;
  const targets = yield* HarnessObservationTargets;
  const eventBus = yield* InternalEvents;
  const states = new Map<number, AgentObserverState>();
  const locks = new Map<number, Semaphore.Semaphore>();
  const activePtyByAgent = new Map<number, number | null>();
  const harnessByAgent = new Map<number, AgentHarness>();
  const ownerByPty = new Map<number, number>();
  const processFacts = new Map<number, ProcessFact>();

  const lockFor = Effect.fnUntraced(function* (agentSessionId: number) {
    const existing = locks.get(agentSessionId);
    if (existing) return existing;
    const lock = yield* Semaphore.make(1);
    locks.set(agentSessionId, lock);
    return lock;
  });

  const withAgentLock = <A, E, R>(agentSessionId: number, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(lockFor(agentSessionId), (lock) => lock.withPermits(1)(effect));

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

  const inventoryQuery = targets.list;

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

  const readLedgerSource = Effect.fnUntraced(function* (
    agentSessionId: number,
    path: string,
    baseline: boolean,
  ) {
    const { file, lines, trailingBytes } = yield* readSourceLines(path);
    let ignoredLineCount = 0;
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
    yield* logMalformedLines({ agentSessionId, path, baseline, count: ignoredLineCount });
    stateFor(agentSessionId).ledgerCursors.set(path, {
      identity: file.identity,
      offset: file.size,
      trailingBytes,
    });
    return harnessSessionIds;
  });

  const readRolloutSource = Effect.fnUntraced(function* (
    agentSessionId: number,
    source: CodexRolloutPath,
    baseline: boolean,
  ) {
    const { file, lines, trailingBytes } = yield* readSourceLines(source.path);
    let ignoredLineCount = 0;
    for (const line of lines) {
      try {
        const entry = parseObjectLine(line);
        if (entry) appendCodexEntry(agentSessionId, source.harnessSessionId, entry);
        else ignoredLineCount += 1;
      } catch {
        ignoredLineCount += 1;
      }
    }
    yield* logMalformedLines({
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
  });

  const nativeSources = Effect.fnUntraced(function* (agentSessionId: number) {
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
      const cached = yield* availableSources(
        [...state.rolloutCursors.entries()]
          .filter(([, cursor]) => cursor.harnessSessionId === harnessSessionId)
          .map(([path]) => ({ path, harnessSessionId })),
      );
      const candidateStreams = streams.filter(([streamId]) => streamId === harnessSessionId);
      // A same-thread resume can announce a new page while the old cached
      // page still exists. Read newly announced sources without rescanning
      // native storage or reopening the index on every background poll.
      const sources = [
        ...cached,
        ...(yield* availableSources(hookCodexRolloutPaths(candidateStreams))),
      ];
      if (sources.length === 0) {
        sources.push(
          ...(yield* availableSources(
            yield* locate({
              agentSessionId,
              harnessSessionId,
              streams: candidateStreams,
              discovery: 'index_only',
            }),
          )),
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
            ...(yield* availableSources(
              yield* locate({
                agentSessionId,
                harnessSessionId,
                streams: candidateStreams,
                discovery: 'full',
              }),
            )),
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
        yield* logLifecycleDiagnostic(agentSessionId, diagnostic);
      }
    }
    return [...unique.values()];
  });

  const rebuildBaseline = Effect.fnUntraced(function* (
    agentSessionId: number,
    reason: 'startup' | 'source_rebased',
    options: {
      readonly publishProcessFailures?: boolean;
      readonly forceSessionChanged?: boolean;
    } = {},
  ) {
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
      discoverJsonlFiles(directory),
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

  const refreshAgent = Effect.fnUntraced(function* (
    agentSessionId: number,
    options: {
      readonly publish: boolean;
      readonly forceRecompute?: boolean;
      readonly forceSessionChanged?: boolean;
    },
  ) {
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
      discoverJsonlFiles(directory),
      [],
      state.failedOperationKeys,
      discoveryKey,
    );
    const ledgerInspection = yield* sourceOrElse(
      agentSessionId,
      directory,
      'ledger_source_inspection',
      inspectSources(state.ledgerCursors),
      emptySourceInspection,
      state.failedOperationKeys,
      `ledger-inspection:${directory}`,
    );
    const rolloutInspection = yield* sourceOrElse(
      agentSessionId,
      directory,
      'native_source_inspection',
      inspectSources(state.rolloutCursors),
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

  const tailLedgerSource = Effect.fnUntraced(function* (
    agentSessionId: number,
    path: string,
    cursor: FileCursor,
  ) {
    const file = yield* jsonlFileState(path);
    if (!file || file.size === cursor.offset) return false;
    const appended = yield* readJsonlBytes(path, cursor.offset, file.size - cursor.offset);
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
    yield* logMalformedLines({ agentSessionId, path, baseline: false, count: ignoredLineCount });
    stateFor(agentSessionId).ledgerCursors.set(path, {
      identity: file.identity,
      offset: file.size,
      trailingBytes: split.trailingBytes,
    });
    return appended.length > 0;
  });

  const tailRolloutSource = Effect.fnUntraced(function* (
    agentSessionId: number,
    source: CodexRolloutPath,
    cursor: FileCursor,
  ) {
    const file = yield* jsonlFileState(source.path);
    if (!file || file.size === cursor.offset) return false;
    const appended = yield* readJsonlBytes(source.path, cursor.offset, file.size - cursor.offset);
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
    yield* logMalformedLines({
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

  const recomputeAndPublish = Effect.fnUntraced(function* (
    agentSessionId: number,
    options: {
      readonly publish: boolean;
      readonly forceSessionChanged: boolean;
      readonly baselineHarnessSessionIds: ReadonlySet<string>;
      readonly publishProcessFailures: boolean;
    },
  ) {
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
      if (options.baselineHarnessSessionIds.has(edge.harnessSessionId) && !isNewProcessFailure) {
        state.publishedEdgeKeys.add(edgeKey(edge));
      }
    }
    const freshEdges = result.edges.filter((edge) => !state.publishedEdgeKeys.has(edgeKey(edge)));
    const freshDiagnostics = result.diagnostics.filter(
      (diagnostic) => !state.publishedDiagnosticKeys.has(diagnosticKey(diagnostic)),
    );
    commitAgentObserverState(state, result);
    for (const edge of freshEdges) state.publishedEdgeKeys.add(edgeKey(edge));
    for (const diagnostic of freshDiagnostics) {
      state.publishedDiagnosticKeys.add(diagnosticKey(diagnostic));
    }
    if (!options.publish || !state.initialized) return;
    for (const diagnostic of freshDiagnostics) {
      yield* logLifecycleDiagnostic(agentSessionId, diagnostic);
    }
    for (const edge of freshEdges) yield* eventBus.publish(edge);
    if (options.forceSessionChanged || priorMarker !== result.marker) {
      yield* eventBus.publish({ type: 'agent_session_changed', agentSessionId });
    }
  });

  // One session's failure must not end the poll pass; an interruption-only cause still ends it.
  const pollAgentSession = (agentSessionId: number) =>
    withAgentLock(agentSessionId, refreshAgent(agentSessionId, { publish: true })).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning('Harness observer refresh failed', cause).pipe(
              Effect.annotateLogs({ agentSessionId }),
            ),
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

  const processEvents = yield* eventBus.subscribe([
    'pty_process_started',
    'pty_process_exited',
    'pty_process_failed',
    'pty_process_killed',
    'agent_session_active_process_changed',
  ]);
  yield* processEvents.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
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
        if (!fact) return;
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
        // One failed event must not end the subscriber. An interruption-only cause still ends it.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning('Harness observer event handling failed', cause),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  // Subscribe before inventory so no process transition can fall between the
  // snapshot and live event ownership.
  const startupInventory = yield* inventoryQuery({ mode: 'all' });
  applyInventory(startupInventory, true);
  // The inventory read degrades to empty on its own; this only keeps a defect in it from failing startup.
  const startupArtifactIds = yield* artifacts.listAgentSessionIds.pipe(
    Effect.catchDefect((defect) =>
      Effect.logWarning('Harness artifact inventory could not be read', Cause.die(defect)).pipe(
        Effect.as([]),
      ),
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
  yield* runPeriodically('Harness observer poll', observerPollInterval, pollOnce);

  const observer = HarnessLedgerObserver.of({
    // The plain reads run for every projection and attention query, so they are not traced.
    getProjection: (agentSessionId) => Effect.sync(() => states.get(agentSessionId)?.projection),
    getTurnEdges: (agentSessionId) => Effect.sync(() => states.get(agentSessionId)?.edges ?? []),
    // Explicit recovery needs a fresh, session-scoped observation, not the last
    // background poll. Do not turn a refresh failure into a stale success.
    refreshTurnEdges: Effect.fn('HarnessLedgerObserver.refreshTurnEdges')(
      function* (agentSessionId) {
        const inventory = yield* inventoryQuery({ mode: 'one', id: agentSessionId }).pipe(
          Effect.catchTag('DatabaseError', (cause) =>
            Effect.fail(
              new HarnessObserverRefreshError({
                agentSessionId,
                failedSources: [],
                failedOperations: ['inventory_refresh'],
                message: `Agent session ${agentSessionId} observation could not be refreshed: ${String(cause)}`,
              }),
            ),
          ),
        );
        applyInventory(inventory, false);
        return yield* withAgentLock(
          agentSessionId,
          Effect.gen(function* () {
            yield* refreshAgent(agentSessionId, { publish: true, forceRecompute: true });
            const state = states.get(agentSessionId);
            if (state && (state.failedSourcePaths.size > 0 || state.failedOperationKeys.size > 0)) {
              return yield* new HarnessObserverRefreshError({
                agentSessionId,
                failedSources: [...state.failedSourcePaths],
                failedOperations: [...state.failedOperationKeys],
                message: `Agent session ${agentSessionId} observation has unreadable sources.`,
              });
            }
            return state?.edges ?? [];
          }),
        );
      },
    ),
    getAttention: (agentSessionId) => Effect.sync(() => states.get(agentSessionId)?.attention),
  });
  return Context.make(HarnessLedgerObserver, observer).pipe(
    Context.add(
      HarnessLedgerObserverInternals,
      HarnessLedgerObserverInternals.of({ pollOnce, pollAgentSession }),
    ),
  );
});

export class HarnessLedgerObserver extends Context.Service<
  HarnessLedgerObserver,
  {
    readonly getProjection: (
      agentSessionId: number,
    ) => Effect.Effect<HarnessObservationProjection | undefined>;
    readonly getTurnEdges: (
      agentSessionId: number,
    ) => Effect.Effect<readonly ObservedHarnessTurnEdge[]>;
    readonly refreshTurnEdges: (
      agentSessionId: number,
    ) => Effect.Effect<readonly ObservedHarnessTurnEdge[], HarnessObserverRefreshError>;
    readonly getAttention: (agentSessionId: number) => Effect.Effect<AttentionState | undefined>;
  }
>()('isagi/runtime/harnesses/HarnessLedgerObserver') {
  /** Also provides `HarnessLedgerObserverInternals`, the poll seam fixture tests drive. */
  static readonly layerNoDeps = Layer.effectContext(make);
  static readonly layer = HarnessLedgerObserver.layerNoDeps.pipe(
    Layer.provide([AgentSessionArtifacts.layer, InternalEvents.layer]),
  );
}

/** A whole source from its first byte; a source that vanished since it was located is unreadable. */
const readSourceLines = Effect.fnUntraced(function* (path: string) {
  const file = yield* jsonlFileState(path);
  if (!file) {
    return yield* new HarnessSourceUnreadable({ path, reason: 'disappeared', cause: null });
  }
  const split = splitCompleteJsonlLines(yield* readJsonlBytes(path, 0, file.size));
  return { file, lines: split.completeLines, trailingBytes: split.trailingBytes };
});

const emptySourceInspection = { rebased: false, missingPaths: [] as string[] };

const inspectSources = Effect.fnUntraced(function* (cursors: ReadonlyMap<string, FileCursor>) {
  const missingPaths: string[] = [];
  for (const [path, cursor] of cursors) {
    const file = yield* jsonlFileState(path);
    if (!file) {
      missingPaths.push(path);
      continue;
    }
    if (file.identity !== cursor.identity || file.size < cursor.offset) {
      return { rebased: true, missingPaths };
    }
  }
  return { rebased: missingPaths.length > 0, missingPaths };
});

/** The sources that exist right now as regular files; an unreadable one is simply not available. */
function availableSources(sources: readonly CodexRolloutPath[]) {
  return Effect.filter(sources, (source) =>
    jsonlFileState(source.path).pipe(
      Effect.map((file) => file !== null),
      Effect.catchTag('HarnessSourceUnreadable', () => Effect.succeed(false)),
    ),
  );
}

function processFactFromEvent(event: InternalEvent): ProcessFact | null {
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
  if (input.count === 0) return Effect.void;
  return Effect.logWarning('Ignored malformed harness observation lines').pipe(
    Effect.annotateLogs({ ...input }),
  );
}

function logLifecycleDiagnostic(agentSessionId: number, diagnostic: HarnessLifecycleDiagnostic) {
  return Effect.logWarning('Harness lifecycle evidence degraded').pipe(
    Effect.annotateLogs({
      agentSessionId,
      code: diagnostic.code,
      recordedAt: diagnostic.recordedAt,
    }),
  );
}

/**
 * Runs one source operation, falling back when the source cannot be read. A failure is recorded
 * under `failureKey` (which `refreshTurnEdges` reports) and logged once until the source recovers.
 */
function sourceOrElse<A, R>(
  agentSessionId: number,
  path: string,
  reason: string,
  effect: Effect.Effect<A, HarnessSourceUnreadable | AgentSessionArtifactError, R>,
  fallback: A,
  failureKeys: Set<string>,
  failureKey = path,
): Effect.Effect<A, never, R> {
  return effect.pipe(
    Effect.map((value) => {
      failureKeys.delete(failureKey);
      return value;
    }),
    Effect.catchTag(['HarnessSourceUnreadable', 'AgentSessionArtifactError'], (error) =>
      Effect.suspend(() => {
        if (failureKeys.has(failureKey)) return Effect.succeed(fallback);
        failureKeys.add(failureKey);
        return Effect.logWarning('Harness observation source could not be refreshed').pipe(
          Effect.annotateLogs({
            agentSessionId,
            path,
            reason,
            cause: describeOperationalCause(error),
          }),
          Effect.as(fallback),
        );
      }),
    ),
  );
}
