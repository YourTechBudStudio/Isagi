import { Schema } from 'effect';

import { nonEmptyString, nonNegativeInteger, positiveInteger } from './primitives.js';
import { booleanStringSchema, cursorSchema, paginationQuerySchema } from './requests.js';

/**
 * Author-selected evidence: the wire shape of a `ctx.captureEvidence` record.
 *
 * "Evidence" here is always the bare word and always means this — something an author deliberately
 * kept. Engine facts about an operation are `lateEvidence`, and "artifact" keeps its two existing
 * meanings (a verified definition version, and a harness directory). No new name may reuse either.
 */

/**
 * The evidence vocabulary, declared once for both storage and the wire.
 *
 * The runtime imports these rather than restating them, the same way it already takes every other
 * closed set from here. Two same-named copies of one vocabulary across a package boundary is drift
 * with no compiler signal: a later story adding a fifth content kind would have two files to find
 * and nothing pointing at the second.
 *
 * The `resolved` pair exists because a source that resolved to nothing and a source the author never
 * gave are different records, and the discriminated union says so. The full set is what a row
 * stores; the resolved subset is what the union's session-bearing arm can carry. Declaring the
 * narrower one and composing the wider from it stops a schema advertising a value that can never
 * appear on the wire.
 */

export const workflowEvidenceContentKindSchema = Schema.Literal('text', 'json', 'file', 'bytes');

/** The three kinds that name a session. Each carries an attribution; `none` does not. */
export const workflowEvidenceResolvedSourceKindSchema = Schema.Literal(
  'agent_turn',
  'headless_operation',
  'agent_session',
);

export const workflowEvidenceSourceKindSchema = Schema.Union(
  workflowEvidenceResolvedSourceKindSchema,
  Schema.Literal('none'),
);

/**
 * How confidently the runtime connected this record to an operation it made.
 *
 * `unresolved` is a recorded answer, not a failure: the evidence is saved and the record says the
 * connection could not be made. A confident false claim about provenance would be worse than an
 * honest gap.
 */
export const workflowEvidenceResolvedAttributionSchema = Schema.Literal(
  'exact',
  'inferred_latest_operation',
  'unresolved',
);

/** What a row stores. `none` goes with the `none` source kind, which the wire models as its own arm. */
export const workflowEvidenceSourceAttributionSchema = Schema.Union(
  workflowEvidenceResolvedAttributionSchema,
  Schema.Literal('none'),
);

/** Flat scalars, derived from graph state and handles — never from the captured content itself. */
export const workflowEvidenceLabelsSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
});

/**
 * What the bytes are and where they live — deliberately not *whether they are still there*.
 *
 * A list of a thousand rows must not stat a thousand files, so no read path claims availability
 * here. It is learned at fetch time, exactly as the payload route already teaches a client to learn
 * it. `mediaType` is a fact about this *use* of the bytes, not about the digest: the same canonical
 * bytes can be a `text/plain` capture and an `application/json` payload slot.
 */
export const workflowEvidenceContentSchema = Schema.Struct({
  kind: workflowEvidenceContentKindSchema,
  mediaType: nonEmptyString,
  byteSize: nonNegativeInteger,
  /** `sha256:<64 hex>`. Opaque on the wire: a client never receives a filesystem path. */
  contentRef: nonEmptyString,
  /** Worktree-relative, `file` captures only. */
  sourcePath: Schema.NullOr(nonEmptyString),
});

/**
 * Where the captured thing came from.
 *
 * Discriminated so `none` cannot carry an attribution and a session-bearing kind cannot omit one.
 * `operationKey` is null when nothing resolved, which is exactly what `unresolved` reports.
 */
export const workflowEvidenceSourceSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('none') }),
  Schema.Struct({
    kind: workflowEvidenceResolvedSourceKindSchema,
    agentSessionId: Schema.NullOr(positiveInteger),
    operationKey: Schema.NullOr(nonEmptyString),
    attribution: workflowEvidenceResolvedAttributionSchema,
  }),
);

export const workflowEvidenceSchema = Schema.Struct({
  evidenceKey: nonEmptyString,
  /** Placement, copied onto the row at capture so a record reads as evidence on its own. */
  frameId: positiveInteger,
  executionId: positiveInteger,
  /** The attempt that made the bytes durable. Evidence outlives it, so this is provenance. */
  attemptId: positiveInteger,
  /** The capture call position. Follow it to `getOperation` for the full provenance block. */
  operationKey: nonEmptyString,
  title: nonEmptyString,
  role: nonEmptyString,
  labels: workflowEvidenceLabelsSchema,
  content: workflowEvidenceContentSchema,
  source: workflowEvidenceSourceSchema,
  /** The verified definition version pinned at capture, copied from the operation. */
  artifactHash: nonEmptyString,
  capturedAt: nonEmptyString,
});

