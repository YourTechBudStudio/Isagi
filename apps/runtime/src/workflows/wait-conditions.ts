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

export function findSatisfiedTerminalTurnEdge(
  condition: Extract<WorkflowWaitCondition, { readonly kind: 'agent_turn' }>,
  edges: readonly WorkflowObservedTurnEdge[],
): TerminalTurnEdge | null {
  const openStarts: TurnStartedEdge[] = [];

  for (const edge of edges) {
    if (
      edge.agentSessionId !== condition.agentSessionId ||
      edge.harnessSessionId !== condition.harnessSessionId
    ) {
      continue;
    }

    if (edge.type === 'turn_started') {
      openStarts.push(edge);
      continue;
    }

    const start = matchedStart(openStarts, edge);
    if (start) {
      removeStart(openStarts, start);
      if (start.recordedAt >= condition.sentAt) return edge;
    }
  }

  return null;
}

function matchedStart(
  openStarts: readonly TurnStartedEdge[],
  terminal: TerminalTurnEdge,
): TurnStartedEdge | null {
  if (typeof terminal.seq === 'number') {
    const sameSeq = openStarts.find((start) => start.seq === terminal.seq);
    if (sameSeq) return sameSeq;
  }

  for (let index = openStarts.length - 1; index >= 0; index -= 1) {
    const start = openStarts[index];
    if (start && start.recordedAt <= terminal.recordedAt) return start;
  }

  return null;
}

function removeStart(openStarts: TurnStartedEdge[], start: TurnStartedEdge) {
  const index = openStarts.indexOf(start);
  if (index >= 0) openStarts.splice(index, 1);
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
