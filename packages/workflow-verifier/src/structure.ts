import { createHash } from 'node:crypto';

/**
 * The single structural inspection algorithm, shared by the verifier CLI, the runtime loader, and
 * tests. It is pure: it never calls `init`, `run`, `choose`, `parameters`, `onResult`, `output`, or
 * `label`. It only reads plain data off an already-imported module object.
 *
 * Importing a bundle still executes trusted module-level JavaScript. This is a structural contract
 * check, not sandboxed static analysis of untrusted source.
 */

export const workflowStructureDescriptorVersion = 1 as const;

/**
 * The contract version this release understands. `compatibility.test.ts` binds it to the SDK's
 * `workflowContractVersion`.
 *
 * Recognition is reimplemented here rather than imported from the SDK on purpose: a workflow bundle
 * embeds its own SDK copy, so recognition may only read plain data anyway, and keeping the check
 * local leaves the packed verifier — which authors may install as a standalone CLI — free of a
 * runtime SDK resolution.
 */
const recognizedContractVersion = 3;

const limits = {
  graphs: 512,
  nodesPerGraph: 256,
  edgesPerGraph: 256,
  outcomesPerGraph: 64,
  containmentDepth: 64,
} as const;

export interface WorkflowStructureDescriptor {
  readonly descriptorVersion: typeof workflowStructureDescriptorVersion;
  readonly workflowContractVersion: 3;
  readonly rootGraphKey: string;
  /** Sorted by key, so one structure always canonicalizes to the same bytes. */
  readonly graphs: readonly GraphDescriptor[];
}

export interface GraphDescriptor {
  readonly key: string;
  readonly title: string;
  readonly description?: string;
  readonly intent?: 'business' | 'logical' | 'operational';
  readonly stateFields: readonly string[];
  readonly entry: string;
  readonly nodes: readonly NodeDescriptor[];
  readonly edges: readonly EdgeDescriptor[];
  readonly outcomes: readonly OutcomeDescriptor[];
}

export type NodeDescriptor =
  | {
      readonly id: string;
      readonly kind: 'operation';
      readonly title?: string;
      readonly description?: string;
    }
  | {
      readonly id: string;
      readonly kind: 'subgraph';
      readonly graphKey: string;
      readonly title?: string;
      readonly description?: string;
    }
  | {
      readonly id: string;
      readonly kind: 'checkpoint';
      readonly title?: string;
      readonly description?: string;
    };

export interface EdgeDescriptor {
  readonly id: string;
  readonly from: string;
  /** The author's declared order, which is descriptive only. Duplicates are a diagnostic. */
  readonly to: readonly string[];
  readonly title?: string;
}

export interface OutcomeDescriptor {
  readonly id: string;
  readonly kind: 'success' | 'failure';
  readonly reason?: string;
  readonly title?: string;
}

export type StructureDiagnosticCode =
  | 'invalid_export'
  | 'unsupported_contract'
  | 'missing_callback'
  | 'invalid_identifier'
  | 'missing_title'
  | 'invalid_intent'
  | 'missing_init'
  | 'invalid_state_field'
  | 'empty_state'
  | 'empty_graph'
  | 'identifier_collision'
  | 'unknown_node_kind'
  | 'subgraph_missing_graph'
  | 'missing_entry'
  | 'entry_not_executable'
  | 'edge_source_unknown'
  | 'duplicate_edge_source'
  | 'missing_outgoing_edge'
  | 'empty_destination_set'
  | 'duplicate_destination'
  | 'edge_destination_unknown'
  | 'no_outcomes'
  | 'invalid_label'
  | 'duplicate_graph_key'
  | 'recursive_graph_containment'
  | 'too_many_graphs'
  | 'too_many_nodes'
  | 'too_many_edges'
  | 'too_many_outcomes'
  | 'containment_too_deep'
  | 'deferred_executable_dependency'
  // Saved-position validation (§6.4): a pinned structure that no longer fits the position a
  // run is parked at. Reported through the same diagnostic shape, so they share the set.
  | 'graph_missing'
  | 'subgraph_registration_changed'
  | 'node_missing'
  | 'node_kind_changed'
  | 'edge_identity_changed'
  | 'destination_no_longer_declared'
  | 'outcome_missing'
  | 'outcome_kind_changed';

