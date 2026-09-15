import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkpoint,
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  subgraph,
} from '@yourtechbudstudio/isagi-workflow-sdk';

import {
  canonicalizeDescriptor,
  describeCapabilities,
  describeWorkflowModule,
  hashDescriptor,
  workflowStructureDescriptorVersion,
  type StructureDiagnosticCode,
  type WorkflowStructureDescriptor,
} from './structure.js';

type State = { readonly note: string };

function leafGraph(key: string) {
  return createGraph<State, {}, { readonly note: string }, string>({
    key,
    title: key,
    init: (_destination, parameters) => ({ note: parameters.note }),
    state: { note: reduce.replace<string>() },
    entry: 'act',
    nodes: { act: operation(async () => complete()) },
    edges: { fromAct: edge({ from: 'act', to: ['done'], choose: () => ({ to: 'done' }) }) },
    outcomes: { done: outcome({ kind: 'success', output: (state) => state.note }) },
  });
}

function moduleFor(graph: unknown) {
  return {
    default: defineWorkflow({
      command: () => ({ title: 'Test' }),
      validate: () => {},
      graph: graph as never,
    }),
  };
}

function describeOrThrow(graph: unknown): WorkflowStructureDescriptor {
  const result = describeWorkflowModule(moduleFor(graph));
  assert.ok(result.ok, `expected a valid structure, got ${JSON.stringify(result)}`);
  return result.descriptor;
}

function codesFor(graph: unknown): readonly StructureDiagnosticCode[] {
  const result = describeWorkflowModule(moduleFor(graph));
  assert.equal(result.ok, false, 'expected diagnostics');
  return result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code);
}

/** A graph object assembled by hand so a test can break exactly one rule. */
function brokenGraph(overrides: Record<string, unknown>) {
  return { ...leafGraph('Broken'), ...overrides };
}

// ---------------------------------------------------------------------------
// Module-level recognition
// ---------------------------------------------------------------------------

test('a valid module produces a descriptor at the current descriptor and contract versions', () => {
  const descriptor = describeOrThrow(leafGraph('Root'));
  assert.equal(descriptor.descriptorVersion, workflowStructureDescriptorVersion);
  assert.equal(descriptor.workflowContractVersion, 2);
  assert.equal(descriptor.rootGraphKey, 'Root');
  assert.deepEqual(
    descriptor.graphs.map((graph) => graph.key),
    ['Root'],
  );
});

test('a missing or unbranded default export is invalid_export, not a crash', () => {
  for (const namespace of [{}, { default: null }, { default: 'workflow' }, undefined]) {
    const result = describeWorkflowModule(namespace);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.diagnostics[0]?.code, 'invalid_export');
  }
});

