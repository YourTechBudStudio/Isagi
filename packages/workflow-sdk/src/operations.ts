import { brand, type WorkflowBrand } from './brand.js';
import type { EvidenceCaptureInput, EvidenceHandle } from './evidence.js';
import type { WorkflowOutcomeId } from './identifiers.js';
import type {
  WorkflowAgentHarness,
  WorkflowConversationMessage,
  WorkflowDestination,
  WorkflowLogLevel,
  WorkflowPromptInput,
  WorkflowQuestionSpec,
  WorkflowUiFeedback,
  WorkflowUserInputAnswers,
} from './launch.js';

/** What an operation node's callback hands back to the interpreter. */
export type OperationResult<Update> = WorkflowBrand &
  (
    | {
        readonly isagiKind: 'operation-result';
        readonly type: 'complete';
        readonly update?: Update | undefined;
      }
    | {
        readonly isagiKind: 'operation-result';
        readonly type: 'suspend';
        readonly update?: Update | undefined;
        readonly wait: WaitDeclaration;
      }
  );

/** Finish this node visit now. Its router still runs as its own segment, on an `immediate` event. */
export function complete<Update>(input?: {
  readonly update?: Update | undefined;
}): OperationResult<Update> {
  return input && 'update' in input
    ? { ...brand('operation-result'), type: 'complete', update: input.update }
    : { ...brand('operation-result'), type: 'complete' };
}

/** Commit an update and park this node visit until the declared wait is delivered. */
export function suspend<Update>(input: {
  readonly update?: Update | undefined;
  readonly wait: WaitDeclaration;
}): OperationResult<Update> {
  return 'update' in input
    ? { ...brand('operation-result'), type: 'suspend', update: input.update, wait: input.wait }
    : { ...brand('operation-result'), type: 'suspend', wait: input.wait };
}

export const workflowWaitKinds = [
  'agent_turn',
  'user_continue',
  'user_input',
  'headless_agent',
] as const;

export type WorkflowWaitKind = (typeof workflowWaitKinds)[number];

export type WaitDeclaration =
  | { readonly kind: 'agent_turn'; readonly target: AgentTurnTarget }
  | { readonly kind: 'user_continue'; readonly label?: string | undefined }
  | { readonly kind: 'user_input'; readonly questions: readonly WorkflowQuestionSpec[] }
  | { readonly kind: 'headless_agent'; readonly operations: readonly HeadlessOperationHandle[] };

export const wait = {
  agentTurn(target: AgentTurnTarget): WaitDeclaration {
    return { kind: 'agent_turn', target };
  },
  userContinue(label?: string): WaitDeclaration {
    return label === undefined ? { kind: 'user_continue' } : { kind: 'user_continue', label };
  },
  userInput(questions: readonly WorkflowQuestionSpec[]): WaitDeclaration {
    return { kind: 'user_input', questions };
  },
  /**
   * One node visit waiting on several named operations. Results reach the router in the declared
   * input order, so an author can address them positionally as well as by id.
   */
  headlessAgent(
    operations: HeadlessOperationHandle | readonly HeadlessOperationHandle[],
  ): WaitDeclaration {
    const normalized = Array.isArray(operations)
      ? (operations as readonly HeadlessOperationHandle[])
      : [operations as HeadlessOperationHandle];
    if (normalized.length === 0) {
      throw new Error('Headless agent wait requires at least one operation.');
    }
    return { kind: 'headless_agent', operations: normalized };
  },
};

/** The outcome a completed child frame published, delivered to the parent as data. */
export interface SubgraphResult<Output> {
  readonly outcomeId: WorkflowOutcomeId;
  readonly outcomeKind: 'success' | 'failure';
  readonly reason?: string | undefined;
  readonly output: Output;
}

/**
 * What a router sees. A closed union: an authored failure outcome and a delivered agent failure are
 * data here, while a callback, reducer, or router that throws is a segment failure and never
 * reaches this type.
 */
export type NodeEvent =
  | { readonly kind: 'immediate' }
  | AgentTurnEvent
  | { readonly kind: 'user_continue' }
  | { readonly kind: 'user_input'; readonly answers: WorkflowUserInputAnswers }
  | { readonly kind: 'headless_agent'; readonly results: readonly HeadlessOperationResult[] }
  | { readonly kind: 'subgraph'; readonly result: SubgraphResult<unknown> };

export type AgentTurnEvent =
  | { readonly kind: 'agent_turn'; readonly outcome: 'ended'; readonly recordedAt: string }
  | {
      readonly kind: 'agent_turn';
      readonly outcome: 'failed';
      readonly recordedAt: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'agent_turn';
      readonly outcome: 'interrupted';
      readonly recordedAt: string;
      readonly reason: AgentTurnInterruptionReason;
    };

export type AgentTurnInterruptionReason = 'session_died' | 'superseded_by_new_turn';

export interface HeadlessOperationResult {
  readonly operationId: string;
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly interruption?: HeadlessInterruption | undefined;
}

