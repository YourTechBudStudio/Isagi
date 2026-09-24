import {
  complete,
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
  type WorkflowInputs,
} from '@yourtechbudstudio/isagi-workflow-sdk';

import { latestAssistantText, OncePerRun } from '../authoring.js';

/**
 * Implementing a phase-wise plan, with every step that matters kept as evidence.
 *
 * Adapted from the authored `implement-phase-wise-plan`, not ported from it: that package builds
 * against SDK 0.0.1 and composes by launching a child *run* through `ctx.startWorkflow`, which the
 * graph model replaced with subgraphs. What is preserved is its shape — a plan, a sequence of
 * phases, an implementer, a bounded review loop, a verification, a commit — and what is corrected
 * is the part story #45 exists for: the plan and the decision log were carried as **paths** that
 * any later edit could change under a reader, responses were copied into graph state as bare
 * strings with no durable reference to the operation that produced them, and the commit was a
 * parsed line nothing pinned.
 *
 * Three layers of graph, so `labels` can carry a real hierarchy:
 *
 * - `phase-plan` (business) captures the plan and the decision log, then loops the phase subgraph;
 * - `phase` (logical) implements, assesses, reviews, verifies and commits one phase;
 * - `review-round` (operational) is one reviewer/fixer pass, captured under `{ phase, round }`.
 *
 * The ordering rule the fixture exists to demonstrate: **every headless judgment is preceded by the
 * capture of the text it judges, and the text judged is the text captured.** A judgment made over a
 * reread would be a judgment of something no record pins.
 *
 * Hermetic: every external effect goes through `ctx`, and the only files it touches are the ones
 * its caller placed in the run's own worktree.
 */

/** Variant state that must misbehave exactly once per run. See `OncePerRun` for why it is keyed. */
const once = new OncePerRun();

/**
 * Clears the per-run variant state. **Required between tests, not hygiene.**
 *
 * Called by `publishPhaseWiseReview`, so no test has to remember it. Each harness builds its own database
 * and run ids restart at `1`, so two tests reaching the same marker are both "run 1" against
 * one module-level map; without this, the second silently takes the already-used branch.
 */
export function resetPhaseWiseReviewState(): void {
  once.reset();
}

export interface PhaseWiseReviewVariant {
  /**
   * Makes the named callback throw once per run, *after* its `captureEvidence` returned.
   *
   * The durable state this produces is the one the story turns on: bytes are published, the
   * evidence row is committed, and the segment that made the call never finished. A Retry must hand
   * the repaired callback the reference it already has rather than re-reading the agent.
   */
  readonly throwAfterCapture?: 'readImplementer' | 'reviewFeedback' | undefined;
}

// --- review-round -----------------------------------------------------------------------------

interface ReviewRoundState {
  readonly phase: number;
  readonly round: number;
  readonly reviewer: AgentSessionHandle | null;
  readonly fixer: AgentSessionHandle | null;
  /**
   * The text a judgment is about to be made over, held for exactly one node boundary.
   *
   * It is cleared by the node that consumes it, so the committed state a reader later inspects
   * carries evidence *references* and nothing else. Keeping the content would recreate the habit
   * this fixture is correcting — and it would be the second copy of something already immutable.
   */
  readonly pending: string | null;
  readonly approved: boolean;
}

export interface ReviewRoundParameters {
  readonly phase: number;
  readonly round: number;
}

export interface ReviewRoundOutput {
  readonly approved: boolean;
}

