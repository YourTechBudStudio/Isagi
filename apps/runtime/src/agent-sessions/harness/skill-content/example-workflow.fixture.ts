import {
  defineWorkflow,
  done,
  event as workflowEvent,
  fail,
  suspend,
  wait,
  type WorkflowContext,
  type WorkflowConversationMessage,
  type WorkflowLaunchContext,
  type WorkflowResult,
} from '@isagi/workflow-sdk';

type ReviewerPane = {
  readonly agentSessionId: number;
  readonly paneId: number;
  readonly sentAt: string;
};

type Phase =
  | { readonly kind: 'spawn_reviewer' }
  | { readonly kind: 'await_review'; readonly reviewer: ReviewerPane }
  | { readonly kind: 'await_relay'; readonly reviewer: ReviewerPane };

type State = {
  readonly stateVersion: 1;
  readonly authorSessionId: number;
  readonly question: string;
  readonly phase: Phase;
};

type Variables = { readonly question?: unknown };

export default defineWorkflow<State, Variables>({
  command: () => ({
    title: 'Second opinion',
    description: 'Ask a fresh agent to review the worktree, then relay its answer back.',
    inputs: [{ kind: 'text', key: 'question', label: 'What should the reviewer check?' }],
  }),

  validate: (launchCtx, variables) => {
    requireAuthorSessionId(launchCtx);
    requireQuestion(variables);
  },

  init: (launchCtx, variables): State => ({
    stateVersion: 1,
    authorSessionId: requireAuthorSessionId(launchCtx),
    question: requireQuestion(variables),
    phase: { kind: 'spawn_reviewer' },
  }),

  step: async (ctx, state, event) => {
    switch (state.phase.kind) {
      case 'spawn_reviewer': {
        await ctx.setUiFeedback({
          kind: 'info',
          phase: 'Asking a reviewer',
          message: state.question,
        });
        const reviewer = await ctx.spawnAgentSession({
          harness: 'claude',
          prompt: `Review this worktree and answer the following. Do not change any files.\n\n${state.question}`,
        });
        await ctx.log(
          'info',
          `Spawned reviewer agentSessionId=${reviewer.agentSessionId} paneId=${reviewer.paneId}.`,
        );
        return suspend(
          { ...state, phase: { kind: 'await_review', reviewer } } satisfies State,
          wait.agentTurn(reviewer),
        );
      }

      case 'await_review': {
        const { reviewer } = state.phase;
        const turnFailed = await requireEndedTurn(ctx, event, 'the reviewer');
        if (turnFailed) return turnFailed;

        const history = await ctx.getConversationHistory(reviewer.agentSessionId);
        const review = latestAssistantText(history);
        if (!review) {
          await ctx.setUiFeedback({
            kind: 'error',
            phase: 'Asking a reviewer',
            message: 'The reviewer finished without writing an answer.',
          });
          await ctx.log('error', `Reviewer session ${reviewer.agentSessionId} produced no text.`);
          return fail(`Reviewer session ${reviewer.agentSessionId} produced no assistant text.`);
        }

        await ctx.setUiFeedback({
          kind: 'info',
          phase: 'Relaying the review',
          message: 'Sending the review to your agent.',
        });
        const sent = await ctx.sendAgentPrompt(
          state.authorSessionId,
          `A reviewer looked at your work and said:\n\n${review}`,
        );
        return suspend(
          { ...state, phase: { kind: 'await_relay', reviewer } } satisfies State,
          wait.agentTurn(sent),
        );
      }

      case 'await_relay': {
        const turnFailed = await requireEndedTurn(ctx, event, 'your agent');
        if (turnFailed) return turnFailed;

        await ctx.closePane(state.phase.reviewer.paneId);
        await ctx.setUiFeedback({
          kind: 'info',
          phase: 'Review delivered',
          message: 'Your agent has read the review.',
        });
        return done({ question: state.question });
      }
    }
  },
});

async function requireEndedTurn(
  ctx: WorkflowContext,
  event: unknown,
  who: string,
): Promise<WorkflowResult | null> {
  if (workflowEvent.isAgentTurnEnded(event)) return null;
  const reason = workflowEvent.isAgentTurnFailed(event)
    ? event.reason
    : 'the workflow resumed on an event it did not expect';
  await ctx.setUiFeedback({
    kind: 'error',
    phase: 'Waiting for a turn',
    message: `The turn from ${who} did not finish.`,
  });
  await ctx.log('error', `Expected an ended turn from ${who}: ${reason}.`);
  return fail(`Turn from ${who} did not finish: ${reason}.`);
}

function latestAssistantText(history: readonly WorkflowConversationMessage[]): string | null {
  for (const message of [...history].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = message.parts
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text.length > 0) return text;
  }
  return null;
}

function requireAuthorSessionId(launchCtx: WorkflowLaunchContext): number {
  if (launchCtx.agentSessionId === null || launchCtx.agentSessionId === undefined) {
    throw new Error('Start this workflow from the agent pane that should receive the review.');
  }
  return launchCtx.agentSessionId;
}

function requireQuestion(variables: Variables): string {
  const question = typeof variables.question === 'string' ? variables.question.trim() : '';
  if (question.length === 0) {
    throw new Error('Provide a question for the reviewer.');
  }
  return question;
}
