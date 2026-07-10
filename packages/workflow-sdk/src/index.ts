export const workflowInputKinds = ['text', 'select', 'multi-select', 'confirm'] as const;

export type WorkflowInputKind = (typeof workflowInputKinds)[number];

export const workflowWaitKinds = [
  'agent_turn',
  'user_continue',
  'user_input',
  'workflow',
  'headless_agent',
] as const;

export type WorkflowWaitKind = (typeof workflowWaitKinds)[number];

export type WorkflowAgentHarness = 'pi' | 'opencode' | 'claude' | 'codex';

export interface WorkflowQuestionOption {
  readonly value: string;
  readonly label?: string | undefined;
  readonly hint?: string | undefined;
}

export type WorkflowQuestionSpec =
  | {
      readonly kind: 'text';
      readonly key: string;
      readonly label: string;
      readonly placeholder?: string | undefined;
      readonly default?: string | undefined;
    }
  | {
      readonly kind: 'select';
      readonly key: string;
      readonly label: string;
      readonly options: readonly WorkflowQuestionOption[];
      readonly default?: string | undefined;
    }
  | {
      readonly kind: 'multi-select';
      readonly key: string;
      readonly label: string;
      readonly options: readonly WorkflowQuestionOption[];
      readonly default?: readonly string[] | undefined;
    }
  | {
      readonly kind: 'confirm';
      readonly key: string;
      readonly label: string;
      readonly default?: boolean | undefined;
    };

export type WorkflowConversationRole = 'system' | 'user' | 'assistant';
export type WorkflowConversationPartState = 'streaming' | 'done';

export interface WorkflowConversationPart {
  readonly type: 'text';
  readonly text: string;
  readonly state?: WorkflowConversationPartState | undefined;
}

export interface WorkflowConversationMessage {
  readonly role: WorkflowConversationRole;
  readonly parts: readonly WorkflowConversationPart[];
}

export interface WorkflowUiFeedback {
  readonly kind?: 'info' | 'warning' | 'error' | undefined;
  readonly phase?: string | undefined;
  readonly message?: string | undefined;
}

export type WorkflowVariables = Record<string, unknown>;

export type WorkflowUserInputAnswers = Record<string, string | readonly string[] | boolean>;

export interface WorkflowLaunchContext {
  readonly worktreeId: number;
  readonly worktreePath: string;
  readonly surfaceId: number;
  readonly paneId?: number | null | undefined;
  readonly agentSessionId?: number | null | undefined;
}

export interface WorkflowCommandManifest {
  readonly title: string;
  readonly description?: string | undefined;
  readonly inputs?: readonly WorkflowQuestionSpec[] | undefined;
}

export type WorkflowWaitCondition =
  | {
      readonly kind: 'agent_turn';
      readonly agentSessionId: number;
      readonly sentAt: string;
    }
  | { readonly kind: 'user_continue' }
  | { readonly kind: 'user_input'; readonly questions: readonly WorkflowQuestionSpec[] }
  | { readonly kind: 'workflow'; readonly runIds: readonly number[] }
  | {
      readonly kind: 'headless_agent';
      readonly ops: readonly WorkflowHeadlessOp[];
    };

export interface WorkflowAgentPromptSend {
  readonly agentSessionId: number;
  readonly sentAt: string;
}

export interface WorkflowHeadlessLaunch {
  readonly prompt: string;
  readonly harness: WorkflowAgentHarness;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly timeoutMs: number;
}

