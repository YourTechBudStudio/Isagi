import type { HarnessTurnReference } from '../agent-sessions/harness/definition-types.js';
import type { WorkflowResumePayload } from './repository.js';
import type { WorkflowRunRow, WorkflowWaitCondition } from './types.js';
import {
  findSatisfiedTerminalTurnEdge,
  resumePayload,
  type WorkflowObservedTurnEdge,
} from './wait-conditions.js';

export type AgentTurnWait = Extract<WorkflowWaitCondition, { kind: 'agent_turn' }> & {
  readonly retryTurn?: HarnessTurnReference | undefined;
};

// Runtime-only provenance. Never exposed as part of the SDK event. Kept with the
// driving event so failure, restart, and artifact refresh cannot lose its target.
export interface WorkflowTurnProvenance {
  readonly condition: AgentTurnWait;
}

export interface WorkflowTurnRetry {
  readonly runId: number;
  readonly expectedResumePayload: string | null;
  readonly expectedUpdatedAt: string;
  readonly condition: AgentTurnWait & { readonly retryTurn: HarnessTurnReference };
  readonly payload: Extract<WorkflowResumePayload, { readonly outcome: string }> | null;
}

export function turnProvenance(
  run: Pick<WorkflowRunRow, 'resumePayload'>,
): WorkflowTurnProvenance | null {
  if (!run.resumePayload) return null;
  try {
    const payload = JSON.parse(run.resumePayload) as {
      readonly agentTurn?: WorkflowTurnProvenance;
    } | null;
    const provenance = payload?.agentTurn;
    const condition = provenance?.condition;
    if (
      condition?.kind !== 'agent_turn' ||
      !Number.isSafeInteger(condition.agentSessionId) ||
      typeof condition.sentAt !== 'string'
    )
      return null;
    return provenance ?? null;
  } catch {
    return null; // The normal event parser reports malformed persisted JSON.
  }
}

export function completedRecoveryTurn(run: Pick<WorkflowRunRow, 'resumePayload'>) {
  const condition = turnProvenance(run)?.condition;
  if (!condition || !run.resumePayload) return null;
  const payload = JSON.parse(run.resumePayload) as {
    readonly outcome?: string;
    readonly recordedAt?: string;
  };
  if (payload.outcome !== 'ended' || !payload.recordedAt || !condition?.retryTurn) return null;
  return {
    agentSessionId: condition.agentSessionId,
    turn: { ...condition.retryTurn, completedAt: payload.recordedAt },
  };
}

/** Only explicit Retry may replace the original turn with the latest session turn. */
export function planAgentTurnRetry(
  run: WorkflowRunRow,
  edges: readonly WorkflowObservedTurnEdge[],
): WorkflowTurnRetry | null {
  const source = turnProvenance(run)?.condition;
  if (!source || !run.resumePayload) return null;
  const event = JSON.parse(run.resumePayload) as {
    readonly outcome?: string;
    readonly recordedAt?: string;
  };
  if ((event.outcome !== 'failed' && event.outcome !== 'ended') || !event.recordedAt) return null;
  const latest = edges
    .filter(
      (edge) =>
        edge.type === 'turn_started' &&
        edge.agentSessionId === source.agentSessionId &&
        edge.recordedAt >= source.sentAt,
    )
    .sort(
      (left, right) =>
        left.recordedAt.localeCompare(right.recordedAt) || (left.seq ?? -1) - (right.seq ?? -1),
    )
    .at(-1);
  if (
    !latest ||
    typeof latest.seq !== 'number' ||
    (event.outcome === 'failed' && latest.recordedAt < event.recordedAt)
  )
    return null;
  const condition: WorkflowTurnRetry['condition'] = {
    kind: 'agent_turn',
    agentSessionId: source.agentSessionId,
    sentAt: source.sentAt,
    retryTurn: {
      harnessSessionId: latest.harnessSessionId,
      seq: latest.seq,
      startedAt: latest.recordedAt,
    },
  };
  const terminal = findSatisfiedTerminalTurnEdge(condition, edges);
  if (terminal && terminal.recordedAt < event.recordedAt) return null;
  if (!terminal && latest.recordedAt < event.recordedAt) return null;
  return {
    runId: run.id,
    expectedResumePayload: run.resumePayload,
    expectedUpdatedAt: run.updatedAt,
    condition,
    payload: terminal ? resumePayload(terminal, condition) : null,
  };
}
