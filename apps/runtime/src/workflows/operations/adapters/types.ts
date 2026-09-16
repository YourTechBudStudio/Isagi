/**
 * One operation contract, implemented twice: by the real owners, and by deterministic test doubles.
 *
 * The split is deliberate about *where* the seam is. Adapters own owner calls — creating a keyed
 * pane and session, allocating a PTY, writing to it, reading a harness ledger. They own no ordering
 * and no durable marker: every intent write, stage advance and settlement lives in the operation
 * service, so there is exactly one place that decides what is written before which boundary. A fake
 * that got that ordering wrong would prove nothing about the real one.
 */

import type {
  WorkflowAgentHarness,
  WorkflowConversationMessage,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import type { Effect } from 'effect';

import type { PtyTerminateOutcome } from '../../../pty-processes/index.js';
import type { PtyProcessAllocation } from '../../../pty-processes/types.js';
import type { WorkflowObservedTurnEdge } from '../../waits/conditions.js';

/** A session and the live process behind it, resolved before any durable marker is written. */
export interface PreparedSubmission {
  readonly agentSessionId: number;
  readonly ptyProcessId: number;
}

/**
 * The resource half of the compound spawn: pane, session and association, with no process yet.
 *
 * Separate from the seed half because it is separately recoverable. Nothing has crossed a PTY
 * boundary at this point, so resuming here is safe, and the durable stage that records it is the
 * first thing spawn can honestly claim.
 */
export interface CreatedKeyedSession {
  readonly surfaceId: number;
  readonly paneId: number;
  readonly agentSessionId: number;
}

export interface CapturedOutput {
  readonly raw: string;
  readonly output: string;
}

export interface OperationAdapters {
  readonly agentSessions: AgentSessionOperationAdapter;
  readonly panes: PaneOperationAdapter;
  readonly headless: HeadlessOperationAdapter;
}

export interface AgentSessionOperationAdapter {
  /**
   * Resolve the target session and its active process, and refuse while a turn is in flight.
   *
   * The quiescence guard is a pre-dispatch correctness check and never evidence of delivery: it says
   * nothing was running when we looked, which is what makes the watermark heuristic usually sound
   * and is not what makes it true.
   */
  readonly prepareSend: (input: {
    readonly agentSessionId: number;
  }) => Effect.Effect<PreparedSubmission, Error>;
  /**
   * Create or adopt the pane/session compound under `creationKey`.
   *
   * Idempotent completion is the owner's contract, not this layer's: a re-entered key resumes from
   * whatever exists rather than creating a second pane or a second agent session, which is also why
   * recovery from a spawn that recorded no stage simply calls this again. It creates no process, so
   * the caller may record its result before doing anything that could be ambiguous.
   */
  readonly createKeyedSession: (input: {
    readonly creationKey: string;
    readonly worktreeId: number;
    readonly surfaceId: number;
    readonly harness: WorkflowAgentHarness;
  }) => Effect.Effect<CreatedKeyedSession, Error>;
  /**
   * Bring a freshly created session's process up and hold until it is safe to seed it.
   *
   * Everything bounded and repeatable: process launch, observer initialization, the startup-output
   * wait, the settle window and the quiescence guard. Called on the live path only after the
   * resource stage is durable.
   */
  readonly prepareSeed: (input: {
    readonly agentSessionId: number;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
  }) => Effect.Effect<PreparedSubmission, Error>;
  /** The PTY write itself. Nothing durable happens inside it — that is the point of the marker. */
  readonly submitPrompt: (input: {
    readonly ptyProcessId: number;
    readonly text: string;
  }) => Effect.Effect<void, Error>;
  /**
   * Wait for the harness to acknowledge a seed, re-sending the submit key within its existing
   * bounds.
   *
   * **Live path only.** These retries are part of the original submission procedure and stop with
   * it; recovery and receipt reuse never call this, because a bare submit key is still a PTY write
   * into a window nobody can characterize.
   */
  readonly awaitSeedAcknowledgement: (input: {
    readonly agentSessionId: number;
    readonly ptyProcessId: number;
  }) => Effect.Effect<string, Error>;
  /**
   * The harness a durable session was created with.
   *
   * Prompt rendering depends on it, and the *session's* harness is the authority — an author cannot
   * change how a prompt renders by naming a different one at the call site.
   */
  readonly sessionHarness: (agentSessionId: number) => Effect.Effect<WorkflowAgentHarness, Error>;
  /** Raw turn evidence from the harness ledger. Durable, so recovery reads the same thing. */
  readonly turnEdges: (
    agentSessionId: number,
  ) => Effect.Effect<readonly WorkflowObservedTurnEdge[], Error>;
  readonly conversationHistory: (
    agentSessionId: number,
  ) => Effect.Effect<readonly WorkflowConversationMessage[], Error>;
}

export interface PaneOperationAdapter {
  readonly closePane: (input: {
    readonly surfaceId: number;
    readonly paneId: number;
  }) => Effect.Effect<void, Error>;
}

export interface HeadlessOperationAdapter {
  readonly assertCanCreateProcess: (harness: WorkflowAgentHarness) => Effect.Effect<void, Error>;
  /**
   * Reserve a durable PTY row with no process behind it.
   *
   * The caller brackets this with `Effect.acquireRelease(..., a => a.abandon)`, so an interrupted or
   * failed start releases the reservation rather than leaving an allocation nobody owns.
   */
  readonly allocate: (input: {
    readonly harness: WorkflowAgentHarness;
    readonly cwd: string;
    readonly prompt: string;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
  }) => Effect.Effect<PtyProcessAllocation, Error>;
  readonly pin: (ptyProcessId: number) => Effect.Effect<void>;
  readonly unpin: (ptyProcessId: number) => Effect.Effect<void>;
  readonly capture: (input: {
    readonly ptyProcessId: number;
    readonly harness: WorkflowAgentHarness;
  }) => Effect.Effect<CapturedOutput, Error>;
  /** A request, never a proof. Its outcome is recorded separately from the operation's own state. */
  readonly terminate: (input: {
    readonly ptyProcessId: number;
    readonly gracefulTimeoutMs: number;
  }) => Effect.Effect<PtyTerminateOutcome, Error>;
  readonly semanticError: (input: {
    readonly harness: WorkflowAgentHarness;
    readonly raw: string;
  }) => string | null;
}
