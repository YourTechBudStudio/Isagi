import { Schema } from 'effect';

import { nonEmptyString, positiveInteger, workflowOutcomeKindSchema } from './primitives.js';

/**
 * The serialized structural descriptor.
 *
 * The verifier owns the descriptor type and every structural rule; this mirrors it for the wire.
 * A test binds the two shapes bidirectionally and decodes a descriptor produced by the real
 * extractor, so the mirror cannot drift silently — contracts stay implementation-free and never
 * depend on the verifier at run time.
 */

/**
 * The closed set of structural diagnostic codes.
 *
 * The verifier owns these; mirroring them as literals rather than as an open string is what lets a
 * client handle a structural rejection exhaustively instead of pattern-matching free text. A
 * test-only binding proves the two sets stay identical.
 */
export const workflowStructureDiagnosticCodeSchema = Schema.Literal(
  'invalid_export',
  'unsupported_contract',
  'missing_callback',
  'invalid_identifier',
  'missing_title',
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
  // Reload validation, reported when Resume or Retry is refused because the latest build no
  // longer fits where the run is parked.
  'graph_missing',
  'subgraph_registration_changed',
  'node_missing',
  'node_kind_changed',
  'edge_identity_changed',
  'destination_no_longer_declared',
  'outcome_missing',
  'outcome_kind_changed',
);

export const workflowStructureDiagnosticSchema = Schema.Struct({
  code: workflowStructureDiagnosticCodeSchema,
  message: Schema.String,
  at: Schema.Struct({
    graphKey: Schema.optionalWith(Schema.String, { exact: true }),
    nodeId: Schema.optionalWith(Schema.String, { exact: true }),
    edgeId: Schema.optionalWith(Schema.String, { exact: true }),
    outcomeId: Schema.optionalWith(Schema.String, { exact: true }),
    field: Schema.optionalWith(Schema.String, { exact: true }),
  }),
});

export const workflowNodeDescriptorSchema = Schema.Union(
  Schema.Struct({
    id: nonEmptyString,
    kind: Schema.Literal('operation'),
    title: Schema.optionalWith(Schema.String, { exact: true }),
    description: Schema.optionalWith(Schema.String, { exact: true }),
  }),
  Schema.Struct({
    id: nonEmptyString,
    kind: Schema.Literal('subgraph'),
    graphKey: nonEmptyString,
    title: Schema.optionalWith(Schema.String, { exact: true }),
    description: Schema.optionalWith(Schema.String, { exact: true }),
  }),
  Schema.Struct({
    id: nonEmptyString,
    kind: Schema.Literal('checkpoint'),
    title: Schema.optionalWith(Schema.String, { exact: true }),
    description: Schema.optionalWith(Schema.String, { exact: true }),
  }),
);

export const workflowEdgeDescriptorSchema = Schema.Struct({
  id: nonEmptyString,
  from: nonEmptyString,
  /** The author's declared destination set, in declared order. Order is descriptive only. */
  to: Schema.Array(nonEmptyString),
  title: Schema.optionalWith(Schema.String, { exact: true }),
});

export const workflowOutcomeDescriptorSchema = Schema.Struct({
  id: nonEmptyString,
  kind: workflowOutcomeKindSchema,
  reason: Schema.optionalWith(Schema.String, { exact: true }),
  title: Schema.optionalWith(Schema.String, { exact: true }),
});

export const workflowGraphDescriptorSchema = Schema.Struct({
  key: nonEmptyString,
  title: nonEmptyString,
  description: Schema.optionalWith(Schema.String, { exact: true }),
  stateFields: Schema.Array(nonEmptyString),
  entry: nonEmptyString,
  nodes: Schema.Array(workflowNodeDescriptorSchema),
  edges: Schema.Array(workflowEdgeDescriptorSchema),
  outcomes: Schema.Array(workflowOutcomeDescriptorSchema),
});

export const workflowStructureDescriptorSchema = Schema.Struct({
  descriptorVersion: Schema.Literal(2),
  workflowContractVersion: Schema.Literal(5),
  rootGraphKey: nonEmptyString,
  graphs: Schema.Array(workflowGraphDescriptorSchema),
});

export const getWorkflowStructureQuerySchema = Schema.Struct({
  /** Omitted returns the run's current build. Any build the run has used can be named. */
  artifactHash: Schema.optional(nonEmptyString),
});

/** A verified build of a workflow and the structure it declares. */
export const getWorkflowStructureOutputSchema = Schema.Struct({
  artifactHash: nonEmptyString,
  workflowKey: nonEmptyString,
  sdkVersion: nonEmptyString,
  verifierVersion: nonEmptyString,
  contractVersion: positiveInteger,
  firstSeenAt: nonEmptyString,
  descriptor: workflowStructureDescriptorSchema,
});

export type WorkflowStructureDiagnosticCode = typeof workflowStructureDiagnosticCodeSchema.Type;
export type WorkflowStructureDiagnosticDto = typeof workflowStructureDiagnosticSchema.Type;
export type WorkflowNodeDescriptorDto = typeof workflowNodeDescriptorSchema.Type;
export type WorkflowEdgeDescriptorDto = typeof workflowEdgeDescriptorSchema.Type;
export type WorkflowOutcomeDescriptorDto = typeof workflowOutcomeDescriptorSchema.Type;
export type WorkflowGraphDescriptorDto = typeof workflowGraphDescriptorSchema.Type;
export type WorkflowStructureDescriptorDto = typeof workflowStructureDescriptorSchema.Type;
export type GetWorkflowStructureQuery = typeof getWorkflowStructureQuerySchema.Type;
export type GetWorkflowStructureOutput = typeof getWorkflowStructureOutputSchema.Type;
