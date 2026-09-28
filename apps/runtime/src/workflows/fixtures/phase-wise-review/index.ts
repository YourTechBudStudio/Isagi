import {
  createGraph,
  defineWorkflow,
  edge,
  eventGuards,
  operation,
  outcome,
  reduce,
  subgraph,
  suspend,
  wait,
  type AgentSessionHandle,
  type HeadlessOperationResult,
  type NodeEvent,
  type WorkflowInputs,
} from '@yourtechbudstudio/isagi-workflow-sdk';

import { latestAssistantText } from '../authoring.js';

/**
 * Implementing a phase-wise plan, healing itself where it can and asking a person where it cannot.
 *
 * Adapted from the authored `implement-phase-wise-plan`: a sequence of phases, each with an
 * implementer, an assessment, a bounded review loop, a verification and a commit. Three layers of
 * graph:
 *
 * - `phase-plan` (business) loops the phase subgraph;
 * - `phase` (logical) implements, assesses, reviews, verifies and commits one phase;
 * - `review-round` (operational) is one reviewer/fixer pass.
 *
 * Every node does its preparation, performs **one** side effect and returns. Recovery lives in the
 * graph, in the two patterns the authoring guide teaches:
 *
 * - **bounded self-retry**: a failed verification or commit routes back to itself while a counter
 *   in state allows, because a repeated headless check is cheap and mostly read-only;
 * - **ask the user**: when that runs out, or when the implementer's turn fails, a `userContinue`
 *   node asks for a fix. After a failed agent turn the graph then re-arms `wait.agentTurn` on the
 *   same target, with no new prompt, so the latest turn the person ran by hand is what counts.
 *
 * Hermetic: every external effect goes through `ctx`.
 */

export const selfRetryLimit = 2;

/** Whether a headless event carries one completed result, and its output. */
function headlessOutput(event: NodeEvent): string | null {
  if (!eventGuards.isHeadless(event)) return null;
  const result = event.results[0] as HeadlessOperationResult | undefined;
  return result?.status === 'completed' ? (result.output ?? '') : null;
}

const turnEnded = (event: NodeEvent) => eventGuards.isAgentTurn(event) && event.outcome === 'ended';

// --- review-round -----------------------------------------------------------------------------

interface ReviewRoundState {
  readonly phase: number;
  readonly round: number;
  readonly reviewer: AgentSessionHandle | null;
}

export interface ReviewRoundParameters {
  readonly phase: number;
  readonly round: number;
}

export interface ReviewRoundOutput {
  readonly approved: boolean;
}

export const ReviewRoundGraph = createGraph<
  ReviewRoundState,
  {},
  ReviewRoundParameters,
  ReviewRoundOutput
>({
  key: 'review-round',
  title: 'Review round',
  intent: 'operational',
  label: (parameters) => `phase ${parameters.phase}, round ${parameters.round}`,
  init: (_destination, parameters) => ({
    phase: parameters.phase,
    round: parameters.round,
    reviewer: null,
  }),
  state: {
    phase: reduce.replace<number>(),
    round: reduce.replace<number>(),
    reviewer: reduce.replace<AgentSessionHandle | null>(),
  },
  entry: 'askReviewer',
  nodes: {
    askReviewer: operation(
      async (ctx, state) => {
        const reviewer = await ctx.spawnAgentSession({
          harness: 'claude',
          prompt: `Review phase ${state.phase}, round ${state.round}.`,
        });
        return suspend({ update: { reviewer }, wait: wait.agentTurn(reviewer) });
      },
      { title: 'Ask a reviewer' },
    ),
    judgeFeedback: operation(
      async (ctx, state) => {
        // Preparation (reading the reply), then one side effect (the judgment).
        const history = await ctx.getConversationHistory(state.reviewer!.agentSessionId);
        const judgment = await ctx.runHeadlessAgent({
          harness: 'claude',
          prompt: `Does this review approve the work?\n\n${latestAssistantText(history)}`,
        });
        return suspend({ wait: wait.headlessAgent(judgment) });
      },
      { title: 'Judge the feedback' },
    ),
    askFixer: operation(
      async (ctx, state) => {
        const fixer = await ctx.spawnAgentSession({
          harness: 'claude',
          prompt: `Address the review for phase ${state.phase}, round ${state.round}.`,
        });
        return suspend({ wait: wait.agentTurn(fixer) });
      },
      { title: 'Ask a fixer' },
    ),
  },
  edges: {
    'reviewer-out': edge({
      from: 'askReviewer',
      to: ['judgeFeedback', 'unavailable'],
      choose: (_state, event) =>
        turnEnded(event) ? { to: 'judgeFeedback' } : { to: 'unavailable' },
    }),
    'judge-out': edge({
      from: 'judgeFeedback',
      to: ['approved', 'askFixer', 'unavailable'],
      choose: (_state, event) => {
        const output = headlessOutput(event);
        if (output === null) return { to: 'unavailable' };
        return output.includes('approve') ? { to: 'approved' } : { to: 'askFixer' };
      },
    }),
    'fixer-out': edge({
      from: 'askFixer',
      to: ['revised', 'unavailable'],
      choose: (_state, event) => (turnEnded(event) ? { to: 'revised' } : { to: 'unavailable' }),
    }),
  },
  outcomes: {
    approved: outcome({ kind: 'success', output: () => ({ approved: true }) }),
    revised: outcome({ kind: 'success', output: () => ({ approved: false }) }),
    unavailable: outcome({
      kind: 'failure',
      reason: 'reviewer_unavailable',
      output: () => ({ approved: false }),
    }),
  },
});

