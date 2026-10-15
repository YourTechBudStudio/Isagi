import type { AgentHarness, AttentionState, SessionStatus } from '@isagi/contracts';

import { attributeCodexRecords } from './codex/attribution.js';
import { activeCodexStreamCandidates, selectConfirmedCodexPrimary } from './codex/identity.js';
import type { CodexRolloutRecord } from './codex/lifecycle.js';
import { harnessDefinition } from './definitions.js';
import type { ExecutionInterval, Incarnation } from './incarnation.js';
import type { AgentSessionHarnessMetadataRead } from './ledger.js';
import {
  lifecycleTurnEdges,
  reduceHarnessLifecycle,
  type HarnessLifecycleDiagnostic,
  type HarnessTurnEdge,
} from './lifecycle.js';
import type { ActiveExecution } from './observation-targets.js';
import {
  harnessObservationProjectionFromRecords,
  type HarnessObservationProjection,
  type HarnessObservationRecord,
} from './projection.js';

export type ProcessFact = {
  readonly status: SessionStatus;
  readonly statusReason: string | null;
};

export type FileCursor = {
  readonly identity: string;
  readonly offset: number;
  readonly trailingBytes: Buffer;
};

export type ObservedHarnessTurnEdge = HarnessTurnEdge & {
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
};

export type AgentObserverState = {
  readonly ledgerCursors: Map<string, FileCursor>;
  readonly rolloutCursors: Map<string, FileCursor & { readonly harnessSessionId: string }>;
  readonly recordsByHarnessSessionId: Map<string, HarnessObservationRecord[]>;
  readonly codexRecordsByHarnessSessionId: Map<string, CodexRolloutRecord[]>;
  readonly nextSeqByHarnessSessionId: Map<string, number>;
  readonly nextCodexSeqByHarnessSessionId: Map<string, number>;
  stickyFailures: Map<string, ObservedHarnessTurnEdge>;
  publishedEdgeKeys: Set<string>;
  publishedDiagnosticKeys: Set<string>;
  readonly failedSourcePaths: Set<string>;
  readonly failedOperationKeys: Set<string>;
  metadata: AgentSessionHarnessMetadataRead;
  projection: HarnessObservationProjection;
  edges: readonly ObservedHarnessTurnEdge[];
  attention: AttentionState;
  projectionMarker: string;
  confirmedCodexHarnessSessionIds: Set<string>;
  readonly codexLocatorMissCounts: Map<string, number>;
  initialized: boolean;
};

export function createAgentObserverState(
  metadata: AgentSessionHarnessMetadataRead,
): AgentObserverState {
  return {
    ledgerCursors: new Map(),
    rolloutCursors: new Map(),
    recordsByHarnessSessionId: new Map(),
    codexRecordsByHarnessSessionId: new Map(),
    nextSeqByHarnessSessionId: new Map(),
    nextCodexSeqByHarnessSessionId: new Map(),
    stickyFailures: new Map(),
    publishedEdgeKeys: new Set(),
    publishedDiagnosticKeys: new Set(),
    failedSourcePaths: new Set(),
    failedOperationKeys: new Set(),
    metadata,
    projection: { recordsByHarnessSessionId: new Map() },
    edges: [],
    attention: 'idle',
    projectionMarker: '',
    confirmedCodexHarnessSessionIds: new Set(),
    codexLocatorMissCounts: new Map(),
    initialized: false,
  };
}

