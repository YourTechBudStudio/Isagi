import { brand, type WorkflowBrand } from './brand.js';
import type { GraphDefinition } from './graph.js';
import type { OperationContext, OperationResult, SubgraphResult } from './operations.js';
import type { GraphUpdate } from './state.js';

/**
 * The three executable node kinds. `any` appears only in the child parameter and output positions,
 * so one `nodes` record can hold subgraphs invoking differently typed graphs; the author-facing
 * check still happens where the node is registered, against this graph's own state and updates.
 */
export type GraphNode<State, Updates> =
  | OperationNode<State, Updates>
  | SubgraphNode<State, Updates, any, any>
  | CheckpointNode;

export interface OperationNode<State, Updates> extends WorkflowBrand {
  readonly isagiKind: 'operation-node';
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  /** Optional dynamic display name, captured once when this visit's execution row is created. */
  readonly label?: ((state: State) => string) | undefined;
  readonly run: (
    ctx: OperationContext,
    state: State,
  ) => Promise<OperationResult<GraphUpdate<Updates>>>;
}

export function operation<State, Updates>(
  run: (ctx: OperationContext, state: State) => Promise<OperationResult<GraphUpdate<Updates>>>,
  options?: {
    readonly title?: string | undefined;
    readonly description?: string | undefined;
    readonly label?: ((state: State) => string) | undefined;
  },
): OperationNode<State, Updates> {
  return {
    ...brand('operation-node'),
    title: options?.title,
    description: options?.description,
    label: options?.label,
    run,
  };
}

export interface SubgraphNode<
  ParentState,
  ParentUpdates,
  ChildParameters,
  ChildOutput,
> extends WorkflowBrand {
  readonly isagiKind: 'subgraph-node';
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly label?: ((state: ParentState) => string) | undefined;
  readonly graph: GraphDefinition<any, any, ChildParameters, ChildOutput>;
  /** Pure and synchronous: it runs inside the transaction that opens the child frame. */
  readonly parameters: (parent: ParentState) => ChildParameters;
  /** Pure and synchronous: it maps the child's published output back through this graph's reducers. */
  readonly onResult: (
    parent: ParentState,
    result: SubgraphResult<ChildOutput>,
  ) => GraphUpdate<ParentUpdates>;
}

export function subgraph<ParentState, ParentUpdates, ChildParameters, ChildOutput>(spec: {
  readonly graph: GraphDefinition<any, any, ChildParameters, ChildOutput>;
  readonly parameters: (parent: ParentState) => ChildParameters;
  readonly onResult: (
    parent: ParentState,
    result: SubgraphResult<ChildOutput>,
  ) => GraphUpdate<ParentUpdates>;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly label?: ((state: ParentState) => string) | undefined;
}): SubgraphNode<ParentState, ParentUpdates, ChildParameters, ChildOutput> {
  return {
    ...brand('subgraph-node'),
    title: spec.title,
    description: spec.description,
    label: spec.label,
    graph: spec.graph,
    parameters: spec.parameters,
    onResult: spec.onResult,
  };
}

/**
 * Reserved node kind. Checkpoint capture ships in a later story; this release recognizes the
 * discriminant structurally so the extension seam is real, and refuses to launch a bundle that
 * contains one.
 *
 * `caption` is deliberately not named `label`: it is a static string, not a dynamic display-name
 * callback evaluated at record creation.
 */
export interface CheckpointNode extends WorkflowBrand {
  readonly isagiKind: 'checkpoint-node';
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly caption: string;
}

export function checkpoint(spec: {
  readonly caption: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
}): CheckpointNode {
  return {
    ...brand('checkpoint-node'),
    title: spec.title,
    description: spec.description,
    caption: spec.caption,
  };
}
