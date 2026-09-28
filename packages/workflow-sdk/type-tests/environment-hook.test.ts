import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
} from '../src/index.js';
import type { WorkflowEnvironmentContext, WorkflowPlacementRequest } from '../src/index.js';

/**
 * `environment` mentions `Inputs` in a contravariant position, exactly as `validate` already does.
 * These cases prove the second inference site neither widens `Inputs` nor breaks inference for a
 * definition that declares both, and that the hook's parameters are inferred rather than implicit.
 */

interface Inputs {
  readonly branch: string;
  readonly [key: string]: unknown;
}

const graph = createGraph<{ readonly note: string }, {}, Inputs, string>({
  key: 'Root',
  title: 'Root',
  init: (_destination, parameters) => ({ note: parameters.branch }),
  state: { note: reduce.replace<string>() },
  entry: 'act',
  nodes: { act: operation(async () => complete({ update: { note: 'done' } })) },
  edges: { fromAct: edge({ from: 'act', to: ['done'], choose: () => ({ to: 'done' }) }) },
  outcomes: { done: outcome({ kind: 'success', output: (state) => state.note }) },
});

function acceptBranch(branch: string): void {
  void branch;
}

function acceptProjectKind(kind: 'git' | 'folder'): void {
  void kind;
}

// Both callbacks infer the same `Inputs`, and `ctx` is the environment context, not `any`.
const inferred = defineWorkflow({
  command: () => ({ title: 'Test' }),
  validate: (_origin, inputs: Inputs) => {
    acceptBranch(inputs.branch);
  },
  environment: (ctx, inputs) => {
    acceptBranch(inputs.branch);
    acceptProjectKind(ctx.project.kind);
    return {
      worktree: { kind: 'create', branch: inputs.branch, fromRef: 'main' },
      surface: { kind: 'create', title: inputs.branch },
    };
  },
  graph,
});

function acceptHook(
  hook: (
    ctx: WorkflowEnvironmentContext,
    inputs: Inputs,
  ) => WorkflowPlacementRequest | Promise<WorkflowPlacementRequest>,
): void {
  void hook;
}

// The declared hook keeps its inferred `Inputs`, rather than collapsing to the index signature.
// Passed without a cast on purpose: a cast here would still compile if the inferred parameter
// types regressed, which is the whole risk this file exists to catch.
if (inferred.environment !== undefined) acceptHook(inferred.environment);

// The hook stays optional: a definition without it is still a complete workflow, and reading the
// member is legal because its type includes `undefined`.
const withoutHook = defineWorkflow({
  command: () => ({ title: 'Test' }),
  validate: (_origin, _inputs: Inputs) => {},
  graph,
});
const absent: typeof withoutHook.environment = undefined;
void absent;

// An async hook is accepted, and the context's list calls return the summary shapes.
const asyncHook = defineWorkflow({
  command: () => ({ title: 'Test' }),
  validate: (_origin, _inputs: Inputs) => {},
  environment: async (ctx): Promise<WorkflowPlacementRequest> => {
    const worktrees = await ctx.listWorktrees();
    const surfaces = await ctx.listSurfaces({ worktreeId: ctx.origin.worktreeId });
    const target = worktrees.find((worktree) => !worktree.isRoot);
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
void asyncHook;

const incomplete = defineWorkflow({
  command: () => ({ title: 'Test' }),
  validate: (_origin, _inputs: Inputs) => {},
  // @ts-expect-error A placement request must name both a worktree and a surface.
  environment: () => ({ worktree: { kind: 'current' } }),
  graph,
});
void incomplete;