export interface StructureDiagnosticLocation {
  readonly graphKey?: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly outcomeId?: string;
  readonly field?: string;
}

export interface StructureDiagnostic {
  readonly code: StructureDiagnosticCode;
  readonly message: string;
  readonly at: StructureDiagnosticLocation;
}

export type StructureResult =
  | { readonly ok: true; readonly descriptor: WorkflowStructureDescriptor }
  | { readonly ok: false; readonly diagnostics: readonly StructureDiagnostic[] };

const identifierPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

type Unknown = Record<string, unknown>;

function isObject(value: unknown): value is Unknown {
  return typeof value === 'object' && value !== null;
}

function isBranded(value: unknown, kind: string): value is Unknown {
  return (
    isObject(value) && value.isagiContract === recognizedContractVersion && value.isagiKind === kind
  );
}

function contractVersionOf(value: unknown): number | null {
  if (!isObject(value)) return null;
  return typeof value.isagiContract === 'number' ? value.isagiContract : null;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return typeof value;
}

/** Collects diagnostics rather than throwing, so one pass reports every structural problem. */
class Diagnostics {
  readonly entries: StructureDiagnostic[] = [];

  add(code: StructureDiagnosticCode, message: string, at: StructureDiagnosticLocation = {}): void {
    this.entries.push({ code, message, at });
  }
}

export function describeWorkflowModule(moduleNamespace: unknown): StructureResult {
  const diagnostics = new Diagnostics();
  const namespace = isObject(moduleNamespace) ? moduleNamespace : undefined;
  const workflow = namespace?.default;

  if (!isBranded(workflow, 'workflow')) {
    const contract = contractVersionOf(workflow);
    if (contract !== null && contract !== recognizedContractVersion) {
      diagnostics.add(
        'unsupported_contract',
        `The bundle was built against workflow contract version ${contract}; this release supports version ${recognizedContractVersion}. Rebuild the workflow against the current SDK.`,
      );
    } else {
      diagnostics.add(
        'invalid_export',
        `The bundle must default-export the object returned by defineWorkflow(); its default export is ${describeValue(workflow)}.`,
      );
    }
    return { ok: false, diagnostics: diagnostics.entries };
  }

  if (typeof workflow.command !== 'function') {
    diagnostics.add('missing_callback', 'The workflow definition needs a command() function.', {
      field: 'command',
    });
  }
  if (typeof workflow.validate !== 'function') {
    diagnostics.add('missing_callback', 'The workflow definition needs a validate() function.', {
      field: 'validate',
    });
  }
  // Declared but malformed, not absent: `environment` is optional, so only a present non-function
  // is a defect. A workflow that omits it is placed in the current worktree and surface.
  if (workflow.environment !== undefined && typeof workflow.environment !== 'function') {
    diagnostics.add(
      'missing_callback',
      "The workflow definition's environment must be a function when present.",
      { field: 'environment' },
    );
  }

  const rootGraph = workflow.graph;
  if (!isBranded(rootGraph, 'graph')) {
    diagnostics.add(
      'invalid_export',
      `The workflow definition's graph must be the object returned by createGraph(); it is ${describeValue(rootGraph)}.`,
      { field: 'graph' },
    );
    return { ok: false, diagnostics: diagnostics.entries };
  }

  const collected = collectStructure(rootGraph, diagnostics);
  // Every collected object is validated, including one whose key is unusable. Collecting by
  // identity is what makes that possible: keying the collection by the declared key let a graph
  // with a malformed key disappear from inspection and the bundle pass as valid.
  for (const graph of collected.graphs) validateGraph(graph, diagnostics);

  // Depth is measured from the recorded adjacency rather than during traversal, so the verdict
  // cannot depend on which branch reached a shared graph first. It is meaningless over a cyclic
  // relation, and dishonest over a collection a resource limit truncated.
  if (!collected.hasCycle && !collected.truncated) {
    validateContainmentDepth(rootGraph, collected, diagnostics);
  }

  if (diagnostics.entries.length > 0) return { ok: false, diagnostics: diagnostics.entries };

  // Reached only with no diagnostics, so every key here has been validated as an identifier and no
  // partial or truncated structure can escape as a successful descriptor.
  const descriptor: WorkflowStructureDescriptor = {
    descriptorVersion: workflowStructureDescriptorVersion,
    workflowContractVersion: recognizedContractVersion,
    rootGraphKey: String(rootGraph.key),
    graphs: collected.graphs
      .map((graph) => describeGraph(graph))
      .sort((left, right) => compare(left.key, right.key)),
  };
  return { ok: true, descriptor };
}