export interface WorkflowHeadlessAgentInput {
  readonly prompt: string;
  readonly harness: WorkflowAgentHarness;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface WorkflowHeadlessResult {
  readonly opId: string;
  readonly status: 'completed' | 'failed';
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  readonly exitCode?: number | null | undefined;
}

export interface WorkflowHeadlessOp {
  readonly opId: string;
  readonly launch: WorkflowHeadlessLaunch;
}

export type WorkflowLogLevel = 'debug' | 'info' | 'warning' | 'error';

export type WorkflowAgentTurnEvent =
  | { readonly outcome: 'ended'; readonly recordedAt: string }
  | { readonly outcome: 'failed'; readonly recordedAt: string; readonly reason: string };

export type WorkflowUserContinueEvent = { readonly kind: 'user_continue' };

export type WorkflowUserInputEvent = {
  readonly kind: 'user_input';
  readonly answers: WorkflowUserInputAnswers;
};

export interface WorkflowJoinResult {
  readonly runId: number;
  readonly status: 'done' | 'failed';
  readonly result?: unknown | undefined;
  readonly error?: unknown | undefined;
}

export type WorkflowResultsEvent = {
  readonly kind: 'workflow';
  readonly results: readonly WorkflowJoinResult[];
};

export type WorkflowHeadlessAgentResultsEvent = {
  readonly kind: 'headless_agent';
  readonly results: readonly WorkflowHeadlessResult[];
};

export type WorkflowResult =
  | { readonly type: 'cont'; readonly state: unknown }
  | { readonly type: 'suspend'; readonly state: unknown; readonly condition: WorkflowWaitCondition }
  | { readonly type: 'done'; readonly value?: unknown }
  | { readonly type: 'fail'; readonly reason: string };

export interface WorkflowContext {
  readonly worktreePath: string;
  readonly spawnAgentSession: (input: {
    readonly harness: WorkflowAgentHarness;
    readonly prompt: string;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
  }) => Promise<WorkflowAgentPromptSend & { readonly paneId: number }>;
  readonly sendAgentPrompt: (
    agentSessionId: number,
    text: string,
  ) => Promise<WorkflowAgentPromptSend>;
  readonly closePane: (paneId: number) => Promise<void>;
  readonly getConversationHistory: (
    agentSessionId: number,
  ) => Promise<readonly WorkflowConversationMessage[]>;
  readonly runHeadlessAgent: (input: WorkflowHeadlessAgentInput) => Promise<WorkflowHeadlessOp>;
  readonly startWorkflow: (
    workflowKey: string,
    variables?: WorkflowVariables,
    context?: {
      readonly surfaceId?: number | undefined;
      readonly agentSessionId?: number | null | undefined;
    },
  ) => Promise<number>;
  readonly log: (level: WorkflowLogLevel, message: string) => Promise<void>;
  readonly setUiFeedback: (feedback: WorkflowUiFeedback) => Promise<void>;
}

type MaybePromise<Value> = Value | Promise<Value>;

export type WorkflowStep<State = unknown> = (
  ctx: WorkflowContext,
  state: State,
  event: unknown,
) => Promise<WorkflowResult>;

export interface WorkflowDefinition<
  State = unknown,
  Variables extends WorkflowVariables = WorkflowVariables,
> {
  readonly command: (ctx: WorkflowLaunchContext) => MaybePromise<WorkflowCommandManifest>;
  readonly validate: (ctx: WorkflowLaunchContext, variables: Variables) => MaybePromise<void>;
  readonly init: (ctx: WorkflowLaunchContext, variables: Variables) => MaybePromise<State>;
  readonly step: WorkflowStep<State>;
}

export function defineWorkflow<State, Variables extends WorkflowVariables = WorkflowVariables>(
  definition: WorkflowDefinition<State, Variables>,
): WorkflowDefinition<State, Variables> {
  return definition;
}

export function cont(nextState: unknown): WorkflowResult {
  return { type: 'cont', state: nextState };
}

export function suspend(nextState: unknown, condition: WorkflowWaitCondition): WorkflowResult {
  return { type: 'suspend', state: nextState, condition };
}

export const wait = {
  agentTurn(
    target: WorkflowAgentPromptSend,
  ): Extract<WorkflowWaitCondition, { readonly kind: 'agent_turn' }> {
    return {
      kind: 'agent_turn',
      agentSessionId: target.agentSessionId,
      sentAt: target.sentAt,
    };
  },
  userContinue(): Extract<WorkflowWaitCondition, { readonly kind: 'user_continue' }> {
    return { kind: 'user_continue' };
  },
  userInput(
    questions: readonly WorkflowQuestionSpec[],
  ): Extract<WorkflowWaitCondition, { readonly kind: 'user_input' }> {
    return { kind: 'user_input', questions };
  },
  workflow(
    runIds: number | readonly number[],
  ): Extract<WorkflowWaitCondition, { readonly kind: 'workflow' }> {
    const normalized = Array.isArray(runIds) ? runIds : [runIds];
    if (normalized.length === 0) {
      throw new Error('Workflow wait requires at least one run id.');
    }
    return { kind: 'workflow', runIds: normalized };
  },
  headlessAgent(
    ops: WorkflowHeadlessOp | readonly WorkflowHeadlessOp[],
  ): Extract<WorkflowWaitCondition, { readonly kind: 'headless_agent' }> {
    const normalized = Array.isArray(ops) ? ops : [ops];
    if (normalized.length === 0) {
      throw new Error('Headless agent wait requires at least one operation.');
    }
    return { kind: 'headless_agent', ops: normalized };
  },
};

export const event = {
  isUserContinue(value: unknown): value is WorkflowUserContinueEvent {
    return isObject(value) && value.kind === 'user_continue';
  },
  isUserInput(value: unknown): value is WorkflowUserInputEvent {
    return isObject(value) && value.kind === 'user_input' && isObject(value.answers);
  },
  isAgentTurnEnded(value: unknown): value is Extract<WorkflowAgentTurnEvent, { outcome: 'ended' }> {
    return isObject(value) && value.outcome === 'ended' && typeof value.recordedAt === 'string';
  },
  isAgentTurnFailed(
    value: unknown,
  ): value is Extract<WorkflowAgentTurnEvent, { outcome: 'failed' }> {
    return (
      isObject(value) &&
      value.outcome === 'failed' &&
      typeof value.recordedAt === 'string' &&
      typeof value.reason === 'string'
    );
  },
  requireAgentTurnEnded(value: unknown): Extract<WorkflowAgentTurnEvent, { outcome: 'ended' }> {
    if (event.isAgentTurnEnded(value)) return value;
    throw new Error('Expected an ended agent turn event.');
  },
  requireAgentTurnFailed(value: unknown): Extract<WorkflowAgentTurnEvent, { outcome: 'failed' }> {
    if (event.isAgentTurnFailed(value)) return value;
    throw new Error('Expected a failed agent turn event.');
  },
  getAgentTurnResult(value: unknown): WorkflowAgentTurnEvent | null {
    if (event.isAgentTurnEnded(value) || event.isAgentTurnFailed(value)) return value;
    return null;
  },
  getWorkflowResults(value: unknown): readonly WorkflowJoinResult[] | null {
    if (isObject(value) && value.kind === 'workflow' && Array.isArray(value.results)) {
      return value.results as readonly WorkflowJoinResult[];
    }
    return null;
  },
  getHeadlessAgentResults(value: unknown): readonly WorkflowHeadlessResult[] | null {
    if (isObject(value) && value.kind === 'headless_agent' && Array.isArray(value.results)) {
      return value.results as readonly WorkflowHeadlessResult[];
    }
    return null;
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Terminates the workflow with an optional JSON-serializable result value.
 */
export function done(value?: unknown): WorkflowResult {
  return { type: 'done', value };
}

export function fail(reason: string): WorkflowResult {
  return { type: 'fail', reason };
}
