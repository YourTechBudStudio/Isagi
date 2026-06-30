export const workflowInputKinds = ['text', 'select', 'multi-select', 'confirm'] as const;

export type WorkflowInputKind = (typeof workflowInputKinds)[number];

export const workflowWaitKinds = [
  'turn',
  'user_continue',
  'user_input',
  'workflow',
  'headless',
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
      readonly kind: 'turn';
      readonly agentSessionId: number;
      readonly harnessSessionId: string;
      readonly afterT: string;
    }
  | { readonly kind: 'user_continue' }
  | { readonly kind: 'user_input'; readonly questions: readonly WorkflowQuestionSpec[] }
  | { readonly kind: 'workflow'; readonly runIds: readonly number[] }
  | {
      readonly kind: 'headless';
      readonly ops: readonly WorkflowHeadlessOp[];
    };

export interface WorkflowHeadlessLaunch {
  readonly prompt: string;
  readonly harness: WorkflowAgentHarness;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly timeoutMs: number;
}

export interface WorkflowHeadlessPromptInput {
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

export type WorkflowResult =
  | { readonly type: 'cont'; readonly state: unknown }
  | { readonly type: 'suspend'; readonly state: unknown; readonly condition: WorkflowWaitCondition }
  | { readonly type: 'done'; readonly value?: unknown }
  | { readonly type: 'fail'; readonly reason: string };

export interface WorkflowContext {
  readonly worktreePath: string;
  readonly spawnSession: (input: {
    readonly harness: WorkflowAgentHarness;
    readonly prompt: string;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
  }) => Promise<{
    readonly agentSessionId: number;
    readonly harnessSessionId: string;
    readonly seededAt: string;
    readonly paneId: number;
  }>;
  readonly inject: (agentSessionId: number, text: string) => Promise<void>;
  readonly closePane: (paneId: number) => Promise<void>;
  readonly getConversationHistory: (target: {
    readonly agentSessionId: number;
    readonly harnessSessionId: string;
  }) => Promise<readonly WorkflowConversationMessage[]>;
  readonly getHarnessSessionId: (agentSessionId: number) => Promise<string>;
  readonly runHeadlessPrompt: (input: WorkflowHeadlessPromptInput) => Promise<WorkflowHeadlessOp>;
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

/**
 * Terminates the workflow with an optional JSON-serializable result value.
 */
export function done(value?: unknown): WorkflowResult {
  return { type: 'done', value };
}

export function fail(reason: string): WorkflowResult {
  return { type: 'fail', reason };
}