/**
 * What one pass over the containment graph produces.
 *
 * Graphs are collected by **object identity**, never by their declared key: a graph whose key is
 * malformed must still be validated, and keying the collection by author-supplied data is what
 * previously let such a graph vanish from inspection and pass as valid.
 */
interface CollectedStructure {
  /** Every distinct graph object reachable from the root, in first-visit order. */
  readonly graphs: readonly Unknown[];
  /** Child graphs per graph object, collected once and reused for depth analysis. */
  readonly adjacency: ReadonlyMap<Unknown, readonly Unknown[]>;
  /** A graph contains itself, so the containment relation is not a DAG. */
  readonly hasCycle: boolean;
  /** A resource limit stopped inspection, so the collection is deliberately incomplete. */
  readonly truncated: boolean;
}

/**
 * Walks the containment relation once, depth-first.
 *
 * Depth-first is the simpler shape here rather than a necessary one — a breadth-first walk can
 * carry ancestor paths too. What it gives us is the current path as a stack, so a graph that
 * contains itself is reported instead of walked forever.
 *
 * It deliberately does **not** validate nesting depth. A graph reached first through a shallow
 * branch is not re-walked when a deeper branch reaches it, so a depth check made during traversal
 * would depend on which branch happened to be visited first. Depth is computed afterwards from the
 * adjacency this pass records.
 *
 * Per-graph registration limits are enforced here, before their collections are traversed, so one
 * graph declaring an enormous number of nodes cannot evade the bound by sitting under the
 * graph-count cap. This bounds the inspection work; it is not a memory guarantee about JavaScript
 * property enumeration, and it is not sandboxing — importing the bundle already ran author code.
 */
function collectStructure(rootGraph: Unknown, diagnostics: Diagnostics): CollectedStructure {
  const graphs: Unknown[] = [];
  const adjacency = new Map<Unknown, readonly Unknown[]>();
  const byKey = new Map<string, Unknown>();
  const visited = new Set<Unknown>();
  const path: Unknown[] = [];
  let hasCycle = false;
  let truncated = false;

  const descend = (graph: Unknown): void => {
    if (truncated) return;
    if (path.includes(graph)) {
      hasCycle = true;
      diagnostics.add(
        'recursive_graph_containment',
        `Graph "${labelOf(graph)}" contains itself through ${path.map(labelOf).join(' → ')}. A graph may be reused, but it cannot be nested inside itself.`,
        locate(keyOf(graph)),
      );
      return;
    }

    const key = keyOf(graph);
    if (key !== undefined) {
      const existing = byKey.get(key);
      if (existing !== undefined && existing !== graph) {
        diagnostics.add(
          'duplicate_graph_key',
          `Two different graphs both declare the key "${key}". Graph keys are unique across the whole composed structure.`,
          { graphKey: key },
        );
      } else if (existing === undefined) {
        byKey.set(key, graph);
      }
    }

    if (visited.has(graph)) return;
    if (visited.size >= limits.graphs) {
      truncated = true;
      diagnostics.add(
        'too_many_graphs',
        `The composed structure contains more than ${limits.graphs} graphs. Further graph discovery stopped at this limit; reported diagnostics may be incomplete.`,
      );
      return;
    }
    visited.add(graph);
    graphs.push(graph);

    const children = childGraphsOf(graph, diagnostics);
    adjacency.set(graph, children);

    path.push(graph);
    for (const child of children) descend(child);
    path.pop();
  };

  descend(rootGraph);
  return { graphs, adjacency, hasCycle, truncated };
}

/**
 * The child graphs one graph registers, with its registration collections bounded first.
 *
 * Shape is checked before anything is counted, and an over-limit collection is rejected without
 * being sorted or traversed — inspecting it is exactly the work the limit exists to avoid. The
 * limit diagnostics are emitted here and only here; per-graph validation does not repeat them.
 */