export function projectAgentObserverState(input: {
  readonly agentSessionId: number;
  readonly harness: AgentHarness | undefined;
  readonly state: AgentObserverState;
  readonly active: ActiveExecution | null;
  readonly intervals: ReadonlyArray<ExecutionInterval>;
  readonly processFacts: ReadonlyMap<number, ProcessFact>;
}) {
  const live = activeIncarnationIsLive(input);
  const activeIncarnation = input.active?.incarnation ?? null;
  const recordsByHarnessSessionId = new Map<string, readonly HarnessObservationRecord[]>(
    [...input.state.recordsByHarnessSessionId.entries()].map(([id, records]) => [id, records]),
  );
  const projection = harnessObservationProjectionFromRecords(recordsByHarnessSessionId);
  const streamIds = new Set([
    ...recordsByHarnessSessionId.keys(),
    ...input.state.codexRecordsByHarnessSessionId.keys(),
  ]);
  const edges: ObservedHarnessTurnEdge[] = [];
  const diagnostics: HarnessLifecycleDiagnostic[] = [];
  const attentionByHarnessSessionId = new Map<string, AttentionState>();
  const stickyFailures = new Map(input.state.stickyFailures);
  if (!input.harness) {
    return {
      projection,
      edges,
      attention: 'idle' as const,
      marker: markerString([
        metadataMarker(input.state.metadata),
        activeIncarnation,
        live,
        input.intervals.length,
        'idle',
      ]),
      diagnostics,
      stickyFailures,
    };
  }
  const definition = harnessDefinition(input.harness);

  for (const harnessSessionId of streamIds) {
    const hookRecords = recordsByHarnessSessionId.get(harnessSessionId) ?? [];
    const records = currentIncarnationRecords(hookRecords);
    const codexRecords = currentIncarnationRecords(
      attributeCodexRecords({
        records: input.state.codexRecordsByHarnessSessionId.get(harnessSessionId) ?? [],
        sessionStarts: hookRecords
          .filter((record) => record.nativeEvent === 'SessionStart')
          .map((record) => ({ incarnation: record.incarnation, recordedAt: record.recordedAt })),
        intervals: input.intervals,
      }),
    );
    const lifecycle = reduceHarnessLifecycle({ harness: input.harness, records, codexRecords });
    diagnostics.push(...lifecycle.diagnostics);
    let streamAttention = lifecycle.attention;
    const observed = lifecycleTurnEdges({
      lifecycle,
      openingRecordedAt: (seq) =>
        definition.lifecycle.openingRecordedAt({ records, codexRecords }, seq),
    }).map((edge) => ({
      ...edge,
      agentSessionId: input.agentSessionId,
      harnessSessionId,
    }));

    if (lifecycle.activeTurn && activeTurnIsDead(lifecycle.activeTurn, input)) {
      const failure: ObservedHarnessTurnEdge = {
        type: 'turn_failed',
        agentSessionId: input.agentSessionId,
        harnessSessionId,
        seq: lifecycle.activeTurn.seq,
        recordedAt: lifecycle.activeTurn.recordedAt,
        reason: 'session_died',
      };
      stickyFailures.set(turnKey(harnessSessionId, lifecycle.activeTurn.seq), failure);
      streamAttention = 'error';
    }
    const currentSticky = [...stickyFailures.values()].filter(
      (edge) => edge.harnessSessionId === harnessSessionId,
    );
    edges.push(...mergeStickyFailures(observed, currentSticky));
    if (currentSticky.length > 0 && lifecycle.activeTurn === null) {
      const latestFailureSeq = Math.max(
        ...currentSticky.map((failure) => (typeof failure.seq === 'number' ? failure.seq : -1)),
      );
      const latestTerminalSeq = Math.max(
        -1,
        ...lifecycle.terminalEdges.map((edge) => (typeof edge.seq === 'number' ? edge.seq : -1)),
      );
      if (latestFailureSeq >= latestTerminalSeq) streamAttention = 'error';
    }
    attentionByHarnessSessionId.set(harnessSessionId, streamAttention);
  }

  const selectedHarnessSessionId = selectedMetadataHarnessSessionId(input.state.metadata);
  const attention =
    input.harness === 'codex'
      ? codexAttention({
          recordsByHarnessSessionId,
          attentionByHarnessSessionId,
          activeIncarnation,
          selectedHarnessSessionId,
          confirmedHarnessSessionIds: input.state.confirmedCodexHarnessSessionIds,
          locatorMissCounts: input.state.codexLocatorMissCounts,
        })
      : selectedHarnessSessionId
        ? (attentionByHarnessSessionId.get(selectedHarnessSessionId) ?? 'idle')
        : 'idle';
  const marker = markerString([
    metadataMarker(input.state.metadata),
    activeIncarnation,
    live,
    input.intervals.length,
    attention,
  ]);
  return { projection, edges, attention, marker, diagnostics, stickyFailures };
}

export function commitAgentObserverState(
  state: AgentObserverState,
  result: ReturnType<typeof projectAgentObserverState>,
) {
  state.projection = result.projection;
  state.edges = result.edges;
  state.attention = result.attention;
  state.projectionMarker = result.marker;
  state.stickyFailures = result.stickyFailures;
}

export function edgeKey(edge: ObservedHarnessTurnEdge) {
  return [
    edge.type,
    edge.agentSessionId,
    edge.harnessSessionId,
    edge.seq,
    edge.recordedAt,
    edge.type === 'turn_failed' ? edge.reason : '',
  ].join(':');
}

export function diagnosticKey(diagnostic: HarnessLifecycleDiagnostic) {
  return [diagnostic.code, diagnostic.recordedAt, diagnostic.detail ?? ''].join(':');
}

export function metadataMarker(metadata: AgentSessionHarnessMetadataRead) {
  switch (metadata.status) {
    case 'valid':
      return ['valid', metadata.metadata.harnessSessionId] as const;
    case 'missing':
      return ['missing'] as const;
    case 'invalid':
      return ['invalid', metadata.diagnostic] as const;
  }
}

export function markerString(value: unknown) {
  return JSON.stringify(value);
}

const CODEX_MISSING_NATIVE_ARTIFACT_GRACE_POLLS = 2;

