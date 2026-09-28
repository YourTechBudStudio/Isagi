/**
 * The author-facing typing contract. Every `@ts-expect-error` here is paired with a positive case
 * that must still compile, so a lost check fails the build as an unused directive.
 */
import {
  complete,
  createGraph,
  edge,
  operation,
  outcome,
  reduce,
  subgraph,
  suspend,
  wait,
  type CollectionUpdate,
  type GraphUpdate,
  type OptionalUpdate,
  type ResolvedUpdates,
} from '../src/index.js';

type Feedback = { readonly id: string; readonly text: string };

type ReviewState = {
  readonly reviewRound: number;
  readonly feedback: readonly Feedback[];
  readonly reviewer: number | null;
  readonly documentPath: string;
};

type ReviewUpdates = {
  readonly feedback: CollectionUpdate<Feedback>;
  readonly reviewer: OptionalUpdate<number>;
  // reviewRound and documentPath are omitted: their update type is their stored type.
};

type ReviewParameters = { readonly documentPath: string };

const reviewState = {
  reviewRound: reduce.add(),
  feedback: reduce.collection<Feedback>((value) => value.id),
  reviewer: reduce.optional<number>(),
  documentPath: reduce.replace<string>(),
};

const reviewInit = (_destination: unknown, parameters: ReviewParameters): ReviewState => ({
  reviewRound: 0,
  feedback: [],
  reviewer: null,
  documentPath: parameters.documentPath,
});

// ---------------------------------------------------------------------------
// ResolvedUpdates: overrides win, omitted keys fall back to the stored type.
// ---------------------------------------------------------------------------

type Resolved = ResolvedUpdates<ReviewState, ReviewUpdates>;

const overriddenField: Resolved['feedback'] = { op: 'clear' };
const fallbackNumber: Resolved['reviewRound'] = 1;
const fallbackString: Resolved['documentPath'] = 'docs/plan.md';
// @ts-expect-error reviewRound falls back to its stored number type.
const fallbackIsNotWidened: Resolved['reviewRound'] = 'one';

// ---------------------------------------------------------------------------
// createGraph: extra override keys and missing reducers are compile errors.
// ---------------------------------------------------------------------------

type GhostUpdates = ReviewUpdates & { readonly ghost: string };

const withGhostOverride = createGraph<
  ReviewState,
  // @ts-expect-error `ghost` names no ReviewState field.
  GhostUpdates,
  ReviewParameters,
  string
>({
  key: 'Ghost',
  title: 'Ghost',
  init: reviewInit,
  state: reviewState,
  entry: 'noop',
  nodes: { noop: operation(async () => complete()) },
  edges: { fromNoop: edge({ from: 'noop', to: ['done'], choose: () => ({ to: 'done' }) }) },
  outcomes: { done: outcome({ kind: 'success', output: (state) => state.documentPath }) },
});

const withMissingReducer = createGraph<ReviewState, ReviewUpdates, ReviewParameters, string>({
  key: 'MissingReducer',
  title: 'Missing reducer',
  init: reviewInit,
  // @ts-expect-error every State key needs a field registration; `documentPath` has none.
  state: {
    reviewRound: reduce.add(),
    feedback: reduce.collection<Feedback>((value) => value.id),
    reviewer: reduce.optional<number>(),
  },
  entry: 'noop',
  nodes: { noop: operation(async () => complete()) },
  edges: { fromNoop: edge({ from: 'noop', to: ['done'], choose: () => ({ to: 'done' }) }) },
  outcomes: { done: outcome({ kind: 'success', output: (state) => state.documentPath }) },
});

// ---------------------------------------------------------------------------
// Every emitter is typed by the same resolved update map.
// ---------------------------------------------------------------------------

const childGraph = createGraph<
  { readonly verdict: string },
  {},
  { readonly documentPath: string },
  { readonly verdict: string }
>({
  key: 'Child',
  title: 'Child',
  init: () => ({ verdict: 'pending' }),
  state: { verdict: reduce.replace<string>() },
  entry: 'decide',
  nodes: { decide: operation(async () => complete({ update: { verdict: 'pass' } })) },
  edges: { fromDecide: edge({ from: 'decide', to: ['ok'], choose: () => ({ to: 'ok' }) }) },
  outcomes: { ok: outcome({ kind: 'success', output: (state) => ({ verdict: state.verdict }) }) },
});

