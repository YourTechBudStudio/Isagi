/**
 * Operation identity: what makes two capability calls the same call.
 *
 * Pure. Nothing here touches a database, a process or a clock — it decides what a normalized request
 * is, what its fingerprint covers, and what a recorded prefix permits. The service applies those
 * decisions; keeping them separable is what lets the prefix rules be tested without a PTY.
 */

import type {
  WorkflowAgentHarness,
  WorkflowPromptModifiers,
} from '@yourtechbudstudio/isagi-workflow-sdk';

import type { WorkflowCapability, WorkflowOperationState } from '@isagi/contracts';

import type { WorkflowOperationRecord } from '../persistence/records.js';

/**
 * The author's intent for one call, and the only thing the fingerprint covers.
 *
 * `renderedPrompt` rather than the raw prompt plus modifiers, because the rendered text is what
 * actually crosses the boundary: two different modifier sets that render identically are the same
 * effect, and the same modifiers rendering differently under an edited harness definition are not.
 */
export type NormalizedRequest =
  | {
      readonly capability: 'send_agent_prompt';
      readonly agentSessionId: number;
      readonly renderedPrompt: string;
    }
  | {
      readonly capability: 'spawn_agent_session';
      readonly harness: WorkflowAgentHarness;
      readonly model: string | null;
      readonly effort: string | null;
      readonly renderedPrompt: string;
    }
  | {
      readonly capability: 'run_headless_agent';
      readonly harness: WorkflowAgentHarness;
      readonly model: string | null;
      readonly effort: string | null;
      /**
       * What the *author* asked for, so an omitted timeout stays omitted in the identity.
       *
       * The timeout actually used lives in `OperationRequestEnvelope.dispatch`. Folding the resolved
       * default in here would make the runtime's own constant part of author intent: changing it
       * would give every in-flight operation that omitted the field a different fingerprint, and the
       * next recovery would reject the unchanged callback with `operation_request_changed`.
       */
      readonly timeoutMs: number | null;
      readonly renderedPrompt: string;
    }
  | { readonly capability: 'close_pane'; readonly paneId: number };

/** Runtime-chosen dispatch configuration: durable, reused on redispatch, never part of identity. */
export interface OperationDispatchConfig {
  readonly effectiveTimeoutMs?: number | undefined;
}

/**
 * Inspector-facing detail that must survive but must not shift identity.
 *
 * Modifiers are already folded into `renderedPrompt`, so recording them here adds no hash meaning —
 * it only lets the inspector show what the author wrote instead of only what was sent.
 */
export interface OperationRequestMetadata {
  readonly modifiers?: WorkflowPromptModifiers | undefined;
}

/** What is stored in `workflow_operations.request`. Only `request` is fingerprinted. */
export interface OperationRequestEnvelope {
  readonly request: NormalizedRequest;
  readonly dispatch: OperationDispatchConfig | null;
  readonly metadata: OperationRequestMetadata | null;
}

export function requestEnvelope(input: {
  readonly request: NormalizedRequest;
  readonly dispatch?: OperationDispatchConfig | undefined;
  readonly metadata?: OperationRequestMetadata | undefined;
}): OperationRequestEnvelope {
  return {
    request: input.request,
    dispatch: input.dispatch ?? null,
    metadata: input.metadata ?? null,
  };
}

/**
 * Read back a recorded envelope.
 *
 * Tolerant on purpose: an operation whose payload is unreadable must still be classifiable from its
 * own columns, so callers get `null` and fall back to column evidence rather than failing recovery.
 */
export function readRequestEnvelope(value: unknown): OperationRequestEnvelope | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<OperationRequestEnvelope>;
  if (typeof candidate.request !== 'object' || candidate.request === null) return null;
  return {
    request: candidate.request as NormalizedRequest,
    dispatch: (candidate.dispatch ?? null) as OperationDispatchConfig | null,
    metadata: (candidate.metadata ?? null) as OperationRequestMetadata | null,
  };
}

/**
 * What re-entering a callback may do at one recorded call position.
 *
 * `dispatch` covers both first entry and recovery from a position whose effect provably never left;
 * §10.3 makes them the same transition deliberately, because they are the same fact — a recorded
 * intent with no external consequence.
 */
export type PrefixDecision =
  | { readonly kind: 'dispatch'; readonly existing: WorkflowOperationRecord | null }
  | { readonly kind: 'reuse'; readonly existing: WorkflowOperationRecord }
  | {
      readonly kind: 'request_changed';
      readonly existing: WorkflowOperationRecord;
      readonly recordedFingerprint: string;
    }
  | { readonly kind: 'uncertain'; readonly blocking: WorkflowOperationRecord }
  | { readonly kind: 'prefix_unresolved'; readonly blocking: WorkflowOperationRecord };

/**
 * Decide what a call at `callIndex` may do, given every operation already recorded for this
 * execution.
 *
 * The blocking condition is unresolved **uncertainty**, never outstanding external work: launching a
 * second headless judgment while the first is still `dispatched` is the ordinary way to build a
 * multi-operation wait, while adding any effect on top of a delivery nobody can establish is not.
 */
export function decidePrefix(input: {
  readonly callIndex: number;
  readonly capability: WorkflowCapability;
  readonly fingerprint: string;
  readonly recorded: readonly WorkflowOperationRecord[];
}): PrefixDecision {
  const earlierUncertain = input.recorded.find(
    (record) => record.callIndex < input.callIndex && record.state === 'uncertain',
  );
  if (earlierUncertain) {
    return { kind: 'prefix_unresolved', blocking: earlierUncertain };
  }

  const existing = input.recorded.find((record) => record.callIndex === input.callIndex);
  if (!existing) return { kind: 'dispatch', existing: null };

  if (
    existing.capability !== input.capability ||
    existing.requestFingerprint !== input.fingerprint
  ) {
    return {
      kind: 'request_changed',
      existing,
      recordedFingerprint: existing.requestFingerprint,
    };
  }

  switch (existing.state) {
    // A recorded position whose effect provably never crossed the boundary. Dispatching now keeps
    // the operation identity, which is what stops a repaired segment from allocating a second one.
    case 'intended':
    case 'abandoned':
      return { kind: 'dispatch', existing };
    case 'uncertain':
      return { kind: 'uncertain', blocking: existing };
    default:
      return { kind: 'reuse', existing };
  }
}

/** Settled states. Kept next to `decidePrefix` so the two cannot drift apart. */
export function isSettled(state: WorkflowOperationState): boolean {
  return state !== 'intended' && state !== 'dispatched';
}