// --- phase ------------------------------------------------------------------------------------

interface PhaseState {
  readonly phase: number;
  readonly reviewLimit: number;
  readonly implementer: AgentSessionHandle | null;
  readonly round: number;
  readonly verifyAttempts: number;
  readonly commitAttempts: number;
  readonly commit: string | null;
}

export interface PhaseParameters {
  readonly phase: number;
  readonly reviewLimit: number;
}

export interface PhaseOutput {
  readonly phase: number;
  readonly commit: string | null;
}

export const PhaseGraph = createGraph<
  PhaseState,
  { readonly round: number; readonly verifyAttempts: number; readonly commitAttempts: number },
  PhaseParameters,
  PhaseOutput
>({
  key: 'phase',
  title: 'Phase',
  intent: 'logical',
  label: (parameters) => `phase ${parameters.phase}`,
  init: (_destination, parameters) => ({
    phase: parameters.phase,
    reviewLimit: parameters.reviewLimit,
    implementer: null,
    round: 0,
    verifyAttempts: 0,
    commitAttempts: 0,
    commit: null,
  }),
  state: {
    phase: reduce.replace<number>(),
    reviewLimit: reduce.replace<number>(),
    implementer: reduce.replace<AgentSessionHandle | null>(),
    round: reduce.add(),
    verifyAttempts: reduce.add(),
    commitAttempts: reduce.add(),
    commit: reduce.replace<string | null>(),
  },
  entry: 'implement',
  nodes: {
    implement: operation(
      async (ctx, state) => {
        const implementer = await ctx.spawnAgentSession({
          harness: 'claude',
          prompt: `Implement phase ${state.phase} of the plan.`,
        });
        return suspend({ update: { implementer }, wait: wait.agentTurn(implementer) });
      },
      { title: 'Implement the phase' },
    ),
    askAboutImplementer: operation(
      async () =>
        suspend({
          wait: wait.userContinue('The implementer stopped. Continue it by hand, then Continue.'),
        }),
      { title: 'Ask about the implementer' },
    ),
    // No side effect: re-arm the wait on the same target. The latest turn wins, so the turn the
    // person just ran by hand is what answers it.
    recheckImplementer: operation(
      async (_ctx, state) => suspend({ wait: wait.agentTurn(state.implementer!) }),
      { title: 'Check the implementer again' },
    ),
    assess: operation(
      async (ctx, state) => {
        const history = await ctx.getConversationHistory(state.implementer!.agentSessionId);
        const judgment = await ctx.runHeadlessAgent({
          harness: 'claude',
          prompt: `Is this phase ready for review?\n\n${latestAssistantText(history)}`,
        });
        return suspend({ wait: wait.headlessAgent(judgment) });
      },
      { title: 'Assess the phase' },
    ),
    reviewRound: subgraph({
      graph: ReviewRoundGraph,
      title: 'Review round',
      parameters: (parent: PhaseState): ReviewRoundParameters => ({
        phase: parent.phase,
        round: parent.round + 1,
      }),
      onResult: () => ({ round: 1 }),
    }),
    verify: operation(
      async (ctx, state) => {
        const check = await ctx.runHeadlessAgent({
          harness: 'codex',
          prompt: `Run the checks for phase ${state.phase} and report pass or fail.`,
        });
        return suspend({ update: { verifyAttempts: 1 }, wait: wait.headlessAgent(check) });
      },
      { title: 'Verify the phase' },
    ),
    askAboutVerification: operation(
      async () =>
        suspend({ wait: wait.userContinue('Verification keeps failing. Fix it, then Continue.') }),
      { title: 'Ask about the verification' },
    ),
    commit: operation(
      async (ctx, state) => {
        const commit = await ctx.runHeadlessAgent({
          harness: 'claude',
          prompt: `Commit the work for phase ${state.phase} and report the SHA.`,
        });
        return suspend({ update: { commitAttempts: 1 }, wait: wait.headlessAgent(commit) });
      },
      { title: 'Commit the phase' },
    ),
    askAboutCommit: operation(
      async () => suspend({ wait: wait.userContinue('The commit failed. Fix it, then Continue.') }),
      { title: 'Ask about the commit' },
    ),
  },
  edges: {
    'implement-out': edge({
      from: 'implement',
      to: ['assess', 'askAboutImplementer'],
      choose: (_state, event) =>
        turnEnded(event) ? { to: 'assess' } : { to: 'askAboutImplementer' },
    }),
    'ask-implementer-out': edge({
      from: 'askAboutImplementer',
      to: ['recheckImplementer'],
      choose: () => ({ to: 'recheckImplementer' }),
    }),
    'recheck-out': edge({
      from: 'recheckImplementer',
      to: ['assess', 'askAboutImplementer'],
      choose: (_state, event) =>
        turnEnded(event) ? { to: 'assess' } : { to: 'askAboutImplementer' },
    }),
    'assess-out': edge({
      from: 'assess',
      to: ['reviewRound', 'abandoned'],
      choose: (_state, event) =>
        (headlessOutput(event) ?? '').includes('ready')
          ? { to: 'reviewRound' }
          : { to: 'abandoned' },
    }),
    'review-out': edge({
      from: 'reviewRound',
      to: ['verify', 'reviewRound', 'abandoned'],
      choose: (state, event) => {
        if (!eventGuards.isSubgraph(event) || event.result.outcomeKind === 'failure') {
          return { to: 'abandoned' };
        }
        if ((event.result.output as ReviewRoundOutput).approved) return { to: 'verify' };
        return state.round >= state.reviewLimit ? { to: 'verify' } : { to: 'reviewRound' };
      },
    }),
    'verify-out': edge({
      from: 'verify',
      to: ['commit', 'verify', 'askAboutVerification'],
      choose: (state, event) => {
        if ((headlessOutput(event) ?? '').includes('pass')) return { to: 'commit' };
        return state.verifyAttempts < selfRetryLimit
          ? { to: 'verify' }
          : { to: 'askAboutVerification' };
      },
    }),
    'ask-verification-out': edge({
      from: 'askAboutVerification',
      to: ['verify'],
      choose: () => ({ to: 'verify' }),
    }),
    'commit-out': edge({
      from: 'commit',
      to: ['committed', 'commit', 'askAboutCommit'],
      choose: (state, event) => {
        const output = headlessOutput(event);
        if (output !== null) return { to: 'committed', update: { commit: output.trim() } };
        return state.commitAttempts < selfRetryLimit ? { to: 'commit' } : { to: 'askAboutCommit' };
      },
    }),
    'ask-commit-out': edge({
      from: 'askAboutCommit',
      to: ['commit'],
      choose: () => ({ to: 'commit' }),
    }),
  },
  outcomes: {
    committed: outcome({
      kind: 'success',
      output: (state) => ({ phase: state.phase, commit: state.commit }),
    }),
    abandoned: outcome({
      kind: 'failure',
      reason: 'phase_abandoned',
      output: (state) => ({ phase: state.phase, commit: state.commit }),
    }),
  },
});

