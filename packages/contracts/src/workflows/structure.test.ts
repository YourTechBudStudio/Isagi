import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
  describeWorkflowModule,
  type StructureDiagnosticCode,
  type WorkflowStructureDescriptor,
} from '@yourtechbudstudio/isagi-workflow-verifier/structure';
import { Schema } from 'effect';

import {
  workflowStructureDescriptorSchema,
  workflowStructureDiagnosticCodeSchema,
  workflowStructureDiagnosticSchema,
  workflowVersionSchema,
  type WorkflowStructureDescriptorDto,
  type WorkflowStructureDiagnosticCode,
} from './structure.js';

/**
 * The verifier owns the descriptor and every structural rule; this package mirrors it for the wire.
 * Two checks keep the mirror honest, because neither alone is enough: assignability catches a
 * structural type change, and decoding a descriptor from the real extractor catches a schema that
 * type-checks but rejects real data.
 *
 * The verifier is a **development** dependency here. Nothing in the published contracts surface
 * imports it, so contracts stay implementation-free.
 */

// --- Compile-time drift, in both directions ---------------------------------

type MirrorAcceptsVerifier = WorkflowStructureDescriptor extends WorkflowStructureDescriptorDto
  ? true
  : never;
type VerifierAcceptsMirror = WorkflowStructureDescriptorDto extends WorkflowStructureDescriptor
  ? true
  : never;

const mirrorAcceptsVerifier: MirrorAcceptsVerifier = true;
const verifierAcceptsMirror: VerifierAcceptsMirror = true;

test('the contracts schema and the verifier descriptor describe the same shape', () => {
  // The assignments above fail to compile if either direction drifts; these keep them referenced.
  assert.equal(mirrorAcceptsVerifier, true);
  assert.equal(verifierAcceptsMirror, true);
});

// --- Runtime drift ----------------------------------------------------------

type State = { readonly note: string };

function describeOrThrow(graph: unknown): WorkflowStructureDescriptor {
  const result = describeWorkflowModule({
    default: defineWorkflow({
      command: () => ({ title: 'Test' }),
      validate: () => {},
      graph: graph as never,
    }),
  });
  if (!result.ok)
    throw new Error(`expected a valid structure: ${JSON.stringify(result.diagnostics)}`);
  return result.descriptor;
}

function leaf(key: string) {
  return createGraph<State, {}, { readonly note: string }, string>({
    key,
    title: key,
    intent: 'operational',
    init: (_destination, parameters) => ({ note: parameters.note }),
    state: { note: reduce.replace<string>() },
    entry: 'act',
    nodes: {
      act: operation(async () => complete(), { title: 'Act', description: 'Does a thing' }),
    },
    edges: {
      fromAct: edge({
        from: 'act',
        to: ['done', 'act'],
        choose: () => ({ to: 'done' }),
        title: 'Route',
      }),
    },
    outcomes: {
      done: outcome({ kind: 'success', reason: 'finished', title: 'Done', output: (s) => s.note }),
    },
  });
}

test('a descriptor produced by the real extractor decodes through the contracts schema', () => {
  const child = leaf('Child');
  const root = createGraph<State, {}, { readonly note: string }, string>({
    key: 'Root',
    title: 'Root',
    intent: 'business',
    init: (_destination, parameters) => ({ note: parameters.note }),
    state: { note: reduce.replace<string>() },
    entry: 'nested',
    nodes: {
      nested: subgraph({
        graph: child,
        parameters: (parent: State) => ({ note: parent.note }),
        onResult: () => ({}),
      }),
    },
    edges: { fromNested: edge({ from: 'nested', to: ['done'], choose: () => ({ to: 'done' }) }) },
    outcomes: { done: outcome({ kind: 'failure', output: (s) => s.note }) },
  });

  const descriptor = describeOrThrow(root);

  // Round-tripping through JSON is what actually crosses the wire.
  const onTheWire = JSON.parse(JSON.stringify(descriptor));
  const decoded = Schema.decodeUnknownSync(workflowStructureDescriptorSchema)(onTheWire);
  assert.equal(decoded.rootGraphKey, 'Root');
  assert.deepEqual(
    decoded.graphs.map((graph) => graph.key),
    ['Child', 'Root'],
  );
  assert.equal(decoded.graphs[1]?.intent, 'business');
  assert.deepEqual(decoded.graphs[0]?.edges[0]?.to, ['done', 'act']);
  assert.equal(decoded.graphs[1]?.nodes[0]?.kind, 'subgraph');
});

