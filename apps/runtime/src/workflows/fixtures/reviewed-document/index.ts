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
  type HeadlessOperationResult,
  type WorkflowInputs,
} from '@yourtechbudstudio/isagi-workflow-sdk';

/**
 * The story's own example, authored against the public SDK.
 *
 * Writer → headless judgment → nested reviewer → revisions, under one root, with every shape the
 * acceptance criteria name present at least once:
 *
 * - **three layers of graph**, so a frame's depth and a node's identity are visibly different things;
 * - **a reusable graph invoked repeatedly** (`review`), so one definition and many invocations are
 *   distinguishable in the record rather than collapsed;
 * - **a non-linear return** to the writer when a turn confirms it failed, which is edge *data*, not
 *   an execution failure;
 * - **bounded rounds** through a counter reduced with `reduce.add()`, because nothing in the runtime
 *   bounds an author's loop for them;
 * - **a human escalation** the runtime will never satisfy on its own;
 * - **an authored failure outcome**, delivered to the parent's router as data — which is a different
 *   thing again from a segment that threw.
 *
 * It is hermetic: every external effect goes through `ctx`, so the capability adapters are the only
 * thing a test has to stand in for.
 */

const reviewLimit = 2;

interface ReviewState {
  readonly draft: string;
  readonly round: number;
  readonly reviewerSessionId: number | null;
  readonly reviewText: string | null;
  readonly verdict: string | null;
}

export interface ReviewParameters {
  readonly draft: string;
  readonly round: number;
}

export interface ReviewOutput {
  readonly verdict: string;
  readonly reviewText: string | null;
}

/**
 * One review pass: spawn a reviewer, wait for its turn, then judge what it said.
 *
 * Registered by the document graph and invoked once per round, which is what makes "a definition is
 * structure, a frame is one invocation of it" observable rather than asserted.
 */
export const ReviewGraph = createGraph<ReviewState, {}, ReviewParameters, ReviewOutput>({
  key: 'review',
  title: 'Review',
  intent: 'operational',
  label: (parameters) => `review round ${parameters.round}`,
  init: (_destination, parameters) => ({
    draft: parameters.draft,
    round: parameters.round,
    reviewerSessionId: null,
    reviewText: null,
    verdict: null,
  }),
  state: {
    draft: reduce.replace<string>(),
    round: reduce.replace<number>(),
    reviewerSessionId: reduce.replace<number | null>(),
    reviewText: reduce.replace<string | null>(),
    verdict: reduce.replace<string | null>(),
  },
  entry: 'spawnReviewer',
  nodes: {
    spawnReviewer: operation(
      async (ctx, state) => {
        const session = await ctx.spawnAgentSession({
          harness: 'claude',
          prompt: `Review this draft and reply with your notes:\n\n${state.draft}`,
        });
        return suspend({
          update: { reviewerSessionId: session.agentSessionId },
          wait: wait.agentTurn(session),
        });
      },
      { title: 'Spawn reviewer' },
    ),
    awaitReview: operation(
      async (ctx, state) => {
        const history =
          state.reviewerSessionId === null
            ? []
            : await ctx.getConversationHistory(state.reviewerSessionId);
        const text = latestAssistantText(history);
        return complete({ update: { reviewText: text } });
      },
      { title: 'Read the reviewer' },
    ),
    judgeReview: operation(
      async (ctx, state) => {
        const judgment = await ctx.runHeadlessAgent({
          harness: 'claude',
          prompt: `Decide whether this review approves the draft. Review:\n${state.reviewText ?? ''}`,
        });
        return suspend({ wait: wait.headlessAgent(judgment) });
      },
      { title: 'Judge the review' },
    ),
  },
  edges: {
    'spawn-out': edge({
      from: 'spawnReviewer',
      to: ['awaitReview', 'unavailable'],
      // A confirmed failed or interrupted turn is *data*: the reviewer did not answer, and the
      // author escalates rather than the runtime deciding that for them.
      choose: (_state, event) =>
        eventGuards.isAgentTurn(event) && event.outcome === 'ended'
          ? { to: 'awaitReview' }
          : { to: 'unavailable' },
    }),
    'await-out': edge({
      from: 'awaitReview',
      to: ['judgeReview'],
      choose: () => ({ to: 'judgeReview' }),
    }),
    'judge-out': edge({
      from: 'judgeReview',
      to: ['approved', 'revise', 'unavailable'],
      choose: (_state, event) => {
        if (!eventGuards.isHeadless(event)) return { to: 'unavailable' };
        const result = event.results[0] as HeadlessOperationResult | undefined;
        if (!result || result.status !== 'completed') return { to: 'unavailable' };
        const verdict = (result.output ?? '').includes('approve') ? 'approved' : 'revise';
        return { to: verdict === 'approved' ? 'approved' : 'revise', update: { verdict } };
      },
    }),
  },
  outcomes: {
    approved: outcome({
      kind: 'success',
      output: (state) => ({ verdict: 'approved', reviewText: state.reviewText }),
    }),
    revise: outcome({
      kind: 'success',
      output: (state) => ({ verdict: 'revise', reviewText: state.reviewText }),
    }),
    unavailable: outcome({
      kind: 'failure',
      reason: 'reviewer_unavailable',
      output: (state) => ({ verdict: 'unavailable', reviewText: state.reviewText }),
    }),
  },
});

