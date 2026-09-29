/**
 * The launch hooks: `parse` alone decides the root graph's parameters, `placement` receives them,
 * and the root graph is an ordinary graph that can equally be invoked as a subgraph. Every
 * `@ts-expect-error` here is paired with a positive case that must still compile, so a lost check
 * fails the build as an unused directive.
 */
import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  subgraph,
} from '../src/index.js';
import type {
  WorkflowDefinition,
  WorkflowInputs,
  WorkflowOrigin,
  WorkflowPlacementContext,
  WorkflowPlacementRequest,
} from '../src/index.js';

interface Parameters {
  readonly branch: string;
  readonly agentSessionId: number | null;
}

const graph = createGraph<{ readonly note: string }, {}, Parameters, string>({
  key: 'Root',
  title: 'Root',
  init: (_destination, parameters) => ({ note: parameters.branch }),
  state: { note: reduce.replace<string>() },
  entry: 'act',
  nodes: { act: operation(async () => complete({ update: { note: 'done' } })) },
  edges: { fromAct: edge({ from: 'act', to: ['done'], choose: () => ({ to: 'done' }) }) },
  outcomes: { done: outcome({ kind: 'success', output: (state) => state.note }) },
});

function parseBranch(inputs: WorkflowInputs): string {
  if (typeof inputs.branch !== 'string' || !inputs.branch) throw new Error('Name a branch.');
  return inputs.branch;
}

function acceptBranch(branch: string): void {
  void branch;
}

function acceptProjectKind(kind: 'git' | 'folder'): void {
  void kind;
}

// Positive: `parse` receives the origin and the raw answers and returns the root graph's
// parameters; `placement`'s parameters are inferred from `parse`, and `ctx` is the placement
// context, not `any`.
const inferred = defineWorkflow({
  command: () => ({ title: 'Test' }),
  parse: (origin, inputs) => ({
    branch: parseBranch(inputs),
    agentSessionId: origin.agentSessionId ?? null,
  }),
  placement: (ctx, parameters) => {
    acceptBranch(parameters.branch);
    acceptProjectKind(ctx.project.kind);
    return {
      worktree: { kind: 'create', branch: parameters.branch, fromRef: 'main' },
      surface: { kind: 'create', title: parameters.branch },
    };
  },
  graph,
});

// The definition's parameter type is exactly the graph's.
const typed: WorkflowDefinition<Parameters, string> = inferred;
void typed;

function acceptHook(
  hook: (
    ctx: WorkflowPlacementContext,
    parameters: Parameters,
  ) => WorkflowPlacementRequest | Promise<WorkflowPlacementRequest>,
): void {
  void hook;
}

// Passed without a cast on purpose: a cast here would still compile if the inferred parameter type
// regressed, which is the whole risk this case exists to catch.
if (inferred.placement !== undefined) acceptHook(inferred.placement);

// Positive: an async `parse` is accepted, and its awaited value is the parameters type.
const asyncParse = defineWorkflow({
  command: () => ({ title: 'Test' }),
  parse: async (origin: WorkflowOrigin, inputs) => {
    await Promise.resolve();
    return { branch: parseBranch(inputs), agentSessionId: origin.agentSessionId ?? null };
  },
  placement: async (ctx, parameters): Promise<WorkflowPlacementRequest> => {
    const worktrees = await ctx.listWorktrees();
    const surfaces = await ctx.listSurfaces({ worktreeId: ctx.origin.worktreeId });
    const target = worktrees.find((worktree) => worktree.branch === parameters.branch);
    if (target === undefined)
      return { worktree: { kind: 'current' }, surface: { kind: 'current' } };
    const surface = surfaces[0];
    return {
      worktree: { kind: 'existing', worktreeId: target.id },
      surface:
        surface === undefined
          ? { kind: 'create', title: 'Work' }
          : { kind: 'existing', surfaceId: surface.id },
    };
  },
  graph,
});
const asyncTyped: WorkflowDefinition<Parameters, string> = asyncParse;
void asyncTyped;

// Positive: `placement` stays optional, and reading the member is legal because its type includes
// `undefined`.
const withoutPlacement = defineWorkflow({
  command: () => ({ title: 'Test' }),
  parse: (_origin, inputs) => ({ branch: parseBranch(inputs), agentSessionId: null }),
  graph,
});
const absent: typeof withoutPlacement.placement = undefined;
void absent;