function childGraphsOf(graph: Unknown, diagnostics: Diagnostics): readonly Unknown[] {
  const at = (extra: StructureDiagnosticLocation = {}) => ({ ...locate(keyOf(graph)), ...extra });

  // Edges are bounded separately from nodes. For a *valid* graph the one-router-per-node rule makes
  // this limit redundant, but the extractor's input is unvalidated registrations: an oversized edge
  // collection attached to a handful of nodes still has to be rejected without being inspected.
  if (overLimit(graph.edges, limits.edgesPerGraph)) {
    diagnostics.add(
      'too_many_edges',
      `A graph may declare at most ${limits.edgesPerGraph} edges.`,
      at({ field: 'edges' }),
    );
  }
  if (overLimit(graph.outcomes, limits.outcomesPerGraph)) {
    diagnostics.add(
      'too_many_outcomes',
      `A graph may declare at most ${limits.outcomesPerGraph} outcomes.`,
      at({ field: 'outcomes' }),
    );
  }
  if (overLimit(graph.nodes, limits.nodesPerGraph)) {
    diagnostics.add(
      'too_many_nodes',
      `A graph may declare at most ${limits.nodesPerGraph} nodes.`,
      at({ field: 'nodes' }),
    );
    return [];
  }

  const nodes = isObject(graph.nodes) && !Array.isArray(graph.nodes) ? graph.nodes : {};
  const children: Unknown[] = [];
  for (const nodeId of Object.keys(nodes).sort(compare)) {
    const node = nodes[nodeId];
    if (!isBranded(node, 'subgraph-node')) continue;
    const child = node.graph;
    if (isBranded(child, 'graph')) children.push(child);
  }
  return children;
}

/** True when a registration collection is a usable object that declares more entries than allowed. */
function overLimit(collection: unknown, allowed: number): boolean {
  if (!isObject(collection) || Array.isArray(collection)) return false;
  return Object.keys(collection).length > allowed;
}

/**
 * The longest containment chain, counted in graphs and **including the root**: a root with no
 * subgraphs is depth 1, and a root plus 63 nested graphs is depth 64, the deepest accepted.
 *
 * Computed by memoized traversal of the adjacency already collected, so a heavily reused graph is
 * measured once rather than once per path through it. This part of the analysis is linear in graphs
 * and registrations; the extractor as a whole also sorts its collections when emitting a descriptor.
 * Only called when the relation is acyclic and inspection was not truncated.
 */
function validateContainmentDepth(
  root: Unknown,
  collected: CollectedStructure,
  diagnostics: Diagnostics,
): void {
  const depths = new Map<Unknown, number>();

  const depthOf = (graph: Unknown): number => {
    const memo = depths.get(graph);
    if (memo !== undefined) return memo;
    let deepestChild = 0;
    for (const child of collected.adjacency.get(graph) ?? []) {
      deepestChild = Math.max(deepestChild, depthOf(child));
    }
    const depth = deepestChild + 1;
    depths.set(graph, depth);
    return depth;
  };

  if (depthOf(root) <= limits.containmentDepth) return;

  // Name the chain, so the author can see which nesting actually exceeded the limit.
  const chain: string[] = [];
  let current: Unknown | undefined = root;
  while (current) {
    chain.push(labelOf(current));
    const children: readonly Unknown[] = collected.adjacency.get(current) ?? [];
    current = children.reduce<Unknown | undefined>(
      (deepest, child) =>
        deepest === undefined || depthOf(child) > depthOf(deepest) ? child : deepest,
      undefined,
    );
  }
  diagnostics.add(
    'containment_too_deep',
    `Graph containment is nested ${depthOf(root)} graphs deep, and at most ${limits.containmentDepth} are allowed: ${chain.join(' → ')}.`,
    locate(keyOf(root)),
  );
}

function locate(graphKey: string | undefined): StructureDiagnosticLocation {
  return graphKey === undefined ? {} : { graphKey };
}

function keyOf(graph: Unknown): string | undefined {
  return typeof graph.key === 'string' ? graph.key : undefined;
}

function labelOf(graph: Unknown): string {
  return keyOf(graph) ?? '<graph with no key>';
}