// --- phase-plan -------------------------------------------------------------------------------

interface PhasePlanState {
  readonly phases: number;
  readonly reviewLimit: number;
  readonly phaseIndex: number;
  readonly commits: readonly string[];
}

export interface PhasePlanOutput {
  readonly phases: number;
  readonly commits: readonly string[];
}

export const PhasePlanGraph = createGraph<
  PhasePlanState,
  { readonly phaseIndex: number; readonly commits: string },
  WorkflowInputs,
  PhasePlanOutput
>({
  key: 'phase-plan',
  title: 'Phase-wise plan',
  intent: 'business',
  init: (_destination, inputs) => ({
    phases: Number(inputs.phases ?? 1),
    reviewLimit: Number(inputs.reviewLimit ?? 1),
    phaseIndex: 0,
    commits: [],
  }),
  state: {
    phases: reduce.replace<number>(),
    reviewLimit: reduce.replace<number>(),
    phaseIndex: reduce.add(),
    commits: reduce.append<string>(),
  },
  entry: 'phase',
  nodes: {
    phase: subgraph({
      graph: PhaseGraph,
      title: 'Phase',
      parameters: (parent: PhasePlanState): PhaseParameters => ({
        phase: parent.phaseIndex + 1,
        reviewLimit: parent.reviewLimit,
      }),
      onResult: (_parent, result) => {
        const output = result.output as PhaseOutput;
        return { phaseIndex: 1, ...(output.commit === null ? {} : { commits: output.commit }) };
      },
    }),
  },
  edges: {
    'phase-out': edge({
      from: 'phase',
      to: ['phase', 'delivered', 'halted'],
      choose: (state, event) => {
        if (!eventGuards.isSubgraph(event) || event.result.outcomeKind === 'failure') {
          return { to: 'halted' };
        }
        return state.phaseIndex >= state.phases ? { to: 'delivered' } : { to: 'phase' };
      },
    }),
  },
  outcomes: {
    delivered: outcome({
      kind: 'success',
      output: (state) => ({ phases: state.phaseIndex, commits: state.commits }),
    }),
    halted: outcome({
      kind: 'failure',
      reason: 'phase_halted',
      output: (state) => ({ phases: state.phaseIndex, commits: state.commits }),
    }),
  },
});

export const phaseWiseReviewWorkflow = defineWorkflow({
  command: () => ({
    title: 'Phase-wise review',
    description: 'Implement a plan phase by phase, reviewing, verifying and committing each.',
    inputs: [{ kind: 'text', key: 'phases', label: 'How many phases' }],
  }),
  validate: () => undefined,
  graph: PhasePlanGraph,
});
