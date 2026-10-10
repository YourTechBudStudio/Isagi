import type { AgentHarness, AttentionState, SessionStatus } from '@isagi/contracts';

import { activeCodexStreamCandidates, selectConfirmedCodexPrimary } from './codex/identity.js';
import type { CodexRolloutLifecycleRecord } from './codex/lifecycle.js';
import { harnessDefinition } from './definitions.js';
import type { AgentSessionHarnessMetadataRead } from './ledger.js';
import {
  lifecycleTurnEdges,
  reduceHarnessLifecycle,
  type HarnessLifecycleDiagnostic,
  type HarnessTurnEdge,
} from './lifecycle.js';
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
  readonly codexRecordsByHarnessSessionId: Map<string, CodexRolloutLifecycleRecord[]>;
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
  readonly activePtyProcessId: number | null;
  readonly processFacts: ReadonlyMap<number, ProcessFact>;
}) {
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
        input.activePtyProcessId,
        'idle',
      ]),
      diagnostics,
      stickyFailures,
    };
  }
  const definition = harnessDefinition(input.harness);

  for (const harnessSessionId of streamIds) {
    const records = currentIncarnationRecords(
      recordsByHarnessSessionId.get(harnessSessionId) ?? [],
    );
    const codexRecords = currentIncarnationRecords(
      input.state.codexRecordsByHarnessSessionId.get(harnessSessionId) ?? [],
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
          activePtyProcessId: input.activePtyProcessId,
          selectedHarnessSessionId,
          confirmedHarnessSessionIds: input.state.confirmedCodexHarnessSessionIds,
          locatorMissCounts: input.state.codexLocatorMissCounts,
        })
      : selectedHarnessSessionId
        ? (attentionByHarnessSessionId.get(selectedHarnessSessionId) ?? 'idle')
        : 'idle';
  const marker = markerString([
    metadataMarker(input.state.metadata),
    input.activePtyProcessId,
    input.activePtyProcessId === null
      ? null
      : (input.processFacts.get(input.activePtyProcessId) ?? null),
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
  readonly activePtyProcessId: number | null;
  readonly selectedHarnessSessionId: string | null;
  readonly confirmedHarnessSessionIds: ReadonlySet<string>;
  readonly locatorMissCounts: ReadonlyMap<string, number>;
}): AttentionState {
  const activeCandidates = activeCodexStreamCandidates(
    input.recordsByHarnessSessionId,
    input.activePtyProcessId,
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

function activeTurnIsDead(
  activeTurn: { readonly ptyProcessId: number | null },
  input: {
    readonly activePtyProcessId: number | null;
    readonly processFacts: ReadonlyMap<number, ProcessFact>;
  },
) {
  if (activeTurn.ptyProcessId === null) return false;
  const fact = input.processFacts.get(activeTurn.ptyProcessId);
  const live = fact?.status === 'running' || fact?.status === 'starting';
  return activeTurn.ptyProcessId !== input.activePtyProcessId || !live;
}

function currentIncarnationRecords<A extends { readonly ptyProcessId: number | null }>(
  records: readonly A[],
): readonly A[] {
  const seen = new Set<number>();
  let current: number | null = null;
  const accepted: A[] = [];
  for (const record of records) {
    if (record.ptyProcessId === null) {
      accepted.push(record);
      continue;
    }
    if (current === record.ptyProcessId) {
      accepted.push(record);
      continue;
    }
    if (seen.has(record.ptyProcessId)) continue;
    current = record.ptyProcessId;
    seen.add(record.ptyProcessId);
    accepted.push(record);
  }
  return accepted;
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