function validateGraph(graph: Unknown, diagnostics: Diagnostics): void {
  const graphKey = keyOf(graph);
  const at = (extra: StructureDiagnosticLocation = {}): StructureDiagnosticLocation =>
    graphKey === undefined ? extra : { graphKey, ...extra };

  if (graphKey === undefined || !identifierPattern.test(graphKey)) {
    diagnostics.add(
      'invalid_identifier',
      `Graph key ${JSON.stringify(graph.key)} must start with a letter and use only letters, digits, "_", or "-" (max 64 characters).`,
      at({ field: 'key' }),
    );
  }
  if (typeof graph.title !== 'string' || graph.title.length === 0) {
    diagnostics.add(
      'missing_title',
      'A graph needs a non-empty title; it is what a person reads in the inspector.',
      at({ field: 'title' }),
    );
  }
  if (
    graph.intent !== undefined &&
    graph.intent !== 'business' &&
    graph.intent !== 'logical' &&
    graph.intent !== 'operational'
  ) {
    diagnostics.add(
      'invalid_intent',
      `Graph intent ${JSON.stringify(graph.intent)} must be "business", "logical", or "operational" when present.`,
      at({ field: 'intent' }),
    );
  }
  if (typeof graph.init !== 'function') {
    diagnostics.add('missing_init', 'A graph needs an init() function.', at({ field: 'init' }));
  }
  if (graph.label !== undefined && typeof graph.label !== 'function') {
    diagnostics.add(
      'invalid_label',
      'A graph label must be a function when present. Its result is evaluated at entry, not here.',
      at({ field: 'label' }),
    );
  }

  // A graph that declares more registrations than the limit allows has already been rejected with
  // the reason. Walking those collections anyway is the work the limit exists to avoid, and it
  // would only add noise to a verdict that is already settled.
  if (
    overLimit(graph.nodes, limits.nodesPerGraph) ||
    overLimit(graph.edges, limits.edgesPerGraph) ||
    overLimit(graph.outcomes, limits.outcomesPerGraph)
  ) {
    return;
  }

  const stateFields = validateState(graph, diagnostics, at);
  const nodeIds = validateNodes(graph, diagnostics, at);
  const outcomeIds = validateOutcomes(graph, diagnostics, at);

  for (const collision of nodeIds.filter((id) => outcomeIds.includes(id))) {
    diagnostics.add(
      'identifier_collision',
      `"${collision}" names both a node and an outcome. They share one namespace so an edge destination is unambiguous.`,
      at({ nodeId: collision }),
    );
  }

  validateEntry(graph, nodeIds, outcomeIds, diagnostics, at);
  validateEdges(graph, nodeIds, outcomeIds, diagnostics, at);
  void stateFields;
}

type LocationFactory = (extra?: StructureDiagnosticLocation) => StructureDiagnosticLocation;

function validateState(
  graph: Unknown,
  diagnostics: Diagnostics,
  at: LocationFactory,
): readonly string[] {
  if (!isObject(graph.state) || Array.isArray(graph.state)) {
    diagnostics.add(
      'invalid_state_field',
      `A graph's state must be an object of field registrations; it is ${describeValue(graph.state)}.`,
      at({ field: 'state' }),
    );
    return [];
  }
  const names = Object.keys(graph.state);
  if (names.length === 0) {
    diagnostics.add(
      'empty_state',
      'A graph needs at least one state field; state is how a graph carries anything between nodes.',
      at({ field: 'state' }),
    );
  }
  for (const name of names) {
    const registration = graph.state[name];
    if (!isBranded(registration, 'state-field') || typeof registration.reduce !== 'function') {
      diagnostics.add(
        'invalid_state_field',
        `State field "${name}" must be built with field() or one of the reduce.* helpers.`,
        at({ field: name }),
      );
    }
  }
  return names;
}

function validateNodes(
  graph: Unknown,
  diagnostics: Diagnostics,
  at: LocationFactory,
): readonly string[] {
  if (!isObject(graph.nodes) || Array.isArray(graph.nodes)) {
    diagnostics.add(
      'empty_graph',
      `A graph's nodes must be an object; it is ${describeValue(graph.nodes)}.`,
      at({ field: 'nodes' }),
    );
    return [];
  }
  const ids = Object.keys(graph.nodes);
  if (ids.length === 0) {
    diagnostics.add('empty_graph', 'A graph needs at least one node.', at({ field: 'nodes' }));
  }
  for (const id of ids) {
    if (!identifierPattern.test(id)) {
      diagnostics.add(
        'invalid_identifier',
        `Node id "${id}" must start with a letter and use only letters, digits, "_", or "-" (max 64 characters).`,
        at({ nodeId: id }),
      );
    }
    validateNode(graph.nodes[id], id, diagnostics, at);
  }
  return ids;
}