test('a bundle built against another contract reports the real cause', () => {
  const result = describeWorkflowModule({
    default: { isagiContract: 1, isagiKind: 'workflow', command() {}, validate() {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.diagnostics[0]?.code, 'unsupported_contract');
  assert.match(
    result.ok ? '' : (result.diagnostics[0]?.message ?? ''),
    /contract version 1; this release supports version 2/,
  );
});

test('a workflow missing command or validate names the missing callback', () => {
  const workflow = defineWorkflow({
    command: () => ({ title: 'Test' }),
    validate: () => {},
    graph: leafGraph('Root') as never,
  });
  const result = describeWorkflowModule({
    default: { ...workflow, validate: undefined },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.diagnostics.some((d) => d.code === 'missing_callback'));
});

test('a workflow whose graph is not a graph is rejected before any walk', () => {
  const result = describeWorkflowModule({
    default: {
      ...defineWorkflow({
        command: () => ({ title: 'T' }),
        validate: () => {},
        graph: leafGraph('R') as never,
      }),
      graph: { key: 'NotAGraph' },
    },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.diagnostics.some((d) => d.code === 'invalid_export'));
});

// ---------------------------------------------------------------------------
// The per-graph rule table
// ---------------------------------------------------------------------------

const ruleCases: readonly (readonly [StructureDiagnosticCode, Record<string, unknown>])[] = [
  ['invalid_identifier', { key: '1nvalid' }],
  ['missing_title', { title: '' }],
  ['invalid_intent', { intent: 'aspirational' }],
  ['missing_init', { init: 'not a function' }],
  ['invalid_state_field', { state: { note: { reduce: () => '' } } }],
  ['empty_state', { state: {} }],
  ['empty_graph', { nodes: {} }],
  ['missing_entry', { entry: 'nowhere' }],
  ['no_outcomes', { outcomes: {} }],
  ['invalid_label', { label: 'not a function' }],
];

for (const [code, overrides] of ruleCases) {
  test(`${code} is reported for its minimal offending graph`, () => {
    assert.ok(codesFor(brokenGraph(overrides)).includes(code), `expected ${code}`);
  });
}

test('identifier_collision is reported when a node and an outcome share an id', () => {
  const graph = createGraph<State, {}, { readonly note: string }, string>({
    key: 'Collide',
    title: 'Collide',
    init: (_destination, parameters) => ({ note: parameters.note }),
    state: { note: reduce.replace<string>() },
    entry: 'done',
    nodes: { done: operation(async () => complete()) },
    edges: { fromDone: edge({ from: 'done', to: ['done'], choose: () => ({ to: 'done' }) }) },
    outcomes: { done: outcome({ kind: 'success', output: (state) => state.note }) },
  });
  assert.ok(codesFor(graph).includes('identifier_collision'));
});

test('entry_not_executable is reported when the entry names an outcome', () => {
  assert.ok(codesFor(brokenGraph({ entry: 'done' })).includes('entry_not_executable'));
});

test('unknown_node_kind is reported for a node that is not an SDK registration', () => {
  assert.ok(
    codesFor(brokenGraph({ nodes: { act: { run: () => {} } } })).includes('unknown_node_kind'),
  );
});

test('missing_callback is reported for each registration that lost its function', () => {
  const act = operation(async () => complete());
  assert.ok(
    codesFor(brokenGraph({ nodes: { act: { ...act, run: undefined } } })).includes(
      'missing_callback',
    ),
  );
  const done = outcome<State, string>({ kind: 'success', output: (state) => state.note });
  assert.ok(
    codesFor(brokenGraph({ outcomes: { done: { ...done, output: undefined } } })).includes(
      'missing_callback',
    ),
  );
  const router = edge<State, State>({ from: 'act', to: ['done'], choose: () => ({ to: 'done' }) });
  assert.ok(
    codesFor(brokenGraph({ edges: { fromAct: { ...router, choose: undefined } } })).includes(
      'missing_callback',
    ),
  );
});

test('subgraph_missing_graph is reported when a subgraph node invokes a non-graph', () => {
  const node = subgraph({
    graph: leafGraph('Child'),
    parameters: (parent: State) => ({ note: parent.note }),
    onResult: () => ({}),
  });
  assert.ok(
    codesFor(
      brokenGraph({
        nodes: { act: { ...node, graph: { key: 'Child' } } },
      }),
    ).includes('subgraph_missing_graph'),
  );
});

test('a router that names an unknown source or destination is reported', () => {
  assert.ok(
    codesFor(
      brokenGraph({
        edges: { fromGhost: edge({ from: 'ghost', to: ['done'], choose: () => ({ to: 'done' }) }) },
      }),
    ).includes('edge_source_unknown'),
  );
  assert.ok(
    codesFor(
      brokenGraph({
        edges: { fromAct: edge({ from: 'act', to: ['ghost'], choose: () => ({ to: 'ghost' }) }) },
      }),
    ).includes('edge_destination_unknown'),
  );
});

test('a node needs exactly one router: zero and two are both reported', () => {
  assert.ok(codesFor(brokenGraph({ edges: {} })).includes('missing_outgoing_edge'));
  assert.ok(
    codesFor(
      brokenGraph({
        edges: {
          fromAct: edge({ from: 'act', to: ['done'], choose: () => ({ to: 'done' }) }),
          alsoFromAct: edge({ from: 'act', to: ['done'], choose: () => ({ to: 'done' }) }),
        },
      }),
    ).includes('duplicate_edge_source'),
  );
});

test('an empty or duplicated destination set is reported', () => {
  assert.ok(
    codesFor(
      brokenGraph({
        edges: { fromAct: edge({ from: 'act', to: [], choose: () => ({ to: 'done' }) }) },
      }),
    ).includes('empty_destination_set'),
  );
  assert.ok(
    codesFor(
      brokenGraph({
        edges: {
          fromAct: edge({ from: 'act', to: ['done', 'done'], choose: () => ({ to: 'done' }) }),
        },
      }),
    ).includes('duplicate_destination'),
  );
});

test('routing loops and unreachable nodes are legal, not diagnostics', () => {
  const graph = createGraph<State, {}, { readonly note: string }, string>({
    key: 'Loop',
    title: 'Loop',
    init: (_destination, parameters) => ({ note: parameters.note }),
    state: { note: reduce.replace<string>() },
    entry: 'act',
    nodes: {
      act: operation(async () => complete()),
      // Never named by any destination. Legal: it still appears in the definition view.
      orphan: operation(async () => complete()),
    },
    edges: {
      // Routes back to itself. Termination is explicitly not proven.
      fromAct: edge({ from: 'act', to: ['act', 'done'], choose: () => ({ to: 'act' }) }),
      fromOrphan: edge({ from: 'orphan', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: { done: outcome({ kind: 'success', output: (state) => state.note }) },
  });
  const descriptor = describeOrThrow(graph);
  assert.deepEqual(
    descriptor.graphs[0]?.nodes.map((node) => node.id),
    ['act', 'orphan'],
  );
});

// ---------------------------------------------------------------------------
// Composition: reuse versus recursion
// ---------------------------------------------------------------------------

test('one graph reused under two registrations is one descriptor entry and two references', () => {
  const child = leafGraph('Child');
  const parent = createGraph<State, {}, { readonly note: string }, string>({
    key: 'Parent',
    title: 'Parent',
    init: (_destination, parameters) => ({ note: parameters.note }),
    state: { note: reduce.replace<string>() },
    entry: 'first',
    nodes: {
      first: subgraph({
        graph: child,
        parameters: (state) => ({ note: state.note }),
        onResult: () => ({}),
      }),
      second: subgraph({
        graph: child,
        parameters: (state) => ({ note: `${state.note}!` }),
        onResult: () => ({}),
      }),
    },
    edges: {
      fromFirst: edge({ from: 'first', to: ['second'], choose: () => ({ to: 'second' }) }),
      fromSecond: edge({ from: 'second', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: { done: outcome({ kind: 'success', output: (state) => state.note }) },
  });

  const descriptor = describeOrThrow(parent);
  assert.deepEqual(
    descriptor.graphs.map((graph) => graph.key),
    ['Child', 'Parent'],
  );
  const references = descriptor.graphs
    .flatMap((graph) => graph.nodes)
    .filter((node) => node.kind === 'subgraph')
    .map((node) => (node.kind === 'subgraph' ? node.graphKey : ''));
  assert.deepEqual(references, ['Child', 'Child']);
});

test('a graph nested inside itself is recursive_graph_containment, not an unbounded walk', () => {
  // Containment is tracked by object identity, so this is the case where a subgraph node's graph is
  // literally the graph that declares it. Reuse of a *different* object is legal (above).
  const self = {
    ...leafGraph('Recursive'),
    nodes: {
      act: subgraph({
        graph: leafGraph('Placeholder'),
        parameters: (parent: State) => ({ note: parent.note }),
        onResult: () => ({}),
      }),
    },
  };
  (self.nodes.act as { graph: unknown }).graph = self;
  assert.ok(codesFor(self).includes('recursive_graph_containment'));
});

test('two different graphs claiming one key is duplicate_graph_key', () => {
  const parent = createGraph<State, {}, { readonly note: string }, string>({
    key: 'Parent',
    title: 'Parent',
    init: (_destination, parameters) => ({ note: parameters.note }),
    state: { note: reduce.replace<string>() },
    entry: 'first',
    nodes: {
      first: subgraph({
        graph: leafGraph('Twin'),
        parameters: (state) => ({ note: state.note }),
        onResult: () => ({}),
      }),
      second: subgraph({
        graph: leafGraph('Twin'),
        parameters: (state) => ({ note: state.note }),
        onResult: () => ({}),
      }),
    },
    edges: {
      fromFirst: edge({ from: 'first', to: ['second'], choose: () => ({ to: 'second' }) }),
      fromSecond: edge({ from: 'second', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: { done: outcome({ kind: 'success', output: (state) => state.note }) },
  });
  assert.ok(codesFor(parent).includes('duplicate_graph_key'));
});

// ---------------------------------------------------------------------------
// Checkpoint: structurally valid, not launchable
// ---------------------------------------------------------------------------

test('a checkpoint node passes structural validation and reaches the capability report', () => {
  const graph = createGraph<State, {}, { readonly note: string }, string>({
    key: 'WithCheckpoint',
    title: 'With checkpoint',
    init: (_destination, parameters) => ({ note: parameters.note }),
    state: { note: reduce.replace<string>() },
    entry: 'pause',
    nodes: { pause: checkpoint({ caption: 'Review the diff' }) },
    edges: { fromPause: edge({ from: 'pause', to: ['done'], choose: () => ({ to: 'done' }) }) },
    outcomes: { done: outcome({ kind: 'success', output: (state) => state.note }) },
  });
  // It must not fail invalid_label: a checkpoint has a static caption, not a label callback.
  const descriptor = describeOrThrow(graph);
  const capabilities = describeCapabilities(descriptor);
  assert.equal(capabilities.launchable, false);
  assert.deepEqual(capabilities.unsupported, [
    {
      capability: 'checkpoint',
      graphKey: 'WithCheckpoint',
      nodeId: 'pause',
      caption: 'Review the diff',
    },
  ]);
});

test('a graph with no checkpoint is launchable', () => {
  assert.deepEqual(describeCapabilities(describeOrThrow(leafGraph('Root'))), {
    launchable: true,
    unsupported: [],
  });
});

// ---------------------------------------------------------------------------
// Canonicalization and hashing
// ---------------------------------------------------------------------------

test('canonicalization is stable across key insertion order', () => {
  const ordered = createGraph<State, {}, { readonly note: string }, string>({
    key: 'Order',
    title: 'Order',
    init: (_destination, parameters) => ({ note: parameters.note }),
    state: { note: reduce.replace<string>() },
    entry: 'alpha',
    nodes: {
      alpha: operation(async () => complete()),
      beta: operation(async () => complete()),
    },
    edges: {
      fromAlpha: edge({ from: 'alpha', to: ['beta'], choose: () => ({ to: 'beta' }) }),
      fromBeta: edge({ from: 'beta', to: ['done'], choose: () => ({ to: 'done' }) }),
    },
    outcomes: { done: outcome({ kind: 'success', output: (state) => state.note }) },
  });
  const shuffled = {
    ...ordered,
    nodes: { beta: ordered.nodes.beta!, alpha: ordered.nodes.alpha! },
    edges: { fromBeta: ordered.edges.fromBeta!, fromAlpha: ordered.edges.fromAlpha! },
  };
  assert.equal(
    canonicalizeDescriptor(describeOrThrow(ordered)),
    canonicalizeDescriptor(describeOrThrow(shuffled)),
  );
  assert.equal(hashDescriptor(describeOrThrow(ordered)), hashDescriptor(describeOrThrow(shuffled)));
});

test('canonicalization omits absent optional keys rather than writing null', () => {
  const canonical = canonicalizeDescriptor(describeOrThrow(leafGraph('Root')));
  assert.doesNotMatch(canonical, /null/);
  assert.doesNotMatch(canonical, /"description"/);
  assert.doesNotMatch(canonical, /"intent"/);
});

test('a structural change changes the hash', () => {
  assert.notEqual(
    hashDescriptor(describeOrThrow(leafGraph('Root'))),
    hashDescriptor(describeOrThrow(leafGraph('Other'))),
  );
});

test('an edge preserves declared destination order and collapses a duplicate', () => {
  const graph = brokenGraph({
    edges: {
      fromAct: edge({ from: 'act', to: ['done', 'act'], choose: () => ({ to: 'done' }) }),
    },
  });
  assert.deepEqual(describeOrThrow(graph).graphs[0]?.edges[0]?.to, ['done', 'act']);
});

// ---------------------------------------------------------------------------
// Cross-bundle recognition
// ---------------------------------------------------------------------------

test('a separately evaluated SDK copy produces an identical descriptor', () => {
  // Round-tripping through JSON severs every class, symbol, and constructor identity while keeping
  // the plain-data discriminants, which is exactly what bundling does to the SDK.
  const graph = leafGraph('Root');
  const real = describeOrThrow(graph);
  const foreign = JSON.parse(
    JSON.stringify(graph, (_key, value) =>
      typeof value === 'function' ? { callbackPlaceholder: true } : value,
    ),
  ) as Record<string, unknown>;
  reviveFunctions(foreign);
  assert.equal(canonicalizeDescriptor(describeOrThrow(foreign)), canonicalizeDescriptor(real));
});

function reviveFunctions(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    const placeholder = entry as { callbackPlaceholder?: boolean } | null;
    if (typeof entry === 'object' && entry !== null && placeholder?.callbackPlaceholder === true) {
      record[key] = () => undefined;
    } else {
      reviveFunctions(entry);
    }
  }
}

// ---------------------------------------------------------------------------
// Malformed keys must be rejected, never silently dropped
// ---------------------------------------------------------------------------

/**
 * Collection is keyed by object identity. Keying it by the declared key previously let a graph with
 * an unusable key vanish from inspection entirely: the root case verified as `ok` with zero graphs,
 * and the nested case produced a descriptor whose subgraph reference named a graph that was not in
 * it. Both would have been issued a receipt.
 */
for (const badKey of [123, null, undefined, { nested: true }, ['Root'], '1nvalid', '']) {
  test(`a root graph whose key is ${JSON.stringify(badKey) ?? 'undefined'} is rejected`, () => {
    assert.ok(codesFor({ ...leafGraph('Root'), key: badKey }).includes('invalid_identifier'));
  });
}

test('a nested graph with an unusable key is rejected, not omitted from the descriptor', () => {
  const child = { ...leafGraph('Child'), key: 7 };
  const parent = {
    ...leafGraph('Parent'),
    nodes: {
      act: subgraph({
        graph: child as never,
        parameters: (state: State) => ({ note: state.note }),
        onResult: () => ({}),
      }),
    },
  };
  assert.ok(codesFor(parent).includes('invalid_identifier'));
});

test('a successful descriptor contains its root and every graph its subgraphs reference', () => {
  const child = leafGraph('Child');
  const parent = {
    ...leafGraph('Parent'),
    nodes: {
      act: subgraph({
        graph: child,
        parameters: (state: State) => ({ note: state.note }),
        onResult: () => ({}),
      }),
    },
  };
  const descriptor = describeOrThrow(parent);
  const declared = new Set(descriptor.graphs.map((graph) => graph.key));
  assert.ok(declared.has(descriptor.rootGraphKey), 'the root graph is described');
  for (const graph of descriptor.graphs) {
    for (const node of graph.nodes) {
      if (node.kind !== 'subgraph') continue;
      assert.ok(declared.has(node.graphKey), `dangling reference to ${node.graphKey}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Resource limits
// ---------------------------------------------------------------------------

/** A graph with `count` operation nodes, each with its own router to the single outcome. */
function graphWithNodes(key: string, count: number) {
  const nodes: Record<string, unknown> = {};
  const edges: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    const id = `n${String(index).padStart(4, '0')}`;
    nodes[id] = operation(async () => complete());
    edges[`e${String(index).padStart(4, '0')}`] = edge({
      from: id,
      to: ['done'],
      choose: () => ({ to: 'done' }),
    });
  }
  return { ...leafGraph(key), entry: 'n0000', nodes, edges };
}

test('a graph may declare 256 nodes, and 257 is rejected', () => {
  assert.equal(describeOrThrow(graphWithNodes('AtNodeLimit', 256)).graphs[0]?.nodes.length, 256);
  // The rejection fixture also exceeds the edge limit, because every node needs exactly one router.
  // The assertion is that the node limit is reported, not that it is reported alone.
  assert.ok(codesFor(graphWithNodes('OverNodeLimit', 257)).includes('too_many_nodes'));
});

test('an oversized edge collection is rejected even when the graph has few nodes', () => {
  // For a valid graph the one-router-per-node rule makes this limit redundant. The extractor's
  // input is not valid by assumption, so the bound has to hold on its own.
  const edges: Record<string, unknown> = {};
  for (let index = 0; index < 257; index += 1) {
    edges[`e${String(index).padStart(4, '0')}`] = edge({
      from: 'act',
      to: ['done'],
      choose: () => ({ to: 'done' }),
    });
  }
  assert.ok(codesFor({ ...leafGraph('OverEdgeLimit'), edges }).includes('too_many_edges'));
});

test('a graph may declare 64 outcomes, and 65 is rejected', () => {
  const outcomesFor = (count: number) => {
    const outcomes: Record<string, unknown> = {};
    outcomes.done = outcome<State, string>({ kind: 'success', output: (state) => state.note });
    for (let index = 1; index < count; index += 1) {
      outcomes[`o${String(index).padStart(4, '0')}`] = outcome<State, string>({
        kind: 'failure',
        output: (state) => state.note,
      });
    }
    return outcomes;
  };
  // Unreferenced outcomes are legal, so the accepted fixture is otherwise valid.
  assert.equal(
    describeOrThrow({ ...leafGraph('AtOutcomeLimit'), outcomes: outcomesFor(64) }).graphs[0]
      ?.outcomes.length,
    64,
  );
  assert.ok(
    codesFor({ ...leafGraph('OverOutcomeLimit'), outcomes: outcomesFor(65) }).includes(
      'too_many_outcomes',
    ),
  );
});

/** A shallow, wide tree holding exactly `total` distinct graph definitions. */
function treeOfGraphs(total: number) {
  const fanout = 200;
  type Spec = { readonly key: string; readonly children: Spec[] };
  const specs: Spec[] = Array.from({ length: total }, (_unused, index) => ({
    key: `G${String(index).padStart(4, '0')}`,
    children: [],
  }));
  let next = 1;
  for (const spec of specs) {
    while (spec.children.length < fanout && next < total) {
      const child = specs[next];
      next += 1;
      if (child) spec.children.push(child);
    }
    if (next >= total) break;
  }
  const build = (spec: Spec): unknown => graphWithChildren(spec.key, spec.children.map(build));
  return build(specs[0]!);
}

function graphWithChildren(key: string, children: readonly unknown[]) {
  const nodes: Record<string, unknown> = { act: operation(async () => complete()) };
  const edges: Record<string, unknown> = {
    eAct: edge({ from: 'act', to: ['done'], choose: () => ({ to: 'done' }) }),
  };
  children.forEach((child, index) => {
    const id = `s${String(index).padStart(4, '0')}`;
    nodes[id] = subgraph({
      graph: child as never,
      parameters: (state: State) => ({ note: state.note }),
      onResult: () => ({}),
    });
    edges[`e${id}`] = edge({ from: id, to: ['done'], choose: () => ({ to: 'done' }) });
  });
  return { ...leafGraph(key), entry: 'act', nodes, edges };
}

test('a structure may contain 512 graphs, and the 513th stops inspection', () => {
  assert.equal(describeOrThrow(treeOfGraphs(512)).graphs.length, 512);
  const codes = codesFor(treeOfGraphs(513));
  assert.ok(codes.includes('too_many_graphs'));
  // The cap bounds the work; it does not report excessive work after doing it.
  assert.equal(codes.filter((code) => code === 'too_many_graphs').length, 1);
});

test('the capped result reports incomplete findings rather than claiming to be the only one', () => {
  // Validation of the graphs already collected still runs, so the cap is not the only finding it
  // can report. The message has to say results may be incomplete instead of claiming exclusivity.
  const capped = treeOfGraphs(513) as Record<string, unknown>;
  const outcomes = capped.outcomes as Record<string, Record<string, unknown>>;
  const alsoInvalid = {
    ...capped,
    outcomes: { done: { ...outcomes.done, kind: 'nope' } },
  };

  const result = describeWorkflowModule(moduleFor(alsoInvalid));
  assert.equal(result.ok, false, 'a capped structure is never a successful descriptor');
  const diagnostics = result.ok ? [] : result.diagnostics;

  const cap = diagnostics.find((diagnostic) => diagnostic.code === 'too_many_graphs');
  assert.ok(cap, 'the cap is reported');
  assert.match(cap.message, /may be incomplete/);
  // Deliberately not asserting the full message or the order: only that another legitimate
  // finding survives alongside the cap, which is what makes an exclusivity claim false.
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code !== 'too_many_graphs'));
});

// ---------------------------------------------------------------------------
// Topology is read, never executed
// ---------------------------------------------------------------------------

test('extraction reads registration data without invoking any author callback', () => {
  // Throwing alone would not settle this: an exception caught internally would look like success
  // while the callback had in fact run. Each callback therefore records its own invocation first,
  // and the assertion is that the record stays empty while extraction still succeeds.
  //
  // This is evidence for the callbacks exercised here, not a universal guarantee about an
  // arbitrary author module — importing a bundle executes its module-level code regardless.
  const invoked: string[] = [];
  const trap = (name: string) => (): never => {
    invoked.push(name);
    throw new Error(`${name} was invoked during extraction`);
  };
  const branded = (kind: string) => ({ isagiContract: 2, isagiKind: kind });

  const child = {
    ...branded('graph'),
    key: 'Child',
    title: 'Child',
    label: trap('child.label'),
    init: trap('child.init'),
    state: { note: { ...branded('state-field'), reduce: trap('child.reduce') } },
    entry: 'act',
    nodes: {
      act: {
        ...branded('operation-node'),
        label: trap('child.node.label'),
        run: trap('child.run'),
      },
    },
    edges: {
      fromAct: { ...branded('edge'), from: 'act', to: ['done'], choose: trap('child.choose') },
    },
    outcomes: { done: { ...branded('outcome'), kind: 'success', output: trap('child.output') } },
  };
  const root = {
    ...branded('graph'),
    key: 'Root',
    title: 'Root',
    label: trap('root.label'),
    init: trap('root.init'),
    state: { note: { ...branded('state-field'), reduce: trap('root.reduce') } },
    entry: 'nested',
    nodes: {
      nested: {
        ...branded('subgraph-node'),
        label: trap('root.node.label'),
        graph: child,
        parameters: trap('root.parameters'),
        onResult: trap('root.onResult'),
      },
    },
    edges: {
      fromNested: { ...branded('edge'), from: 'nested', to: ['done'], choose: trap('root.choose') },
    },
    outcomes: { done: { ...branded('outcome'), kind: 'success', output: trap('root.output') } },
  };

  const result = describeWorkflowModule({
    default: {
      ...branded('workflow'),
      command: trap('command'),
      validate: trap('validate'),
      graph: root,
    },
  });

  assert.ok(result.ok, 'extraction completes without needing any callback');
  assert.deepEqual(invoked, [], 'no author callback was invoked');

  // The derived products read the descriptor, so they must not reach a callback either.
  describeCapabilities(result.descriptor);
  hashDescriptor(result.descriptor);
  canonicalizeDescriptor(result.descriptor);
  assert.deepEqual(
    invoked,
    [],
    'no author callback was invoked while deriving from the descriptor',
  );
});

/** A containment chain of exactly `depth` graphs, the root included. */
function chainOfGraphs(depth: number) {
  let current = graphWithChildren(`C${String(depth - 1).padStart(4, '0')}`, []);
  for (let index = depth - 2; index >= 0; index -= 1) {
    current = graphWithChildren(`C${String(index).padStart(4, '0')}`, [current]);
  }
  return current;
}

test('containment is counted in graphs including the root: 64 is accepted, 65 is rejected', () => {
  assert.equal(describeOrThrow(chainOfGraphs(64)).graphs.length, 64);
  const codes = codesFor(chainOfGraphs(65));
  assert.ok(codes.includes('containment_too_deep'));
});

test('depth is judged from the whole structure, not from whichever branch was walked first', () => {
  // A shared tail reached both shallowly and deeply. Measuring depth during traversal made the
  // verdict depend on which branch sorted first: the shallow branch marked the tail visited, and
  // the deeper branch then skipped its descendants entirely.
  const tail = chainOfGraphs(10);
  const deep = (() => {
    let current = tail;
    for (let index = 0; index < 60; index += 1) {
      current = graphWithChildren(`D${String(index).padStart(4, '0')}`, [current]);
    }
    return current;
  })();

  const shallowFirst = graphWithChildren('Root', [tail, deep]);
  const deepFirst = graphWithChildren('Root', [deep, tail]);

  // The true chain is 70 graphs deep either way, so both orders must reject.
  for (const [name, root] of [
    ['shallow branch first', shallowFirst],
    ['deep branch first', deepFirst],
  ] as const) {
    assert.ok(codesFor(root).includes('containment_too_deep'), name);
  }
});

test('a reused graph is measured once, not once per path that reaches it', () => {
  // The same tail under two registrations is depth 11, not 21: reuse is not nesting.
  const tail = chainOfGraphs(10);
  assert.equal(describeOrThrow(graphWithChildren('Root', [tail, tail])).graphs.length, 11);
});

test('a cycle is reported without attempting a depth verdict over a non-DAG', () => {
  const self = {
    ...leafGraph('Recursive'),
    nodes: {
      act: subgraph({
        graph: leafGraph('Placeholder'),
        parameters: (state: State) => ({ note: state.note }),
        onResult: () => ({}),
      }),
    },
  };
  (self.nodes.act as { graph: unknown }).graph = self;
  const codes = codesFor(self);
  assert.ok(codes.includes('recursive_graph_containment'));
  assert.equal(codes.includes('containment_too_deep'), false);
});