test('a checkpoint descriptor also decodes, so an unlaunchable package is still inspectable', () => {
  const descriptor = describeOrThrow(
    createGraph<State, {}, { readonly note: string }, string>({
      key: 'WithCheckpoint',
      title: 'With checkpoint',
      init: (_destination, parameters) => ({ note: parameters.note }),
      state: { note: reduce.replace<string>() },
      entry: 'pause',
      nodes: {
        pause: { isagiContract: 3, isagiKind: 'checkpoint-node', caption: 'Review' } as never,
      },
      edges: { fromPause: edge({ from: 'pause', to: ['done'], choose: () => ({ to: 'done' }) }) },
      outcomes: { done: outcome({ kind: 'success', output: (s) => s.note }) },
    }),
  );
  const decoded = Schema.decodeUnknownSync(workflowStructureDescriptorSchema)(
    JSON.parse(JSON.stringify(descriptor)),
  );
  const node = decoded.graphs[0]?.nodes[0];
  assert.equal(node?.kind, 'checkpoint');
  assert.equal(node?.kind === 'checkpoint' ? node.caption : null, 'Review');
});

test('the schema rejects a descriptor from an unsupported contract or descriptor version', () => {
  const valid = {
    descriptorVersion: 1,
    workflowContractVersion: 3,
    rootGraphKey: 'Root',
    graphs: [],
  };
  assert.doesNotThrow(() => Schema.decodeUnknownSync(workflowStructureDescriptorSchema)(valid));
  assert.throws(() =>
    Schema.decodeUnknownSync(workflowStructureDescriptorSchema)({ ...valid, descriptorVersion: 2 }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(workflowStructureDescriptorSchema)({
      ...valid,
      workflowContractVersion: 2,
    }),
  );
});

test('the contracts diagnostic codes are exactly the codes the verifier can emit', () => {
  // An open string would let a structural rejection carry a code no client could handle, and would
  // let the two sets drift. The verifier owns the set; this proves the mirror matches it.
  const verifierCodes: readonly StructureDiagnosticCode[] = [
    'invalid_export',
    'unsupported_contract',
    'missing_callback',
    'invalid_identifier',
    'missing_title',
    'invalid_intent',
    'missing_init',
    'invalid_state_field',
    'empty_state',
    'empty_graph',
    'identifier_collision',
    'unknown_node_kind',
    'subgraph_missing_graph',
    'missing_entry',
    'entry_not_executable',
    'edge_source_unknown',
    'duplicate_edge_source',
    'missing_outgoing_edge',
    'empty_destination_set',
    'duplicate_destination',
    'edge_destination_unknown',
    'no_outcomes',
    'invalid_label',
    'duplicate_graph_key',
    'recursive_graph_containment',
    'too_many_graphs',
    'too_many_nodes',
    'too_many_edges',
    'too_many_outcomes',
    'containment_too_deep',
    'deferred_executable_dependency',
    'checkpoint_not_launchable',
    'graph_missing',
    'subgraph_registration_changed',
    'node_missing',
    'node_kind_changed',
    'edge_identity_changed',
    'destination_no_longer_declared',
    'outcome_missing',
    'outcome_kind_changed',
  ];
  // Assignable both ways: neither set may gain a member the other lacks.
  const mirrored: readonly WorkflowStructureDiagnosticCode[] = verifierCodes;
  const back: readonly StructureDiagnosticCode[] = mirrored;
  assert.equal(back.length, 40);

  for (const code of verifierCodes) {
    assert.equal(Schema.decodeUnknownSync(workflowStructureDiagnosticCodeSchema)(code), code);
  }
  assert.throws(() => Schema.decodeUnknownSync(workflowStructureDiagnosticCodeSchema)('invented'));
});

test('a real extractor diagnostic decodes through the mirrored code set', () => {
  const result = describeWorkflowModule({ default: null });
  assert.equal(result.ok, false);
  const decoded = Schema.decodeUnknownSync(workflowStructureDiagnosticSchema)(
    JSON.parse(JSON.stringify(result.ok ? null : result.diagnostics[0])),
  );
  assert.equal(decoded.code, 'invalid_export');
});

test('only a launch and an adopted Retry create a version adoption', () => {
  // Resume loads the run's current pin and never discovers or adopts a newer artifact, so a
  // `resume` adoption is a record the engine must never be able to produce.
  const adoption = {
    artifactHash: 'sha256:pin4',
    pinOrdinal: 4,
    sdkVersion: '0.1.0',
    verifierVersion: '0.1.0',
    rootGraphKey: 'Story',
    adoptedAt: '2026-01-01T00:00:00.000Z',
    adoptedBy: 'launch',
  };
  for (const adoptedBy of ['launch', 'retry']) {
    assert.equal(
      Schema.decodeUnknownSync(workflowVersionSchema)({ ...adoption, adoptedBy }).adoptedBy,
      adoptedBy,
    );
  }
  assert.throws(() =>
    Schema.decodeUnknownSync(workflowVersionSchema)({ ...adoption, adoptedBy: 'resume' }),
  );
});