export function makeReviewRoundGraph(variant: PhaseWiseReviewVariant) {
  return createGraph<ReviewRoundState, {}, ReviewRoundParameters, ReviewRoundOutput>({
    key: 'review-round',
    title: 'Review round',
    intent: 'operational',
    label: (parameters) => `phase ${parameters.phase}, round ${parameters.round}`,
    init: (_destination, parameters) => ({
      phase: parameters.phase,
      round: parameters.round,
      reviewer: null,
      fixer: null,
      pending: null,
      approved: false,
    }),
    state: {
      phase: reduce.replace<number>(),
      round: reduce.replace<number>(),
      reviewer: reduce.replace<AgentSessionHandle | null>(),
      fixer: reduce.replace<AgentSessionHandle | null>(),
      pending: reduce.replace<string | null>(),
      approved: reduce.replace<boolean>(),
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
      readFeedback: operation(
        async (ctx, state) => {
          const reviewer = state.reviewer!;
          const history = await ctx.getConversationHistory(reviewer.agentSessionId);
          const feedback = latestAssistantText(history);
          // Captured *before* anything judges it, and the handle the callback already holds is
          // handed straight back as the source — the runtime projects away the `paneId` it carries.
          await ctx.captureEvidence({
            title: `Review feedback, phase ${state.phase} round ${state.round}`,
            role: 'review-feedback',
            labels: { phase: state.phase, round: state.round },
            content: { kind: 'text', text: feedback },
            source: { kind: 'agent_turn', target: reviewer },
          });
          if (variant.throwAfterCapture === 'reviewFeedback') {
            once.failOnce('reviewFeedback', ctx.invocation.runId);
          }
          return complete({ update: { pending: feedback } });
        },
        { title: 'Read the reviewer' },
      ),
      judgeFeedback: operation(
        async (ctx, state) => {
          const judgment = await ctx.runHeadlessAgent({
            harness: 'claude',
            prompt: `Does this review approve the work?\n\n${state.pending ?? ''}`,
          });
          return suspend({ update: { pending: null }, wait: wait.headlessAgent(judgment) });
        },
        { title: 'Judge the feedback' },
      ),
      askFixer: operation(
        async (ctx, state) => {
          const fixer = await ctx.spawnAgentSession({
            harness: 'claude',
            prompt: `Address the review for phase ${state.phase}, round ${state.round}.`,
          });
          return suspend({ update: { fixer }, wait: wait.agentTurn(fixer) });
        },
        { title: 'Ask a fixer' },
      ),
      readFixer: operation(
        async (ctx, state) => {
          const fixer = state.fixer!;
          const history = await ctx.getConversationHistory(fixer.agentSessionId);
          await ctx.captureEvidence({
            title: `Fixer response, phase ${state.phase} round ${state.round}`,
            role: 'fixer-response',
            labels: { phase: state.phase, round: state.round },
            content: { kind: 'text', text: latestAssistantText(history) },
            source: { kind: 'agent_turn', target: fixer },
          });
          return complete({});
        },
        { title: 'Read the fixer' },
      ),
    },
    edges: {
      'reviewer-out': edge({
        from: 'askReviewer',
        to: ['readFeedback', 'unavailable'],
        choose: (_state, event) =>
          eventGuards.isAgentTurn(event) && event.outcome === 'ended'
            ? { to: 'readFeedback' }
            : { to: 'unavailable' },
      }),
      'feedback-out': edge({
        from: 'readFeedback',
        to: ['judgeFeedback'],
        choose: () => ({ to: 'judgeFeedback' }),
      }),
      'judge-out': edge({
        from: 'judgeFeedback',
        to: ['approved', 'askFixer', 'unavailable'],
        choose: (_state, event) => {
          if (!eventGuards.isHeadless(event)) return { to: 'unavailable' };
          const result = event.results[0] as HeadlessOperationResult | undefined;
          if (!result || result.status !== 'completed') return { to: 'unavailable' };
          return (result.output ?? '').includes('approve')
            ? { to: 'approved', update: { approved: true } }
            : { to: 'askFixer' };
        },
      }),
      'fixer-out': edge({
        from: 'askFixer',
        to: ['readFixer', 'unavailable'],
        choose: (_state, event) =>
          eventGuards.isAgentTurn(event) && event.outcome === 'ended'
            ? { to: 'readFixer' }
            : { to: 'unavailable' },
      }),
      'read-fixer-out': edge({
        from: 'readFixer',
        to: ['revised'],
        choose: () => ({ to: 'revised' }),
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
}

// --- phase ------------------------------------------------------------------------------------

interface PhaseState {
  readonly phase: number;
  readonly reviewLimit: number;
  readonly implementer: AgentSessionHandle | null;
  readonly implementerEvidenceId: string | null;
  readonly pending: string | null;
  readonly round: number;
  readonly approved: boolean;
  readonly commitOperationId: string | null;
  readonly commitOutput: string | null;
  readonly commitEvidenceId: string | null;
}

export interface PhaseParameters {
  readonly phase: number;
  readonly reviewLimit: number;
}

export interface PhaseOutput {
  readonly phase: number;
  readonly commitEvidenceId: string | null;
  readonly implementerEvidenceId: string | null;
}

export function makePhaseGraph(variant: PhaseWiseReviewVariant) {
  const ReviewRoundGraph = makeReviewRoundGraph(variant);
  return createGraph<PhaseState, { readonly round: number }, PhaseParameters, PhaseOutput>({
    key: 'phase',
    title: 'Phase',
    intent: 'logical',
    label: (parameters) => `phase ${parameters.phase}`,
    init: (_destination, parameters) => ({
      phase: parameters.phase,
      reviewLimit: parameters.reviewLimit,
      implementer: null,
      implementerEvidenceId: null,
      pending: null,
      round: 0,
      approved: false,
      commitOperationId: null,
      commitOutput: null,
      commitEvidenceId: null,
    }),
    state: {
      phase: reduce.replace<number>(),
      reviewLimit: reduce.replace<number>(),
      implementer: reduce.replace<AgentSessionHandle | null>(),
      implementerEvidenceId: reduce.replace<string | null>(),
      pending: reduce.replace<string | null>(),
      round: reduce.add(),
      approved: reduce.replace<boolean>(),
      commitOperationId: reduce.replace<string | null>(),
      commitOutput: reduce.replace<string | null>(),
      commitEvidenceId: reduce.replace<string | null>(),
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
      readImplementer: operation(
        async (ctx, state) => {
          const implementer = state.implementer!;
          const history = await ctx.getConversationHistory(implementer.agentSessionId);
          const response = latestAssistantText(history);
          const kept = await ctx.captureEvidence({
            title: `Implementer response, phase ${state.phase}`,
            role: 'implementer-response',
            labels: { phase: state.phase },
            content: { kind: 'text', text: response },
            source: { kind: 'agent_turn', target: implementer },
          });
          if (variant.throwAfterCapture === 'readImplementer') {
            once.failOnce('readImplementer', ctx.invocation.runId);
          }
          // Only the reference is durable. `pending` is working memory for the very next node,
          // which clears it — the judged text is this captured text, and nothing keeps a copy.
          return complete({
            update: { implementerEvidenceId: kept.evidenceId, pending: response },
          });
        },
        { title: 'Read the implementer' },
      ),
      assess: operation(
        async (ctx, state) => {
          const judgment = await ctx.runHeadlessAgent({
            harness: 'claude',
            prompt: `Is this phase ready for review?\n\n${state.pending ?? ''}`,
          });
          return suspend({ update: { pending: null }, wait: wait.headlessAgent(judgment) });
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
        onResult: (_parent, result) => ({
          round: 1,
          approved: (result.output as ReviewRoundOutput).approved,
        }),
      }),
      verify: operation(
        async (ctx, state) => {
          // A recorded literal, not a check that ran: a hermetic fixture cannot shell out, and the
          // point here is that a structured verification result is *keepable*, not that it passed.
          await ctx.captureEvidence({
            title: `Verification, phase ${state.phase}`,
            role: 'verification',
            labels: { phase: state.phase },
            content: { kind: 'json', value: { command: 'pnpm check', exitCode: 0 } },
          });
          return complete({});
        },
        { title: 'Verify the phase' },
      ),
      commit: operation(
        async (ctx, state) => {
          const commit = await ctx.runHeadlessAgent({
            harness: 'claude',
            prompt: `Commit the work for phase ${state.phase} and report the SHA as JSON.`,
          });
          return suspend({
            update: { commitOperationId: commit.operationId },
            wait: wait.headlessAgent(commit),
          });
        },
        { title: 'Commit the phase' },
      ),
      recordCommit: operation(
        async (ctx, state) => {
          const parsed = parseCommitReport(state.commitOutput);
          const kept = await ctx.captureEvidence({
            title: `Commit, phase ${state.phase}`,
            role: 'commit',
            labels: { phase: state.phase },
            content: { kind: 'json', value: parsed },
            // Exact attribution without a new read verb: the handle the launching node recorded.
            source: {
              kind: 'headless_operation',
              operation: { operationId: state.commitOperationId! },
            },
          });
          return complete({
            update: { commitEvidenceId: kept.evidenceId, commitOutput: null },
          });
        },
        { title: 'Record the commit' },
      ),
    },
    edges: {
      'implement-out': edge({
        from: 'implement',
        to: ['readImplementer', 'abandoned'],
        choose: (_state, event) =>
          eventGuards.isAgentTurn(event) && event.outcome === 'ended'
            ? { to: 'readImplementer' }
            : { to: 'abandoned' },
      }),
      'read-out': edge({
        from: 'readImplementer',
        to: ['assess'],
        choose: () => ({ to: 'assess' }),
      }),
      'assess-out': edge({
        from: 'assess',
        to: ['reviewRound', 'abandoned'],
        choose: (_state, event) => {
          if (!eventGuards.isHeadless(event)) return { to: 'abandoned' };
          const result = event.results[0] as HeadlessOperationResult | undefined;
          return result?.status === 'completed' && (result.output ?? '').includes('ready')
            ? { to: 'reviewRound' }
            : { to: 'abandoned' };
        },
      }),
      'review-out': edge({
        from: 'reviewRound',
        to: ['verify', 'reviewRound', 'abandoned'],
        choose: (state, event) => {
          if (!eventGuards.isSubgraph(event)) return { to: 'abandoned' };
          if (event.result.outcomeKind === 'failure') return { to: 'abandoned' };
          if ((event.result.output as ReviewRoundOutput).approved) return { to: 'verify' };
          // The author's own bound. Nothing in the runtime stops this loop for them, and each pass
          // is a fresh visit — which is what makes a *deliberate* re-capture legal.
          return state.round >= state.reviewLimit ? { to: 'verify' } : { to: 'reviewRound' };
        },
      }),
      'verify-out': edge({ from: 'verify', to: ['commit'], choose: () => ({ to: 'commit' }) }),
      'commit-out': edge({
        from: 'commit',
        to: ['recordCommit', 'abandoned'],
        choose: (_state, event) => {
          if (!eventGuards.isHeadless(event)) return { to: 'abandoned' };
          const result = event.results[0] as HeadlessOperationResult | undefined;
          if (result?.status !== 'completed') return { to: 'abandoned' };
          return { to: 'recordCommit', update: { commitOutput: result.output ?? '' } };
        },
      }),
      'record-out': edge({
        from: 'recordCommit',
        to: ['committed'],
        choose: () => ({ to: 'committed' }),
      }),
    },
    outcomes: {
      committed: outcome({
        kind: 'success',
        output: (state) => ({
          phase: state.phase,
          commitEvidenceId: state.commitEvidenceId,
          implementerEvidenceId: state.implementerEvidenceId,
        }),
      }),
      abandoned: outcome({
        kind: 'failure',
        reason: 'phase_abandoned',
        output: (state) => ({
          phase: state.phase,
          commitEvidenceId: state.commitEvidenceId,
          implementerEvidenceId: state.implementerEvidenceId,
        }),
      }),
    },
  });
}

// --- phase-plan -------------------------------------------------------------------------------

interface PhasePlanState {
  readonly planPath: string;
  readonly decisionLogPath: string;
  readonly phases: number;
  readonly reviewLimit: number;
  readonly phaseIndex: number;
  /** Evidence *references*, never content. This is the array the authored source filled with text. */
  readonly committed: readonly string[];
}

export interface PhasePlanOutput {
  readonly phases: number;
  readonly committed: readonly string[];
}

export function makePhasePlanGraph(variant: PhaseWiseReviewVariant) {
  const PhaseGraph = makePhaseGraph(variant);
  return createGraph<
    PhasePlanState,
    { readonly phaseIndex: number; readonly committed: string },
    WorkflowInputs,
    PhasePlanOutput
  >({
    key: 'phase-plan',
    title: 'Phase-wise plan',
    intent: 'business',
    init: (_destination, inputs) => ({
      planPath: String(inputs.planPath ?? 'docs/plan.md'),
      decisionLogPath: String(inputs.decisionLogPath ?? 'docs/decisions.md'),
      phases: Number(inputs.phases ?? 1),
      reviewLimit: Number(inputs.reviewLimit ?? 1),
      phaseIndex: 0,
      committed: [],
    }),
    state: {
      planPath: reduce.replace<string>(),
      decisionLogPath: reduce.replace<string>(),
      phases: reduce.replace<number>(),
      reviewLimit: reduce.replace<number>(),
      phaseIndex: reduce.add(),
      committed: reduce.append<string>(),
    },
    entry: 'capturePlan',
    nodes: {
      capturePlan: operation(
        async (ctx, state) => {
          // The correction this fixture exists to make: the authored source carried these as paths
          // and let every later reader see whatever the file said at the time.
          await ctx.captureEvidence({
            title: 'The plan',
            role: 'plan',
            content: { kind: 'file', path: state.planPath },
          });
          await ctx.captureEvidence({
            title: 'The decision log',
            role: 'decision-log',
            content: { kind: 'file', path: state.decisionLogPath },
          });
          return complete({});
        },
        { title: 'Capture the plan' },
      ),
      phase: subgraph({
        graph: PhaseGraph,
        title: 'Phase',
        parameters: (parent: PhasePlanState): PhaseParameters => ({
          phase: parent.phaseIndex + 1,
          reviewLimit: parent.reviewLimit,
        }),
        onResult: (_parent, result) => {
          const output = result.output as PhaseOutput;
          return {
            phaseIndex: 1,
            ...(output.commitEvidenceId === null ? {} : { committed: output.commitEvidenceId }),
          };
        },
      }),
    },
    edges: {
      'plan-out': edge({ from: 'capturePlan', to: ['phase'], choose: () => ({ to: 'phase' }) }),
      'phase-out': edge({
        from: 'phase',
        to: ['phase', 'delivered', 'halted'],
        choose: (state, event) => {
          if (!eventGuards.isSubgraph(event)) return { to: 'halted' };
          if (event.result.outcomeKind === 'failure') return { to: 'halted' };
          return state.phaseIndex >= state.phases ? { to: 'delivered' } : { to: 'phase' };
        },
      }),
    },
    outcomes: {
      delivered: outcome({
        kind: 'success',
        output: (state) => ({ phases: state.phaseIndex, committed: state.committed }),
      }),
      halted: outcome({
        kind: 'failure',
        reason: 'phase_halted',
        output: (state) => ({ phases: state.phaseIndex, committed: state.committed }),
      }),
    },
  });
}

export function makePhaseWiseReviewWorkflow(variant: PhaseWiseReviewVariant = {}) {
  return defineWorkflow({
    command: () => ({
      title: 'Phase-wise review',
      description: 'Implement a plan phase by phase, keeping what each phase produced.',
      inputs: [
        { kind: 'text', key: 'planPath', label: 'Plan path' },
        { kind: 'text', key: 'decisionLogPath', label: 'Decision log path' },
      ],
    }),
    validate: (_origin, inputs) => {
      if (typeof inputs.planPath !== 'string' || inputs.planPath.length === 0) {
        throw new Error('A plan path is required.');
      }
    },
    graph: makePhasePlanGraph(variant),
  });
}

export const phaseWiseReviewWorkflow = makePhaseWiseReviewWorkflow();

/**
 * What the committing agent printed, read the way the authored source reads it.
 *
 * Tolerant on purpose: the commit is a *parsed* fact rather than one the runtime observed, and the
 * capture's value must still be well-formed when the agent answers with prose. The call's identity
 * carries none of this, so a differently-shaped answer on a repair cannot change the position.
 */
function parseCommitReport(output: string | null): {
  readonly commit: string | null;
  readonly subject: string | null;
} {
  if (!output) return { commit: null, subject: null };
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return {
      commit: typeof parsed.commit === 'string' ? parsed.commit : null,
      subject: typeof parsed.subject === 'string' ? parsed.subject : null,
    };
  } catch {
    return { commit: null, subject: null };
  }
}