interface DocumentState {
  readonly topic: string;
  readonly draft: string;
  readonly writerSessionId: number | null;
  readonly writerAttempts: number;
  readonly reviewRound: number;
  readonly verdicts: readonly string[];
}

export interface DocumentParameters {
  readonly topic: string;
}

export interface DocumentOutput {
  readonly draft: string;
  readonly verdicts: readonly string[];
  readonly reviewRound: number;
}

/** Writer, judgment, nested review, revisions — with every loop the author bounds themselves. */
export const ReviewedDocumentGraph = createGraph<
  DocumentState,
  { readonly writerAttempts: number; readonly reviewRound: number; readonly verdicts: string },
  DocumentParameters,
  DocumentOutput
>({
  key: 'reviewed-document',
  title: 'Reviewed document',
  intent: 'logical',
  label: (parameters) => `document: ${parameters.topic}`,
  init: (_destination, parameters) => ({
    topic: parameters.topic,
    draft: '',
    writerSessionId: null,
    writerAttempts: 0,
    reviewRound: 0,
    verdicts: [],
  }),
  state: {
    topic: reduce.replace<string>(),
    draft: reduce.replace<string>(),
    writerSessionId: reduce.replace<number | null>(),
    writerAttempts: reduce.add(),
    reviewRound: reduce.add(),
    verdicts: reduce.append<string>(),
  },
  entry: 'askWriter',
  nodes: {
    askWriter: operation(
      async (ctx, state) => {
        // A recorded call position either way: the first visit creates the session, later ones send
        // into the one it created, and both are durable operations with their own receipts.
        if (state.writerSessionId === null) {
          const session = await ctx.spawnAgentSession({
            harness: 'claude',
            prompt: `Write a short document about ${state.topic}.`,
          });
          return suspend({
            update: { writerSessionId: session.agentSessionId, writerAttempts: 1 },
            wait: wait.agentTurn(session),
          });
        }
        const target = await ctx.sendAgentPrompt({
          agentSessionId: state.writerSessionId,
          prompt: `Try again: write a short document about ${state.topic}.`,
        });
        return suspend({ update: { writerAttempts: 1 }, wait: wait.agentTurn(target) });
      },
      { title: 'Ask the writer', label: (state) => `writer attempt ${state.writerAttempts + 1}` },
    ),
    assessWriter: operation(
      async (ctx, state) => {
        const judgment = await ctx.runHeadlessAgent({
          harness: 'claude',
          prompt: `Is this draft ready for review?\n\n${state.draft}`,
        });
        return suspend({ wait: wait.headlessAgent(judgment) });
      },
      { title: 'Assess the draft' },
    ),
    review: subgraph({
      graph: ReviewGraph,
      title: 'Review',
      parameters: (parent: DocumentState): ReviewParameters => ({
        draft: parent.draft,
        round: parent.reviewRound,
      }),
      onResult: (_parent, result) => ({
        verdicts: (result.output as ReviewOutput).verdict,
        reviewRound: 1,
      }),
    }),
    revise: operation(
      async (ctx, state) => {
        const target = await ctx.sendAgentPrompt({
          agentSessionId: state.writerSessionId ?? 0,
          prompt: 'Revise the draft using the review notes.',
        });
        return suspend({ wait: wait.agentTurn(target) });
      },
      { title: 'Revise' },
    ),
  },
  edges: {
    'writer-out': edge({
      from: 'askWriter',
      to: ['assessWriter', 'askWriter', 'needs-human'],
      choose: (state, event) => {
        if (!eventGuards.isAgentTurn(event) || event.outcome !== 'ended') {
          // The non-linear return: a confirmed failed turn goes back to the writer, bounded by the
          // author's own counter. Nothing in the runtime would stop this loop for them.
          return state.writerAttempts >= reviewLimit ? { to: 'needs-human' } : { to: 'askWriter' };
        }
        return { to: 'assessWriter', update: { draft: `draft of ${state.topic}` } };
      },
    }),
    'assess-out': edge({
      from: 'assessWriter',
      to: ['review', 'askWriter', 'needs-human'],
      choose: (state, event) => {
        if (!eventGuards.isHeadless(event)) return { to: 'needs-human' };
        const result = event.results[0] as HeadlessOperationResult | undefined;
        if (result?.status === 'completed' && (result.output ?? '').includes('ready')) {
          return { to: 'review' };
        }
        return state.writerAttempts >= reviewLimit ? { to: 'needs-human' } : { to: 'askWriter' };
      },
    }),
    'review-out': edge({
      from: 'review',
      to: ['approved', 'revise', 'needs-human'],
      choose: (state, event) => {
        if (!eventGuards.isSubgraph(event)) return { to: 'needs-human' };
        // An authored failure outcome arrives here as data the parent routes on, never as an
        // execution failure the parent has to catch.
        if (event.result.outcomeKind === 'failure') return { to: 'needs-human' };
        const verdict = (event.result.output as ReviewOutput).verdict;
        if (verdict === 'approved') return { to: 'approved' };
        return state.reviewRound >= reviewLimit ? { to: 'needs-human' } : { to: 'revise' };
      },
    }),
    'revise-out': edge({
      from: 'revise',
      to: ['review', 'needs-human'],
      choose: (state, event) =>
        eventGuards.isAgentTurn(event) && event.outcome === 'ended'
          ? { to: 'review' }
          : state.reviewRound >= reviewLimit
            ? { to: 'needs-human' }
            : { to: 'review' },
    }),
  },
  outcomes: {
    approved: outcome({
      kind: 'success',
      output: (state) => ({
        draft: state.draft,
        verdicts: state.verdicts,
        reviewRound: state.reviewRound,
      }),
    }),
    'needs-human': outcome({
      kind: 'failure',
      reason: 'human_decision_required',
      output: (state) => ({
        draft: state.draft,
        verdicts: state.verdicts,
        reviewRound: state.reviewRound,
      }),
    }),
  },
});