export const workflowEvidenceRouteParamsSchema = Schema.Struct({
  runId: positiveInteger,
  evidenceKey: nonEmptyString,
});

/**
 * A repeatable `label=key:value` filter, normalised to an array on both sides of the wire.
 *
 * HTTP gives one occurrence as a bare string and two or more as an array; the transform absorbs
 * exactly that asymmetry, so the runtime never re-narrows a union and the client's query type is
 * always a list. A comma-joined single parameter was rejected: label values are author-supplied
 * free text up to 1024 characters, and an implicit encoding would make a comma permanently illegal
 * inside one.
 *
 * Splitting on the first colon is unambiguous because a label key may not contain one (refused at
 * capture). Values are compared as text, so `round:2` matches the number `2` and the string `"2"`.
 */
const labelFilterSchema = Schema.transform(
  Schema.Union(Schema.String, Schema.Array(Schema.String)),
  Schema.Array(Schema.String),
  {
    strict: true,
    decode: (value) => (typeof value === 'string' ? [value] : value),
    encode: (value) => value,
  },
);

export const listWorkflowEvidenceQuerySchema = Schema.extend(
  paginationQuerySchema,
  Schema.Struct({
    frameId: Schema.optional(positiveInteger),
    executionId: Schema.optional(positiveInteger),
    /** Include every execution beneath the named execution's child frames. */
    subtree: Schema.optional(booleanStringSchema),
    role: Schema.optional(nonEmptyString),
    label: Schema.optional(labelFilterSchema),
  }),
).pipe(
  Schema.filter((query) => {
    // Written as statements, not as a `||` chain ending in a string: Effect reads a returned string
    // as the failure message, and a chain invites the reader to parse that string as a truthy pass.
    const wantsSubtree = query.subtree === true || query.subtree === 'true';
    if (wantsSubtree && query.executionId === undefined) return 'subtree requires executionId';
    return true;
  }),
);

export const listWorkflowEvidenceOutputSchema = Schema.Struct({
  items: Schema.Array(workflowEvidenceSchema),
  nextCursor: Schema.NullOr(cursorSchema),
});

export const getWorkflowEvidenceOutputSchema = Schema.Struct({
  evidence: workflowEvidenceSchema,
});

/**
 * `'true'` and `'false'`, never `1`: route params and queries pass through a numeric coercion that
 * would turn `download=1` into the number `1` and fail a string-literal match.
 */
export const workflowEvidenceContentQuerySchema = Schema.Struct({
  download: Schema.optional(Schema.Literal('true', 'false')),
});

export type WorkflowEvidenceDto = typeof workflowEvidenceSchema.Type;
export type WorkflowEvidenceContent = typeof workflowEvidenceContentSchema.Type;
export type WorkflowEvidenceSource = typeof workflowEvidenceSourceSchema.Type;
export type WorkflowEvidenceContentKind = typeof workflowEvidenceContentKindSchema.Type;
export type WorkflowEvidenceSourceKind = typeof workflowEvidenceSourceKindSchema.Type;
export type WorkflowEvidenceResolvedSourceKind =
  typeof workflowEvidenceResolvedSourceKindSchema.Type;
export type WorkflowEvidenceSourceAttribution = typeof workflowEvidenceSourceAttributionSchema.Type;
export type WorkflowEvidenceResolvedAttribution =
  typeof workflowEvidenceResolvedAttributionSchema.Type;
export type WorkflowEvidenceLabels = typeof workflowEvidenceLabelsSchema.Type;
export type ListWorkflowEvidenceQuery = typeof listWorkflowEvidenceQuerySchema.Type;
export type ListWorkflowEvidenceOutput = typeof listWorkflowEvidenceOutputSchema.Type;
export type GetWorkflowEvidenceOutput = typeof getWorkflowEvidenceOutputSchema.Type;
export type WorkflowEvidenceRouteParams = typeof workflowEvidenceRouteParamsSchema.Type;
export type WorkflowEvidenceContentQuery = typeof workflowEvidenceContentQuerySchema.Type;
