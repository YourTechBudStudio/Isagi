import { brand, type WorkflowBrand } from './brand.js';
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

/** Finish this node visit now. Its router runs on an `immediate` event. */
export function complete<Update>(input?: {
  readonly update?: Update | undefined;
}): OperationResult<Update> {
  return input && 'update' in input
    ? { ...brand('operation-result'), type: 'complete', update: input.update }
    : { ...brand('operation-result'), type: 'complete' };
}

/**
 * Park the node execution until the wait is delivered. Its `update` is applied together with the
 * edge's update, in one step, once the event arrives.
 */
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

/** The outcome a completed child graph invocation published, delivered to the parent as data. */
export interface SubgraphResult<Output> {
  readonly outcomeId: WorkflowOutcomeId;
  readonly outcomeKind: 'success' | 'failure';
  readonly reason?: string | undefined;
  readonly output: Output;
}

/**
 * What a router sees. A closed union: an authored failure outcome and a delivered agent failure are
 * data here, while a callback, reducer, or router that throws fails the execution and never
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

export type AgentTurnInterruptionReason = 'session_died';

export interface HeadlessOperationResult {
  readonly operationId: string;
  readonly status: 'completed' | 'failed' | 'interrupted';
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly interruption?: HeadlessInterruption | undefined;
}

/**
 * The runtime restarted while this headless operation was running, so its process and output are
 * gone. The operation is not relaunched; route on this like any other result.
 */
export interface HeadlessInterruption {
  readonly reason: 'runtime_restarted';
  readonly launchedAt: string;
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
  /** The graph invocation this visit belongs to: one entry into a graph or subgraph. */
  readonly invocationId: number;
  readonly executionId: number;
  /** `retry` when this execution was created by an explicit Retry of a failed or interrupted one. */
  readonly kind: 'initial' | 'retry';
}

/**
 * What an operation callback may do.
 *
 * `spawnAgentSession`, `sendAgentPrompt`, `closePane` and `runHeadlessAgent` touch the outside
 * world. Each call is logged in the run's operation history (the request, including the full prompt
 * text, and what came back) so a run's dialogue can be read afterwards. The log is history only: it
 * is never consulted to skip work.
 *
 * Once a callback returns, its result is saved and never re-run. A Retry of an execution that failed
 * before its result was saved runs the callback again, so its effects may repeat. Keep callbacks
 * small: do the preparation, perform **one** side effect, and return. A second effect belongs in its
 * own node, and file snapshots belong in checkpoint nodes.
 *
 * `getConversationHistory` reads the session's latest conversation.
 *
 * `log` and `setUiFeedback` are recorded in the run's event log. A log written before a callback
 * failure survives it.
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
  readonly log: (level: WorkflowLogLevel, message: string) => Promise<void>;
  readonly setUiFeedback: (feedback: WorkflowUiFeedback) => Promise<void>;
}