function validateNode(
  node: unknown,
  id: string,
  diagnostics: Diagnostics,
  at: LocationFactory,
): void {
  if (isBranded(node, 'operation-node')) {
    if (typeof node.run !== 'function') {
      diagnostics.add(
        'missing_callback',
        `Operation node "${id}" needs a run() function.`,
        at({ nodeId: id }),
      );
    }
    requireOptionalLabel(node, id, diagnostics, at);
    return;
  }
  if (isBranded(node, 'subgraph-node')) {
    if (typeof node.parameters !== 'function') {
      diagnostics.add(
        'missing_callback',
        `Subgraph node "${id}" needs a parameters() function.`,
        at({ nodeId: id }),
      );
    }
    if (typeof node.onResult !== 'function') {
      diagnostics.add(
        'missing_callback',
        `Subgraph node "${id}" needs an onResult() function.`,
        at({ nodeId: id }),
      );
    }
    if (!isBranded(node.graph, 'graph')) {
      diagnostics.add(
        'subgraph_missing_graph',
        `Subgraph node "${id}" must invoke a graph built with createGraph(); it references ${describeValue(node.graph)}.`,
        at({ nodeId: id }),
      );
    }
    requireOptionalLabel(node, id, diagnostics, at);
    return;
  }
  if (isBranded(node, 'checkpoint-node')) {
    // A checkpoint has no `label`: its instance title comes from what `prepare` returns at run
    // time, so the label rule does not reach it. `prepare` is only checked to be a function; the
    // verifier never calls it, because what a visit captures depends on state it does not have.
    if (typeof node.prepare !== 'function') {
      diagnostics.add(
        'missing_callback',
        `Checkpoint node "${id}" needs a prepare() function.`,
        at({ nodeId: id }),
      );
    }
    return;
  }
  diagnostics.add(
    'unknown_node_kind',
    `Node "${id}" is not an operation(), subgraph(), or checkpoint() registration.`,
    at({ nodeId: id }),
  );
}

function requireOptionalLabel(
  node: Unknown,
  id: string,
  diagnostics: Diagnostics,
  at: LocationFactory,
): void {
  if (node.label !== undefined && typeof node.label !== 'function') {
    diagnostics.add(
      'invalid_label',
      `Node "${id}" declares a label that is not a function. Its result is captured at run time, not here.`,
      at({ nodeId: id }),
    );
  }
}

function validateOutcomes(
  graph: Unknown,
  diagnostics: Diagnostics,
  at: LocationFactory,
): readonly string[] {
  if (!isObject(graph.outcomes) || Array.isArray(graph.outcomes)) {
    diagnostics.add(
      'no_outcomes',
      `A graph's outcomes must be an object; it is ${describeValue(graph.outcomes)}.`,
      at({ field: 'outcomes' }),
    );
    return [];
  }
  const ids = Object.keys(graph.outcomes);
  if (ids.length === 0) {
    diagnostics.add(
      'no_outcomes',
      'A graph needs at least one outcome, or nothing it routes to can end it.',
      at({ field: 'outcomes' }),
    );
  }
  for (const id of ids) {
    if (!identifierPattern.test(id)) {
      diagnostics.add(
        'invalid_identifier',
        `Outcome id "${id}" must start with a letter and use only letters, digits, "_", or "-" (max 64 characters).`,
        at({ outcomeId: id }),
      );
    }
    const registration = graph.outcomes[id];
    if (!isBranded(registration, 'outcome')) {
      diagnostics.add(
        'missing_callback',
        `Outcome "${id}" must be built with outcome().`,
        at({ outcomeId: id }),
      );
      continue;
    }
    if (typeof registration.output !== 'function') {
      diagnostics.add(
        'missing_callback',
        `Outcome "${id}" needs an output() function.`,
        at({ outcomeId: id }),
      );
    }
    if (registration.kind !== 'success' && registration.kind !== 'failure') {
      diagnostics.add(
        'missing_callback',
        `Outcome "${id}" must declare kind "success" or "failure"; it declares ${JSON.stringify(registration.kind)}.`,
        at({ outcomeId: id }),
      );
    }
  }
  return ids;
}