const goodGraph = createGraph<ReviewState, ReviewUpdates, ReviewParameters, string>({
  key: 'Review',
  title: 'Review',
  intent: 'logical',
  label: (parameters) => parameters.documentPath,
  init: reviewInit,
  state: reviewState,
  entry: 'askWriter',
  nodes: {
    // Node result: state is contextually typed, and a command-shaped field takes a command.
    askWriter: operation(async (_ctx, state) =>
      complete({
        update: {
          reviewRound: 1,
          feedback: { op: 'add', values: [] },
          documentPath: state.documentPath,
        },
      }),
    ),
    // Node result through suspend, with an explicit clear for a nullable field.
    assign: operation(async () =>
      suspend({ update: { reviewer: { clear: true } }, wait: wait.userContinue() }),
    ),
    // Subgraph mapping.
    review: subgraph({
      graph: childGraph,
      parameters: (parent: ReviewState) => ({ documentPath: parent.documentPath }),
      onResult: (_parent, result): GraphUpdate<Resolved> => ({
        documentPath: result.output.verdict,
        reviewRound: 1,
      }),
    }),
  },
  edges: {
    // Edge decision update.
    fromAskWriter: edge({
      from: 'askWriter',
      to: ['assign', 'review', 'delivered'],
      choose: (state, event) => ({
        to: event.kind === 'immediate' && state.reviewRound > 2 ? 'delivered' : 'assign',
        update: { reviewer: { set: 7 } },
      }),
    }),
    fromAssign: edge({ from: 'assign', to: ['review'], choose: () => ({ to: 'review' }) }),
    fromReview: edge({ from: 'review', to: ['delivered'], choose: () => ({ to: 'delivered' }) }),
  },
  outcomes: { delivered: outcome({ kind: 'success', output: (state) => state.documentPath }) },
});

// ---------------------------------------------------------------------------
// Rejections at each emitter.
// ---------------------------------------------------------------------------

const badNodeResult = operation<ReviewState, Resolved>(async () =>
  // @ts-expect-error `feedback` declares a command-shaped update; a bare array is not one.
  complete({ update: { feedback: [] as readonly Feedback[] } }),
);

const badNodeField = operation<ReviewState, Resolved>(async () =>
  // @ts-expect-error `documentPath` stores a string.
  complete({ update: { documentPath: 42 } }),
);

const badSuspendResult = operation<ReviewState, Resolved>(async () =>
  // @ts-expect-error `reviewer` declares an explicit set/clear command, not a bare value.
  suspend({ update: { reviewer: 7 }, wait: wait.userContinue() }),
);

const badEdgeUpdate = edge<ReviewState, Resolved>({
  from: 'askWriter',
  to: ['delivered'],
  // @ts-expect-error `reviewRound` stores a number.
  choose: () => ({ to: 'delivered', update: { reviewRound: 'one' } }),
});

const badSubgraphMapping = subgraph<
  ReviewState,
  Resolved,
  { readonly documentPath: string },
  { readonly verdict: string }
>({
  graph: childGraph,
  parameters: (parent) => ({ documentPath: parent.documentPath }),
  // @ts-expect-error `feedback` declares a command-shaped update.
  onResult: () => ({ feedback: [] as readonly Feedback[] }),
});

const badSubgraphParameters = subgraph<
  ReviewState,
  Resolved,
  { readonly documentPath: string },
  { readonly verdict: string }
>({
  graph: childGraph,
  // @ts-expect-error the child's parameters type is not satisfied by this mapping.
  parameters: (parent) => ({ document: parent.documentPath }),
  onResult: () => ({}),
});

const badOutcomeOutput = outcome<ReviewState, string>({
  kind: 'success',
  // @ts-expect-error the graph's Output is a string.
  output: (state) => state.reviewRound,
});

// ---------------------------------------------------------------------------
// Defaulted overrides: replacement semantics for every field.
// ---------------------------------------------------------------------------

type SimpleState = { readonly count: number; readonly name: string };

const simpleGraph = createGraph<SimpleState>({
  key: 'Simple',
  title: 'Simple',
  init: () => ({ count: 0, name: '' }),
  state: { count: reduce.replace<number>(), name: reduce.replace<string>() },
  entry: 'noop',
  nodes: {
    noop: operation(async () => complete({ update: { name: 'x', count: 1 } })),
    bad: operation<SimpleState, ResolvedUpdates<SimpleState, {}>>(async () =>
      // @ts-expect-error with no overrides, every field takes its stored type.
      complete({ update: { count: 'one' } }),
    ),
  },
  edges: { fromNoop: edge({ from: 'noop', to: ['done'], choose: () => ({ to: 'done' }) }) },
  outcomes: { done: outcome({ kind: 'success', output: () => undefined }) },
});

void overriddenField;
void fallbackNumber;
void fallbackString;
void fallbackIsNotWidened;
void withGhostOverride;
void withMissingReducer;
void goodGraph;
void badNodeResult;
void badNodeField;
void badSuspendResult;
void badEdgeUpdate;
void badSubgraphMapping;
void badSubgraphParameters;
void badOutcomeOutput;
void simpleGraph;