interface StoryState {
  readonly topic: string;
  readonly document: DocumentOutput | null;
  readonly decision: string | null;
}

/**
 * How this fixture's root differs between two versions of itself.
 *
 * Deliberately a real authoring mistake rather than a test switch: the delivered outcome reads a
 * nested summary field that this workflow never produces. It is the kind of bug that only shows up
 * at the last segment, after the writer has worked, the child has published its output and a person
 * has answered — which is exactly the shape a mid-run version change has to survive.
 */
export interface StoryGraphVariant {
  readonly deliveredReadsMissingSummary?: boolean;
}

/** The root: one nested document, and a person to ask when the machinery runs out of options. */
export function makeStoryGraph(variant: StoryGraphVariant = {}) {
  return createGraph<
    StoryState,
    {},
    WorkflowInputs,
    { readonly decision: string; readonly document: DocumentOutput | null }
  >({
    key: 'story',
    title: 'Reviewed document story',
    intent: 'business',
    init: (_destination, inputs) => ({
      topic: typeof inputs.topic === 'string' ? inputs.topic : 'an unnamed topic',
      document: null,
      decision: null,
    }),
    state: {
      topic: reduce.replace<string>(),
      document: reduce.replace<DocumentOutput | null>(),
      decision: reduce.replace<string | null>(),
    },
    entry: 'document',
    nodes: {
      document: subgraph({
        graph: ReviewedDocumentGraph,
        title: 'Produce the document',
        parameters: (parent: StoryState): DocumentParameters => ({ topic: parent.topic }),
        onResult: (_parent, result) => ({ document: result.output as DocumentOutput }),
      }),
      decide: operation(
        async () =>
          suspend({
            wait: wait.userInput([
              {
                kind: 'select',
                key: 'decision',
                label: 'The reviewers could not agree. What should happen?',
                options: [
                  { value: 'deliver', label: 'Deliver it anyway' },
                  { value: 'abandon', label: 'Abandon it' },
                ],
              },
            ]),
          }),
        { title: 'Ask a person' },
      ),
    },
    edges: {
      'document-out': edge({
        from: 'document',
        to: ['delivered', 'decide'],
        choose: (_state, event) =>
          eventGuards.isSubgraph(event) && event.result.outcomeKind === 'success'
            ? { to: 'delivered' }
            : { to: 'decide' },
      }),
      'decide-out': edge({
        from: 'decide',
        to: ['delivered', 'abandoned'],
        choose: (_state, event) => {
          const decision = event.kind === 'user_input' ? String(event.answers.decision) : 'abandon';
          return {
            to: decision === 'deliver' ? 'delivered' : 'abandoned',
            update: { decision },
          };
        },
      }),
    },
    outcomes: {
      delivered: outcome({
        kind: 'success',
        output: (state) => ({
          decision: state.decision ?? 'automatic',
          document: state.document,
          ...(variant.deliveredReadsMissingSummary
            ? {
                summary: (
                  state.document as unknown as { readonly summary: { readonly text: string } }
                ).summary.text,
              }
            : {}),
        }),
      }),
      abandoned: outcome({
        kind: 'failure',
        reason: 'abandoned_by_operator',
        output: (state) => ({ decision: state.decision ?? 'abandon', document: state.document }),
      }),
    },
  });
}

export const StoryGraph = makeStoryGraph();

export function makeReviewedDocumentWorkflow(variant: StoryGraphVariant = {}) {
  return defineWorkflow({
    command: () => ({
      title: 'Reviewed document',
      description: 'Write a document, have it judged and reviewed, and revise it.',
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }],
    }),
    validate: (_origin, inputs) => {
      if (typeof inputs.topic !== 'string' || inputs.topic.length === 0) {
        throw new Error('A topic is required.');
      }
    },
    graph: makeStoryGraph(variant),
  });
}

export const reviewedDocumentWorkflow = makeReviewedDocumentWorkflow();

function latestAssistantText(
  history: readonly {
    readonly role: string;
    readonly parts: readonly { readonly text: string }[];
  }[],
): string | null {
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
