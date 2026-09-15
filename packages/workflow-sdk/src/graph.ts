import { brand, type WorkflowBrand } from './brand.js';
import type {
  WorkflowEdgeId,
  WorkflowGraphKey,
  WorkflowNodeId,
  WorkflowOutcomeId,
} from './identifiers.js';
import type {
  WorkflowCommandManifest,
  WorkflowDestination,
  WorkflowInputs,
  WorkflowOrigin,
} from './launch.js';
import type { GraphNode } from './nodes.js';
import type { NodeEvent } from './operations.js';
import type { GraphStateFields, GraphUpdate, NoExtraUpdateKeys, ResolvedUpdates } from './state.js';

type MaybePromise<Value> = Value | Promise<Value>;

/**
 * Exactly one router per executable node. `choose` is pure, synchronous, and has no context: it
 * cannot launch agents, read files, capture evidence, or suspend, so routing stays a decision over
 * facts the node already produced.
 */
export interface GraphEdge<State, Updates> extends WorkflowBrand {
  readonly isagiKind: 'edge';
  readonly from: WorkflowNodeId;
  /** Declared destinations. Choosing anything outside this set fails the segment before any commit. */
  readonly to: readonly (WorkflowNodeId | WorkflowOutcomeId)[];
  readonly choose: (state: State, event: NodeEvent) => EdgeDecision<GraphUpdate<Updates>>;
  readonly title?: string | undefined;
}

export interface EdgeDecision<Update> {
  readonly to: WorkflowNodeId | WorkflowOutcomeId;
  readonly update?: Update | undefined;
}

export function edge<State, Updates>(spec: {
  readonly from: WorkflowNodeId;
  readonly to: readonly string[];
  readonly choose: (state: State, event: NodeEvent) => EdgeDecision<GraphUpdate<Updates>>;
  readonly title?: string | undefined;
}): GraphEdge<State, Updates> {
  return {
    ...brand('edge'),
    from: spec.from,
    to: spec.to,
    choose: spec.choose,
    title: spec.title,
  };
}

/**
 * A terminal result of this graph. `kind: 'failure'` is an *authored* domain failure carrying a
 * serializable output — a child delivers it to its parent's router as data — and is a different
 * thing from an execution segment that threw.
 */
export interface GraphOutcome<State, Output> extends WorkflowBrand {
  readonly isagiKind: 'outcome';
  readonly kind: 'success' | 'failure';
  readonly reason?: string | undefined;
  readonly title?: string | undefined;
  readonly output: (state: State) => Output;
}

export function outcome<State, Output>(spec: {
  readonly kind: 'success' | 'failure';
  readonly reason?: string | undefined;
  readonly title?: string | undefined;
  readonly output: (state: State) => Output;
}): GraphOutcome<State, Output> {
  return {
    ...brand('outcome'),
    kind: spec.kind,
    reason: spec.reason,
    title: spec.title,
    output: spec.output,
  };
}

export interface GraphDefinition<State, Resolved, Parameters, Output> extends WorkflowBrand {
  readonly isagiKind: 'graph';
  readonly key: WorkflowGraphKey;
  readonly title: string;
  readonly description?: string | undefined;
  /** Descriptive only. Nothing in validation or execution reads it, and it implies no nesting rule. */
  readonly intent?: 'business' | 'logical' | 'operational' | undefined;
  /** Optional dynamic display name, captured once at graph entry. Pure, synchronous, never identity. */
  readonly label?: ((parameters: Parameters) => string) | undefined;
  /** Synchronous and destination-scoped. It never runs again to migrate an existing frame's state. */
  readonly init: (destination: WorkflowDestination, parameters: Parameters) => State;
  readonly state: GraphStateFields<State, Resolved>;
  readonly entry: WorkflowNodeId;
  readonly nodes: Readonly<Record<WorkflowNodeId, GraphNode<State, Resolved>>>;
  readonly edges: Readonly<Record<WorkflowEdgeId, GraphEdge<State, Resolved>>>;
  readonly outcomes: Readonly<Record<WorkflowOutcomeId, GraphOutcome<State, Output>>>;
}

/**
 * Reusable graph structure. One definition can be registered by several subgraph nodes; each
 * registration becomes its own frame at run time, and the descriptor records one graph entry
 * referenced many times.
 *
 * The second type parameter is an *override map*: it names the update-value type only for fields
 * whose update differs from what they store, and every omitted field falls back to its stored type.
 * A graph with pure replacement semantics writes `createGraph<State>({ … })`.
 */
export function createGraph<
  State,
  Overrides extends Partial<Record<keyof State, unknown>> &
    NoExtraUpdateKeys<Overrides, keyof State> = {},
  Parameters = void,
  Output = void,
>(
  definition: Omit<
    GraphDefinition<State, ResolvedUpdates<State, Overrides>, Parameters, Output>,
    keyof WorkflowBrand
  >,
): GraphDefinition<State, ResolvedUpdates<State, Overrides>, Parameters, Output> {
  return { ...brand('graph'), ...definition };
}

export interface WorkflowDefinition<Inputs extends WorkflowInputs, Output> extends WorkflowBrand {
  readonly isagiKind: 'workflow';
  readonly command: (origin: WorkflowOrigin) => MaybePromise<WorkflowCommandManifest>;
  readonly validate: (origin: WorkflowOrigin, inputs: Inputs) => MaybePromise<void>;
  /** The root graph. Its parameters type *is* `Inputs`: validated launch inputs need no mapping. */
  readonly graph: GraphDefinition<any, any, Inputs, Output>;
}

export function defineWorkflow<Inputs extends WorkflowInputs, Output>(
  definition: Omit<WorkflowDefinition<Inputs, Output>, keyof WorkflowBrand>,
): WorkflowDefinition<Inputs, Output> {
  return { ...brand('workflow'), ...definition };
}