function codexAttention(input: {
  readonly recordsByHarnessSessionId: ReadonlyMap<string, readonly HarnessObservationRecord[]>;
  readonly attentionByHarnessSessionId: ReadonlyMap<string, AttentionState>;
  readonly activeIncarnation: Incarnation | null;
  readonly selectedHarnessSessionId: string | null;
  readonly confirmedHarnessSessionIds: ReadonlySet<string>;
  readonly locatorMissCounts: ReadonlyMap<string, number>;
}): AttentionState {
  const activeCandidates = activeCodexStreamCandidates(
    input.recordsByHarnessSessionId,
    input.activeIncarnation,
  );
  // Attention describes the thread the user is currently talking to, so it must
  // follow the same primary selection the observer uses to promote resumable
  // identity. Superseded threads (`/clear`, an in-process thread switch) keep
  // their history and lifecycle edges, but their terminal state must not keep
  // the session pinned to `working` or `error`.
  const primaryHarnessSessionId = selectConfirmedCodexPrimary({
    candidates: activeCandidates,
    confirmedHarnessSessionIds: input.confirmedHarnessSessionIds,
    currentHarnessSessionId: input.selectedHarnessSessionId,
  });
  if (primaryHarnessSessionId) {
    return input.attentionByHarnessSessionId.get(primaryHarnessSessionId) ?? 'idle';
  }
  const unresolvedIds = activeCandidates.map((candidate) => candidate.harnessSessionId);
  if (
    unresolvedIds.some(
      (harnessSessionId) =>
        (input.locatorMissCounts.get(harnessSessionId) ?? 0) >=
        CODEX_MISSING_NATIVE_ARTIFACT_GRACE_POLLS,
    )
  ) {
    return 'error';
  }
  return 'idle';
}

function selectedMetadataHarnessSessionId(metadata: AgentSessionHarnessMetadataRead) {
  return metadata.status === 'valid' ? metadata.metadata.harnessSessionId : null;
}

export interface ExecutionLiveness {
  readonly active: ActiveExecution | null;
  readonly processFacts: ReadonlyMap<number, ProcessFact>;
}

/** Whether the active execution can still write: a starting or running PTY, or a live SDK worker. */
export function activeIncarnationIsLive(input: ExecutionLiveness): boolean {
  const active = input.active;
  if (active === null) return false;
  if (active.kind === 'sdk') return active.live;
  const status = input.processFacts.get(active.ptyProcessId)?.status ?? active.status;
  return status === 'running' || status === 'starting';
}

/**
 * An open turn is dead when its execution was replaced or is no longer live. An unattributed turn
 * (`null`) is never dead, because nothing is known about the execution that opened it.
 */
function activeTurnIsDead(
  turn: { readonly incarnation: Incarnation | null },
  input: ExecutionLiveness,
) {
  if (turn.incarnation === null) return false;
  return turn.incarnation !== input.active?.incarnation || !activeIncarnationIsLive(input);
}

/**
 * Records in arrival order, dropping a late record from an execution that a newer one already
 * replaced. Unattributed records are always kept.
 */
function currentIncarnationRecords<A extends { readonly incarnation: Incarnation | null }>(
  records: readonly A[],
): readonly A[] {
  const seen = new Set<Incarnation>();
  let current: Incarnation | null = null;
  const accepted: A[] = [];
  for (const record of records) {
    if (record.incarnation === null) {
      accepted.push(record);
      continue;
    }
    if (current === record.incarnation) {
      accepted.push(record);
      continue;
    }
    if (seen.has(record.incarnation)) continue;
    current = record.incarnation;
    seen.add(record.incarnation);
    accepted.push(record);
  }
  return accepted;
}

/**
 * Records `interval` in the agent's list, ordered by `since`; a tie goes after existing entries.
 * A read that seeds an interval can run before an earlier switch event is handled, and attribution
 * needs the list in time order, which is also switch order.
 */
export function insertExecutionInterval(
  intervals: ExecutionInterval[],
  interval: ExecutionInterval,
) {
  const since = Date.parse(interval.since);
  const index = intervals.findIndex((existing) => Date.parse(existing.since) > since);
  if (index < 0) intervals.push(interval);
  else intervals.splice(index, 0, interval);
}

function mergeStickyFailures(
  observed: readonly ObservedHarnessTurnEdge[],
  stickyFailures: readonly ObservedHarnessTurnEdge[],
) {
  const stickyBySeq = new Map(stickyFailures.map((failure) => [failure.seq, failure]));
  const merged = observed.flatMap((edge) => {
    if (edge.type === 'turn_started') return [edge];
    const sticky = stickyBySeq.get(edge.seq);
    if (!sticky) return [edge];
    stickyBySeq.delete(edge.seq);
    return [sticky];
  });
  for (const failure of stickyBySeq.values()) {
    const startIndex = merged.findIndex(
      (edge) => edge.type === 'turn_started' && edge.seq === failure.seq,
    );
    if (startIndex < 0) merged.push(failure);
    else merged.splice(startIndex + 1, 0, failure);
  }
  return merged;
}

function turnKey(harnessSessionId: string, seq: number) {
  return `${harnessSessionId}:${seq}`;
}
