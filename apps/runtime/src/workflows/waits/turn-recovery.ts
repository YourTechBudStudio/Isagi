import { Schema } from 'effect';

import { workflowRunPositionSchema, type WorkflowRunPosition } from '@isagi/contracts';

import type { HarnessTurnReference } from '../../agent-sessions/harness/definition-types.js';
import type { WorkflowOperationRecord, WorkflowExecutionRecord } from '../persistence/records.js';
import { encodeRunPosition } from '../persistence/row-mappers.js';
import { isPlainObject } from '../state/reducers.js';
import type { AgentTurnEvent, WaitDeclaration } from '../types.js';
import {
  selectTurnAssociation,
  terminalForFixedAssociation,
  type TurnStartedEdge,
  type WorkflowObservedTurnEdge,
} from './conditions.js';

/** Runtime-owned metadata on the ordinary agent-turn wait used by an explicit Retry. */
export interface RetryTurnRecovery {
  readonly kind: 'explicit_retry';
  readonly sourceWaitId: number;
  readonly resumePosition: WorkflowRunPosition;
  readonly turn: HarnessTurnReference;
}

export type RecoveryWaitDeclaration = Extract<WaitDeclaration, { kind: 'agent_turn' }> & {
  readonly isagiRecovery: RetryTurnRecovery;
};

/** The immutable retry operand copied into the segment attempt that consumes it. */
export interface AttemptTurnRecovery {
  readonly waitId: number;
  readonly agentSessionId: number;
  readonly turn: HarnessTurnReference;
  readonly event: AgentTurnEvent;
}

export interface SourceAgentTurnWait {
  readonly waitId: number;
  readonly declaration: Extract<WaitDeclaration, { kind: 'agent_turn' }>;
  readonly event: AgentTurnEvent;
}

export type RetryTurnRecoveryPlan =
  | { readonly kind: 'arm'; readonly declaration: RecoveryWaitDeclaration }
  | { readonly kind: 'reuse'; readonly declaration: RecoveryWaitDeclaration };

export function isAgentTurnEvent(value: unknown): value is AgentTurnEvent {
  return (
    isPlainObject(value) &&
    value.kind === 'agent_turn' &&
    (value.outcome === 'ended' || value.outcome === 'failed' || value.outcome === 'interrupted') &&
    typeof value.recordedAt === 'string'
  );
}

export function attemptTurnRecovery(value: unknown): AttemptTurnRecovery | null {
  if (!isPlainObject(value) || !isPlainObject(value.agentTurnRecovery)) return null;
  const recovery = value.agentTurnRecovery;
  if (
    typeof recovery.waitId !== 'number' ||
    typeof recovery.agentSessionId !== 'number' ||
    !isPlainObject(recovery.turn) ||
    typeof recovery.turn.harnessSessionId !== 'string' ||
    typeof recovery.turn.seq !== 'number' ||
    typeof recovery.turn.startedAt !== 'string' ||
    !isAgentTurnEvent(recovery.event)
  ) {
    return null;
  }
  return recovery as unknown as AttemptTurnRecovery;
}

/** Which execution can provide agent-turn provenance for this failed graph position. */
export function recoverySourceExecution(
  position: Extract<WorkflowRunPosition, { kind: 'node_callback' | 'routing' }>,
  executions: readonly WorkflowExecutionRecord[],
): WorkflowExecutionRecord | null {
  const index = executions.findIndex((execution) => execution.id === position.executionId);
  if (index < 0) return null;
  return position.kind === 'routing' ? executions[index]! : (executions[index - 1] ?? null);
}

/** Newest retained authored agent-turn wait from a resolved evidence list. */
export function sourceAgentTurnWait(
  waits: readonly {
    readonly waitId: number;
    readonly status: 'armed' | 'delivered' | 'consumed' | 'superseded';
    readonly condition: unknown;
    readonly event: unknown;
  }[],
): SourceAgentTurnWait | null {
  for (const wait of [...waits].reverse()) {
    if (wait.status !== 'delivered' && wait.status !== 'consumed') continue;
    if (
      recoveryWaitDeclaration(wait.condition) ||
      !isPlainObject(wait.condition) ||
      wait.condition.kind !== 'agent_turn' ||
      !isPlainObject(wait.condition.target) ||
      typeof wait.condition.target.agentSessionId !== 'number' ||
      typeof wait.condition.target.sentAt !== 'string' ||
      !isAgentTurnEvent(wait.event)
    ) {
      continue;
    }
    return {
      waitId: wait.waitId,
      declaration: wait.condition as unknown as Extract<WaitDeclaration, { kind: 'agent_turn' }>,
      event: wait.event,
    };
  }
  return null;
}

/**
 * The complete ADR 0009 selection policy, over evidence the Retry control has already gathered.
 * No IO or persistence: callers can test every policy branch without constructing the engine.
 */
