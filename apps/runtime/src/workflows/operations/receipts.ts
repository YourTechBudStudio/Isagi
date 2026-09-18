/**
 * What each capability writes into `workflow_operations.receipt`.
 *
 * A receipt is the durable form of what a live callback would have been handed, which is why
 * recovery can reconstruct a return value without the callback's own memory. Every decoder here is
 * tolerant: a receipt that cannot be read must leave the operation classifiable from its columns
 * rather than fail recovery outright.
 */

import type { WorkflowAgentHarness } from '@yourtechbudstudio/isagi-workflow-sdk';

import type { PtyLaunchOutcome } from '../../pty-processes/types.js';

/** `send_agent_prompt`, and the turn half of `spawn_agent_session`. */
export interface AgentTurnReceipt {
  readonly agentSessionId: number;
  /** The persisted `submission_watermark` — generated and written *before* the PTY write. */
  readonly sentAt: string;
}

export interface SpawnSessionReceipt extends AgentTurnReceipt {
  readonly surfaceId: number;
  readonly paneId: number;
}

export interface HeadlessReceipt {
  readonly ptyProcessId: number;
  readonly harness: WorkflowAgentHarness;
  /**
   * The timeout this operation actually dispatched under.
   *
   * Durable so a redispatch under the same identity keeps it. A resumed operation must not silently
   * adopt a runtime default that changed underneath it; a genuinely new operation may.
   */
  readonly effectiveTimeoutMs: number;
  readonly launchedAt: string;
  readonly launchOutcome?: PtyLaunchOutcome | undefined;
  readonly launchFailureCause?: string | null | undefined;
}

export function readAgentTurnReceipt(value: unknown): AgentTurnReceipt | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<AgentTurnReceipt>;
  if (typeof candidate.agentSessionId !== 'number' || typeof candidate.sentAt !== 'string') {
    return null;
  }
  return { agentSessionId: candidate.agentSessionId, sentAt: candidate.sentAt };
}

export function readSpawnSessionReceipt(value: unknown): SpawnSessionReceipt | null {
  const turn = readAgentTurnReceipt(value);
  if (!turn) return null;
  const candidate = value as Partial<SpawnSessionReceipt>;
  if (typeof candidate.surfaceId !== 'number' || typeof candidate.paneId !== 'number') return null;
  return { ...turn, surfaceId: candidate.surfaceId, paneId: candidate.paneId };
}

export function readHeadlessReceipt(value: unknown): HeadlessReceipt | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<HeadlessReceipt>;
  if (typeof candidate.ptyProcessId !== 'number' || typeof candidate.harness !== 'string') {
    return null;
  }
  return {
    ptyProcessId: candidate.ptyProcessId,
    harness: candidate.harness,
    effectiveTimeoutMs:
      typeof candidate.effectiveTimeoutMs === 'number' ? candidate.effectiveTimeoutMs : 0,
    launchedAt: typeof candidate.launchedAt === 'string' ? candidate.launchedAt : '',
    ...(candidate.launchOutcome === undefined ? {} : { launchOutcome: candidate.launchOutcome }),
    ...(candidate.launchFailureCause === undefined
      ? {}
      : { launchFailureCause: candidate.launchFailureCause }),
  };
}