function validateEntry(
  graph: Unknown,
  nodeIds: readonly string[],
  outcomeIds: readonly string[],
  diagnostics: Diagnostics,
  at: LocationFactory,
): void {
  const entry = graph.entry;
  if (typeof entry !== 'string' || !nodeIds.includes(entry)) {
    if (typeof entry === 'string' && outcomeIds.includes(entry)) {
      diagnostics.add(
        'entry_not_executable',
        `The entry "${entry}" names an outcome. A graph must enter at a node.`,
        at({ field: 'entry' }),
      );
      return;
    }
    diagnostics.add(
      'missing_entry',
      `The entry ${JSON.stringify(entry)} is not a registered node id.`,
      at({ field: 'entry' }),
    );
  }
}

function validateEdges(
  graph: Unknown,
  nodeIds: readonly string[],
  outcomeIds: readonly string[],
  diagnostics: Diagnostics,
  at: LocationFactory,
): void {
  if (!isObject(graph.edges) || Array.isArray(graph.edges)) {
    diagnostics.add(
      'missing_outgoing_edge',
      `A graph's edges must be an object; it is ${describeValue(graph.edges)}.`,
      at({ field: 'edges' }),
    );
    return;
  }
  const edgeIds = Object.keys(graph.edges);

  const sources = new Map<string, string[]>();
  for (const edgeId of edgeIds) {
    if (!identifierPattern.test(edgeId)) {
      diagnostics.add(
        'invalid_identifier',
        `Edge id "${edgeId}" must start with a letter and use only letters, digits, "_", or "-" (max 64 characters).`,
        at({ edgeId }),
      );
    }
    const registration = graph.edges[edgeId];
    if (!isBranded(registration, 'edge')) {
      diagnostics.add(
        'missing_callback',
        `Edge "${edgeId}" must be built with edge().`,
        at({ edgeId }),
      );
      continue;
    }
    if (typeof registration.choose !== 'function') {
      diagnostics.add(
        'missing_callback',
        `Edge "${edgeId}" needs a choose() function.`,
        at({ edgeId }),
      );
    }

    const from = registration.from;
    if (typeof from !== 'string' || !nodeIds.includes(from)) {
      diagnostics.add(
        'edge_source_unknown',
        `Edge "${edgeId}" routes from ${JSON.stringify(from)}, which is not a registered node.`,
        at({ edgeId }),
      );
    } else {
      const existing = sources.get(from);
      if (existing) existing.push(edgeId);
      else sources.set(from, [edgeId]);
    }

    validateDestinations(registration, edgeId, nodeIds, outcomeIds, diagnostics, at);
  }

  for (const [from, owners] of sources) {
    if (owners.length > 1) {
      diagnostics.add(
        'duplicate_edge_source',
        `Node "${from}" has ${owners.length} routers (${owners.join(', ')}). Exactly one edge may route from a node.`,
        at({ nodeId: from }),
      );
    }
  }
  for (const nodeId of nodeIds) {
    if (!sources.has(nodeId)) {
      diagnostics.add(
        'missing_outgoing_edge',
        `Node "${nodeId}" has no router. Every node needs exactly one edge whose "from" is that node.`,
        at({ nodeId }),
      );
    }
  }
}

function validateDestinations(
  registration: Unknown,
  edgeId: string,
  nodeIds: readonly string[],
  outcomeIds: readonly string[],
  diagnostics: Diagnostics,
  at: LocationFactory,
): void {
  const to = registration.to;
  if (!Array.isArray(to) || to.length === 0) {
    diagnostics.add(
      'empty_destination_set',
      `Edge "${edgeId}" declares no destinations. A router must declare every destination it may choose.`,
      at({ edgeId }),
    );
    return;
  }
  const seen = new Set<string>();
  for (const destination of to) {
    if (typeof destination !== 'string') {
      diagnostics.add(
        'edge_destination_unknown',
        `Edge "${edgeId}" declares a destination that is ${describeValue(destination)} rather than a node or outcome id.`,
        at({ edgeId }),
      );
      continue;
    }
    if (seen.has(destination)) {
      diagnostics.add(
        'duplicate_destination',
        `Edge "${edgeId}" declares "${destination}" more than once.`,
        at({ edgeId }),
      );
      continue;
    }
    seen.add(destination);
    if (!nodeIds.includes(destination) && !outcomeIds.includes(destination)) {
      diagnostics.add(
        'edge_destination_unknown',
        `Edge "${edgeId}" declares the destination "${destination}", which is neither a node nor an outcome in this graph.`,
        at({ edgeId }),
      );
    }
  }
}