export function selectRetryTurnRecovery(input: {
  readonly position: Extract<WorkflowRunPosition, { kind: 'node_callback' | 'routing' }>;
  readonly hasSavedProducerOutput: boolean;
  readonly source: SourceAgentTurnWait | null;
  readonly operations: readonly WorkflowOperationRecord[];
  readonly edges: readonly WorkflowObservedTurnEdge[];
  readonly existingRecoveries: readonly RecoveryWaitDeclaration[];
}): RetryTurnRecoveryPlan | null {
  if (input.hasSavedProducerOutput || !input.source) return null;
  if (input.position.kind === 'node_callback' && input.source.event.outcome !== 'ended')
    return null;

  const agentSessionId = input.source.declaration.target.agentSessionId;
  const latest = latestObservedTurn(agentSessionId, input.edges);
  if (!latest) return null;
  const submission = input.operations.find(
    (record) =>
      record.submissionWatermark === input.source!.declaration.target.sentAt &&
      (record.capability === 'send_agent_prompt' || record.capability === 'spawn_agent_session'),
  );
  const inferred = selectTurnAssociation(
    { agentSessionId, sentAt: input.source.declaration.target.sentAt },
    input.edges,
  );
  const original =
    submission?.correlatedHarnessSessionId !== null &&
    submission?.correlatedHarnessSessionId !== undefined &&
    typeof submission.correlatedStartSeq === 'number'
      ? {
          harnessSessionId: submission.correlatedHarnessSessionId,
          seq: submission.correlatedStartSeq,
        }
      : inferred.kind === 'fixed' && typeof inferred.startSeq === 'number'
        ? { harnessSessionId: inferred.harnessSessionId, seq: inferred.startSeq }
        : null;
  if (input.source.event.outcome !== 'ended' && sameTurn(original, latest)) return null;

  const declaration: RecoveryWaitDeclaration = {
    kind: 'agent_turn',
    target: { agentSessionId, sentAt: latest.startedAt },
    isagiRecovery: {
      kind: 'explicit_retry',
      sourceWaitId: input.source.waitId,
      resumePosition: input.position,
      turn: latest,
    },
  };
  const existing = input.existingRecoveries.find(
    (candidate) =>
      sameTurn(candidate.isagiRecovery.turn, latest) &&
      encodeRunPosition(candidate.isagiRecovery.resumePosition) ===
        encodeRunPosition(input.position),
  );
  return existing ? { kind: 'reuse', declaration: existing } : { kind: 'arm', declaration };
}

const decodePosition = Schema.decodeUnknownEither(workflowRunPositionSchema);

export function recoveryWaitDeclaration(value: unknown): RecoveryWaitDeclaration | null {
  if (!isPlainObject(value) || value.kind !== 'agent_turn' || !isPlainObject(value.target))
    return null;
  if (
    typeof value.target.agentSessionId !== 'number' ||
    typeof value.target.sentAt !== 'string' ||
    !isPlainObject(value.isagiRecovery)
  ) {
    return null;
  }
  const recovery = value.isagiRecovery;
  if (
    recovery.kind !== 'explicit_retry' ||
    typeof recovery.sourceWaitId !== 'number' ||
    !isPlainObject(recovery.turn) ||
    typeof recovery.turn.harnessSessionId !== 'string' ||
    typeof recovery.turn.seq !== 'number' ||
    typeof recovery.turn.startedAt !== 'string'
  ) {
    return null;
  }
  const position = decodePosition(recovery.resumePosition);
  if (position._tag === 'Left') return null;
  return {
    kind: 'agent_turn',
    target: {
      agentSessionId: value.target.agentSessionId,
      sentAt: value.target.sentAt,
    },
    isagiRecovery: {
      kind: 'explicit_retry',
      sourceWaitId: recovery.sourceWaitId,
      resumePosition: position.right,
      turn: {
        harnessSessionId: recovery.turn.harnessSessionId,
        seq: recovery.turn.seq,
        startedAt: recovery.turn.startedAt,
      },
    },
  };
}

/** Latest exact native turn visible in the durable ledger for this agent session. */
export function latestObservedTurn(
  agentSessionId: number,
  edges: readonly WorkflowObservedTurnEdge[],
): HarnessTurnReference | null {
  const starts = edges
    .filter(
      (edge): edge is TurnStartedEdge & { readonly seq: number } =>
        edge.type === 'turn_started' &&
        edge.agentSessionId === agentSessionId &&
        typeof edge.seq === 'number',
    )
    .sort((left, right) =>
      left.recordedAt === right.recordedAt
        ? left.seq - right.seq
        : left.recordedAt.localeCompare(right.recordedAt),
    );
  const latest = starts.at(-1);
  return latest
    ? { harnessSessionId: latest.harnessSessionId, seq: latest.seq, startedAt: latest.recordedAt }
    : null;
}

export function sameTurn(
  left: Pick<HarnessTurnReference, 'harnessSessionId' | 'seq'> | null,
  right: Pick<HarnessTurnReference, 'harnessSessionId' | 'seq'> | null,
) {
  return (
    left !== null &&
    right !== null &&
    left.harnessSessionId === right.harnessSessionId &&
    left.seq === right.seq
  );
}

export function terminalForRecovery(
  declaration: RecoveryWaitDeclaration,
  edges: readonly WorkflowObservedTurnEdge[],
) {
  return terminalForFixedAssociation(
    {
      agentSessionId: declaration.target.agentSessionId,
      sentAt: declaration.isagiRecovery.turn.startedAt,
      harnessSessionId: declaration.isagiRecovery.turn.harnessSessionId,
      startSeq: declaration.isagiRecovery.turn.seq,
    },
    edges,
  );
}

export function turnEventOf(terminal: {
  readonly type: 'turn_ended' | 'turn_failed';
  readonly recordedAt: string;
  readonly reason?: string | undefined;
}): AgentTurnEvent {
  if (terminal.type === 'turn_ended') {
    return { kind: 'agent_turn', outcome: 'ended', recordedAt: terminal.recordedAt };
  }
  if (terminal.reason === 'new_start_supersedes') {
    return {
      kind: 'agent_turn',
      outcome: 'interrupted',
      recordedAt: terminal.recordedAt,
      reason: 'superseded_by_new_turn',
    };
  }
  if (terminal.reason === 'session_died') {
    return {
      kind: 'agent_turn',
      outcome: 'interrupted',
      recordedAt: terminal.recordedAt,
      reason: 'session_died',
    };
  }
  return {
    kind: 'agent_turn',
    outcome: 'failed',
    recordedAt: terminal.recordedAt,
    reason: terminal.reason ?? 'harness_error',
  };
}
