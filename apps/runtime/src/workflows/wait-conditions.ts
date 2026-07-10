// Pure parsing + edge helpers shared across the engine layer, the continue/resume
// paths, and the live-path reconcilers. No service dependencies — just turn the
// persisted JSON columns (`wait_condition`, `state_json`, `resume_payload`) into
// typed values, and classify turn edges.

import type { WorkflowResumePayload } from './repository.js';
import type { WorkflowRunRow, WorkflowWaitCondition } from './types.js';

export type TerminalTurnEdge = {
  readonly type: 'turn_ended' | 'turn_failed';
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly seq?: number | null | undefined;
  readonly recordedAt: string;
  readonly reason?: string | undefined;
};

export type TurnStartedEdge = {
  readonly type: 'turn_started';
  readonly agentSessionId: number;
  readonly harnessSessionId: string;
  readonly seq?: number | null | undefined;
  readonly recordedAt: string;
};

export type WorkflowObservedTurnEdge = TurnStartedEdge | TerminalTurnEdge;

export function isTerminalTurnEdge(edge: { readonly type: string }): edge is TerminalTurnEdge {
  return edge.type === 'turn_ended' || edge.type === 'turn_failed';
}

export function hasInFlightTurn(edges: readonly WorkflowObservedTurnEdge[]) {
  const activeByHarnessSessionId = new Map<string, number | null>();
  for (const edge of edges) {
    if (edge.type === 'turn_started') {
      activeByHarnessSessionId.set(
        edge.harnessSessionId,
        typeof edge.seq === 'number' ? edge.seq : null,
      );
      continue;
    }
    const activeSeq = activeByHarnessSessionId.get(edge.harnessSessionId);
    if (activeSeq === undefined) continue;
    if (typeof edge.seq !== 'number' || edge.seq === activeSeq) {
      activeByHarnessSessionId.delete(edge.harnessSessionId);
    }
  }
  return activeByHarnessSessionId.size > 0;
}

export function findSatisfiedTerminalTurnEdge(
  condition: Extract<WorkflowWaitCondition, { readonly kind: 'agent_turn' }>,
  edges: readonly WorkflowObservedTurnEdge[],
): TerminalTurnEdge | null {
  const start = edges
    .filter(
      (edge): edge is TurnStartedEdge =>
        edge.type === 'turn_started' &&
        edge.agentSessionId === condition.agentSessionId &&
        edge.recordedAt >= condition.sentAt,
    )
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))[0];
  if (!start) return null;

  return (
    edges
      .filter(
        (edge): edge is TerminalTurnEdge =>
          isTerminalTurnEdge(edge) &&
          edge.agentSessionId === start.agentSessionId &&
          edge.harnessSessionId === start.harnessSessionId &&
          terminalMatchesStart(start, edge),
      )
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))[0] ?? null
  );
}

function terminalMatchesStart(start: TurnStartedEdge, terminal: TerminalTurnEdge) {
  if (typeof terminal.seq === 'number') {
    return start.seq === terminal.seq;
  }

  // Null-sequence failures are retained only for genuinely uncorrelated legacy
  // process failures. Native provider terminals always pair by opening seq.
  return start.recordedAt <= terminal.recordedAt;
}

export function resumePayload(edge: {
  readonly type: 'turn_ended' | 'turn_failed';
  readonly recordedAt: string;
  readonly reason?: string | undefined;
}): WorkflowResumePayload {
  if (edge.type === 'turn_failed') {
    return {
      outcome: 'failed',
      recordedAt: edge.recordedAt,
      reason: edge.reason ?? 'unknown',
    };
  }
  return { outcome: 'ended', recordedAt: edge.recordedAt };
}

export function parseTurnWaitCondition(run: WorkflowRunRow) {
  if (!run.waitCondition) return null;
  try {
    const parsed = JSON.parse(run.waitCondition) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { readonly kind?: unknown }).kind === 'agent_turn'
    ) {
      return parsed as WorkflowWaitCondition & { readonly kind: 'agent_turn' };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseUserInputWaitCondition(run: WorkflowRunRow) {
  if (!run.waitCondition) return null;
  try {
    const parsed = JSON.parse(run.waitCondition) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { readonly kind?: unknown }).kind === 'user_input' &&
      Array.isArray((parsed as { readonly questions?: unknown }).questions)
    ) {
      return parsed as Extract<WorkflowWaitCondition, { readonly kind: 'user_input' }>;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseHeadlessWaitCondition(run: WorkflowRunRow) {
  if (!run.waitCondition) return null;
  try {
    const parsed = JSON.parse(run.waitCondition) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { readonly kind?: unknown }).kind === 'headless_agent' &&
      Array.isArray((parsed as { readonly ops?: unknown }).ops)
    ) {
      return parsed as Extract<WorkflowWaitCondition, { readonly kind: 'headless_agent' }>;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseWorkflowWaitCondition(run: WorkflowRunRow) {
  if (!run.waitCondition) return null;
  try {
    const parsed = JSON.parse(run.waitCondition) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { readonly kind?: unknown }).kind === 'workflow' &&
      Array.isArray((parsed as { readonly runIds?: unknown }).runIds)
    ) {
      return parsed as Extract<WorkflowWaitCondition, { readonly kind: 'workflow' }>;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseState(run: WorkflowRunRow) {
  try {
    return JSON.parse(run.stateJson) as unknown;
  } catch (cause) {
    throw new Error(`Workflow run ${run.id} has invalid state_json.`, { cause });
  }
}

export function parseResumePayload(run: WorkflowRunRow) {
  if (!run.resumePayload) return undefined;
  try {
    return JSON.parse(run.resumePayload) as unknown;
  } catch (cause) {
    throw new Error(`Workflow run ${run.id} has invalid resume_payload.`, { cause });
  }
}