function describeGraph(graph: Unknown): GraphDescriptor {
  const nodes = isObject(graph.nodes) ? graph.nodes : {};
  const edges = isObject(graph.edges) ? graph.edges : {};
  const outcomes = isObject(graph.outcomes) ? graph.outcomes : {};
  const state = isObject(graph.state) ? graph.state : {};

  return {
    key: String(graph.key),
    title: String(graph.title),
    ...optional('description', graph.description),
    ...describeIntent(graph.intent),
    stateFields: Object.keys(state).sort(compare),
    entry: String(graph.entry),
    nodes: Object.keys(nodes)
      .sort(compare)
      .map((id) => describeNode(id, nodes[id] as Unknown)),
    edges: Object.keys(edges)
      .sort(compare)
      .map((id) => describeEdge(id, edges[id] as Unknown)),
    outcomes: Object.keys(outcomes)
      .sort(compare)
      .map((id) => describeOutcome(id, outcomes[id] as Unknown)),
  };
}

function describeIntent(
  value: unknown,
): { readonly intent: 'business' | 'logical' | 'operational' } | {} {
  return value === 'business' || value === 'logical' || value === 'operational'
    ? { intent: value }
    : {};
}

function describeNode(id: string, node: Unknown): NodeDescriptor {
  const shared = {
    id,
    ...optional('title', node.title),
    ...optional('description', node.description),
  };
  if (node.isagiKind === 'subgraph-node') {
    return { ...shared, kind: 'subgraph', graphKey: String((node.graph as Unknown).key) };
  }
  if (node.isagiKind === 'checkpoint-node') {
    return { ...shared, kind: 'checkpoint' };
  }
  return { ...shared, kind: 'operation' };
}

function describeEdge(id: string, edge: Unknown): EdgeDescriptor {
  const declared = Array.isArray(edge.to) ? (edge.to as readonly unknown[]) : [];
  const to: string[] = [];
  for (const destination of declared) {
    const value = String(destination);
    if (!to.includes(value)) to.push(value);
  }
  return { id, from: String(edge.from), to, ...optional('title', edge.title) };
}

function describeOutcome(id: string, outcome: Unknown): OutcomeDescriptor {
  return {
    id,
    kind: outcome.kind === 'failure' ? 'failure' : 'success',
    ...optional('reason', outcome.reason),
    ...optional('title', outcome.title),
  };
}

function optional<Key extends string>(key: Key, value: unknown): Record<Key, string> | {} {
  return typeof value === 'string' ? ({ [key]: value } as Record<Key, string>) : {};
}

/** Byte-stable ordering that does not depend on the host's locale. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Writes the descriptor with a fixed key order, already-sorted arrays, and absent optional keys
 * omitted, so the verifier and the runtime loader hash identical bytes for identical structure.
 */
export function canonicalizeDescriptor(descriptor: WorkflowStructureDescriptor): string {
  return JSON.stringify({
    descriptorVersion: descriptor.descriptorVersion,
    workflowContractVersion: descriptor.workflowContractVersion,
    rootGraphKey: descriptor.rootGraphKey,
    graphs: descriptor.graphs.map((graph) => ({
      key: graph.key,
      title: graph.title,
      ...optional('description', graph.description),
      ...optional('intent', graph.intent),
      stateFields: graph.stateFields,
      entry: graph.entry,
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        ...(node.kind === 'subgraph' ? { graphKey: node.graphKey } : {}),
        ...optional('title', node.title),
        ...optional('description', node.description),
      })),
      edges: graph.edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        ...optional('title', edge.title),
      })),
      outcomes: graph.outcomes.map((outcome) => ({
        id: outcome.id,
        kind: outcome.kind,
        ...optional('reason', outcome.reason),
        ...optional('title', outcome.title),
      })),
    })),
  });
}

export function hashDescriptor(descriptor: WorkflowStructureDescriptor): string {
  return createHash('sha256').update(canonicalizeDescriptor(descriptor), 'utf8').digest('hex');
}