// Positive: an annotated `parse` return keeps a literal-union field that an unannotated object
// literal would widen to `string`.
interface ModeParameters {
  readonly mode: 'fast' | 'slow';
}
const modeGraph = createGraph<{ readonly mode: 'fast' | 'slow' }, {}, ModeParameters, string>({
  key: 'Mode',
  title: 'Mode',
  init: (_destination, parameters) => ({ mode: parameters.mode }),
  state: { mode: reduce.replace<'fast' | 'slow'>() },
  entry: 'act',
  nodes: { act: operation(async () => complete()) },
  edges: { fromAct: edge({ from: 'act', to: ['done'], choose: () => ({ to: 'done' }) }) },
  outcomes: { done: outcome({ kind: 'success', output: (state) => state.mode }) },
});
const annotatedParse = defineWorkflow({
  command: () => ({ title: 'Test' }),
  parse: (_origin, inputs): ModeParameters => ({
    mode: inputs.mode === 'slow' ? 'slow' : 'fast',
  }),
  placement: (_ctx, parameters) => ({
    worktree: { kind: 'current' },
    surface: { kind: 'create', title: parameters.mode },
  }),
  graph: modeGraph,
});
const annotatedTyped: WorkflowDefinition<ModeParameters, string> = annotatedParse;
void annotatedTyped;

defineWorkflow({
  command: () => ({ title: 'Test' }),
  // @ts-expect-error a value outside the literal union is not the graph's parameters.
  parse: (): { readonly mode: string } => ({ mode: 'medium' }),
  graph: modeGraph,
});

// Positive: ordinary structural assignability applies, so a `parse` that returns more fields than
// the root graph declares is accepted. The definition's parameters are what `parse` returns, so
// `placement` sees the extra field; the graph reads only the fields it declares.
const extraFields = defineWorkflow({
  command: () => ({ title: 'Test' }),
  parse: (origin, inputs) => ({
    branch: parseBranch(inputs),
    agentSessionId: origin.agentSessionId ?? null,
    draft: true,
  }),
  placement: (_ctx, parameters) => ({
    worktree: { kind: 'current' },
    surface: { kind: 'create', title: parameters.draft ? 'Draft' : parameters.branch },
  }),
  graph,
});
const extraFieldsTyped: WorkflowDefinition<Parameters & { readonly draft: boolean }, string> =
  extraFields;
void extraFieldsTyped;

// Positive: a graph with no parameters pairs with a `parse` that only checks the answers.
const noParameters = createGraph<{ readonly note: string }>({
  key: 'Plain',
  title: 'Plain',
  init: () => ({ note: '' }),
  state: { note: reduce.replace<string>() },
  entry: 'act',
  nodes: { act: operation(async () => complete()) },
  edges: { fromAct: edge({ from: 'act', to: ['done'], choose: () => ({ to: 'done' }) }) },
  outcomes: { done: outcome({ kind: 'success', output: () => undefined }) },
});
const checkOnly = defineWorkflow({
  command: () => ({ title: 'Test' }),
  parse: (_origin, inputs) => {
    parseBranch(inputs);
  },
  graph: noParameters,
});
void checkOnly;

// The same graph is a workflow root above and a subgraph target here, with no change to it.
const parent = createGraph<{ readonly branch: string; readonly agentSessionId: number }>({
  key: 'Parent',
  title: 'Parent',
  init: () => ({ branch: 'main', agentSessionId: 7 }),
  state: { branch: reduce.replace<string>(), agentSessionId: reduce.replace<number>() },
  entry: 'child',
  nodes: {
    child: subgraph({
      graph,
      parameters: (state: { readonly branch: string; readonly agentSessionId: number }) => ({
        branch: state.branch,
        agentSessionId: state.agentSessionId,
      }),
      onResult: () => ({}),
    }),
  },
  edges: { fromChild: edge({ from: 'child', to: ['done'], choose: () => ({ to: 'done' }) }) },
  outcomes: { done: outcome({ kind: 'success', output: () => undefined }) },
});
void parent;

defineWorkflow({
  command: () => ({ title: 'Test' }),
  // @ts-expect-error `parse` must return what the root graph's parameters require.
  parse: (_origin, inputs) => ({ branch: parseBranch(inputs) }),
  graph,
});

defineWorkflow({
  command: () => ({ title: 'Test' }),
  // @ts-expect-error an async `parse` is held to the same parameters type once awaited.
  parse: async () => ({ branch: 1, agentSessionId: null }),
  graph,
});

defineWorkflow({
  command: () => ({ title: 'Test' }),
  parse: (_origin, inputs) => ({ branch: parseBranch(inputs), agentSessionId: null }),
  placement: (_ctx, parameters) => ({
    worktree: { kind: 'current' },
    // @ts-expect-error `placement` receives the parsed parameters, not the raw answers.
    surface: { kind: 'create', title: parameters.title },
  }),
  graph,
});

defineWorkflow({
  command: () => ({ title: 'Test' }),
  parse: (_origin, inputs) => ({ branch: parseBranch(inputs), agentSessionId: null }),
  // @ts-expect-error A placement request must name both a worktree and a surface.
  placement: () => ({ worktree: { kind: 'current' } }),
  graph,
});

// @ts-expect-error `parse` is required.
defineWorkflow({
  command: () => ({ title: 'Test' }),
  graph: noParameters,
});