/**
 * The runtime lost the process that was capturing this operation's output. Stopping the underlying
 * process is best effort, so its completeness is reported separately rather than assumed.
 */
export interface HeadlessInterruption {
  readonly reason: 'capture_owner_lost';
  readonly launchedAt: string;
  readonly partialOutput?: string | undefined;
  readonly stop: {
    readonly state: 'pending' | 'confirmed' | 'failed' | 'unsupported';
    readonly detail?: string | undefined;
  };
}

/**
 * `NodeEvent` is already a typed union, so narrowing by `event.kind` needs no helper. These exist
 * only where they carry real logic.
 */
export const eventGuards = {
  isAgentTurn(event: NodeEvent): event is AgentTurnEvent {
    return event.kind === 'agent_turn';
  },
  isHeadless(event: NodeEvent): event is Extract<NodeEvent, { kind: 'headless_agent' }> {
    return event.kind === 'headless_agent';
  },
  requireHeadless(event: NodeEvent, operationId: string): HeadlessOperationResult {
    if (event.kind !== 'headless_agent') {
      throw new Error(`Expected a headless agent event; received "${event.kind}".`);
    }
    const result = event.results.find((candidate) => candidate.operationId === operationId);
    if (!result) {
      throw new Error(`The headless agent event carries no result for operation "${operationId}".`);
    }
    return result;
  },
  isSubgraph(event: NodeEvent): event is Extract<NodeEvent, { kind: 'subgraph' }> {
    return event.kind === 'subgraph';
  },
};

export interface AgentTurnTarget {
  readonly agentSessionId: number;
  readonly sentAt: string;
}

export interface AgentSessionHandle extends AgentTurnTarget {
  readonly paneId: number;
}

/**
 * The author's reference to a durable operation. The launch detail lives in the runtime's operation
 * record, not in author state, so a retry cannot be handed a stale copy of it.
 */
export interface HeadlessOperationHandle {
  readonly operationId: string;
}

export interface WorkflowHeadlessAgentInput extends WorkflowPromptInput {
  readonly harness: WorkflowAgentHarness;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface OperationInvocation {
  readonly runId: number;
  /** The graph frame this visit belongs to. */
  readonly invocationId: number;
  readonly executionId: number;
  /** 1-based attempt index for this segment. */
  readonly attempt: number;
  readonly kind: 'initial' | 'resumed' | 'retry';
}

/**
 * What an operation callback may do. The verbs do not all carry the same guarantee, and the
 * difference decides what a repaired segment repeats.
 *
 * `spawnAgentSession`, `sendAgentPrompt`, `closePane`, `runHeadlessAgent` and `captureEvidence` are
 * **durable recorded operations**: each takes a call position, and a re-entered callback reaching a
 * recorded position with the same request reuses that receipt instead of repeating the effect. The
 * first four cross an external boundary; `captureEvidence` crosses none, but carries the same
 * guarantee for the same reason — a repaired segment must get back the thing that was judged, not a
 * newer one read on the way past.
 *
 * `getConversationHistory` is a **scoped read**. It takes no call position and has no receipt, so a
 * repaired segment normally reads again and may observe a different answer. When an explicit Retry
 * recovers a retained agent-turn wait, the runtime may instead bind reads for that same Isagi agent
 * session to the exact native turn selected by the Retry; other session reads remain fresh.
 *
 * `log` and `setUiFeedback` are **durable diagnostics**. They are retained and inspectable — a log
 * written before a callback failure survives it — but they are not operations, consume no call
 * position, and are never reused as receipts.
 */
export interface OperationContext {
  readonly destination: WorkflowDestination;
  readonly worktreePath: string;
  readonly invocation: OperationInvocation;
  readonly spawnAgentSession: (
    input: WorkflowPromptInput & {
      readonly harness: WorkflowAgentHarness;
      readonly model?: string | undefined;
      readonly effort?: string | undefined;
    },
  ) => Promise<AgentSessionHandle>;
  readonly sendAgentPrompt: (
    input: WorkflowPromptInput & { readonly agentSessionId: number },
  ) => Promise<AgentTurnTarget>;
  readonly closePane: (paneId: number) => Promise<void>;
  readonly getConversationHistory: (
    agentSessionId: number,
  ) => Promise<readonly WorkflowConversationMessage[]>;
  readonly runHeadlessAgent: (
    input: WorkflowHeadlessAgentInput,
  ) => Promise<HeadlessOperationHandle>;
  /**
   * Keep this exact thing, immutably, as evidence of what this run produced.
   *
   * Returns a durable reference. `title`, `role`, `labels` and `source` are the recorded identity of
   * the call, so derive them from graph state and from handles you already hold, never from the
   * content being captured. Capturing a newly produced judgment belongs in a later visit to the
   * node; a second call at the same position with the same identity is a different call position,
   * not a re-capture.
   */
  readonly captureEvidence: (input: EvidenceCaptureInput) => Promise<EvidenceHandle>;
  readonly log: (level: WorkflowLogLevel, message: string) => Promise<void>;
  readonly setUiFeedback: (feedback: WorkflowUiFeedback) => Promise<void>;
}
