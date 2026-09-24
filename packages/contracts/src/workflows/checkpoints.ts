import { Schema } from 'effect';

import { workflowEvidenceContentQuerySchema } from './evidence.js';
import { nonEmptyString, nonNegativeInteger, positiveInteger } from './primitives.js';
import { booleanStringSchema, cursorSchema, paginationQuerySchema } from './requests.js';

/**
 * Checkpoints: the wire shape of an immutable, destination-root-relative filesystem boundary saved by
 * one visit to a checkpoint node.
 *
 * Every checkpoint carries an already-resolved final inventory: the files a reconstruction writes,
 * the paths it must remove from the selected base, the regions that inventory covers, and the
 * limitations a reader must know about. Clients page that result; they never replay ancestors. The
 * manifest is inspection data about how each layer arrived there, not something to apply.
 *
 * Like evidence, nothing here claims saved bytes or the base commit are still available. Bytes are
 * learned at content fetch; the commit is learned by whatever later tries to check it out.
 */

/**
 * Why a successful checkpoint is less than a complete picture, declared once for both storage and
 * the wire so a client never infers coverage from text.
 *
 * `warnings_truncated` is a sentinel carrying `{ omitted }`: only `uncaptured_dirty_path` is ever
 * capped. The other reasons are never cut.
 */
export const workflowCheckpointWarningReasonSchema = Schema.Literal(
  'uncaptured_dirty_path',
  'dirty_survey_unavailable',
  'ignored_paths_not_surveyed',
  'symlink_skipped',
  'special_file_skipped',
  'nested_repository_skipped',
  'scope_recaptured_empty',
  'warnings_truncated',
);

/**
 * Region-scoped reasons inherit with the region that produced them, because they decide which base
 * paths may become absences. The rest describe one capture and are never inherited.
 */
export const workflowCheckpointRegionWarningReasonSchema = Schema.Literal(
  'symlink_skipped',
  'special_file_skipped',
  'nested_repository_skipped',
);

export const workflowCheckpointScopeKindSchema = Schema.Literal('directory', 'file');

export const workflowCheckpointChangeOperationSchema = Schema.Literal('add', 'modify', 'delete');

export const workflowCheckpointBaseReasonSchema = Schema.Literal(
  'folder_project',
  'unborn_repository',
);

const hex64 = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
/** Git's object format is read at capture, so a commit id is SHA-1 or SHA-256 hex. */
const commitShaSchema = Schema.String.pipe(Schema.pattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));

/**
 * What reconstruction starts from before applying the inventory.
 *
 * `git` names the exact commit that visit's HEAD pointed at. It is a historical fact, not a retained
 * ref: Git may later discard the commit, and the consumer that restores from it reports that.
 * `repositoryId` is the Isagi project id of the repository. `none` means reconstruction starts from
 * an empty directory and reproduces only captured coverage.
 */
export const workflowCheckpointBaseSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('git'),
    repositoryId: positiveInteger,
    commitSha: commitShaSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('none'),
    reason: workflowCheckpointBaseReasonSchema,
  }),
);

export const workflowCheckpointSummarySchema = Schema.Struct({
  /** `wcp_<uuid>`. Opaque; never parsed for its run. */
  checkpointId: nonEmptyString,
  runId: positiveInteger,
  frameId: positiveInteger,
  executionId: positiveInteger,
  attemptId: positiveInteger,
  nodeId: nonEmptyString,
  /** The instance title `prepare` returned, or the node's static title, or its id. */
  title: nonEmptyString,
  createdAt: nonEmptyString,
  base: workflowCheckpointBaseSchema,
});

export const workflowCheckpointCountsSchema = Schema.Struct({
  scopes: nonNegativeInteger,
  files: nonNegativeInteger,
  absences: nonNegativeInteger,
  /** The resolved warning set: inherited region warnings plus this checkpoint's own. */
  warnings: nonNegativeInteger,
});

/** One group per reason this checkpoint itself observed; inherited region warnings are excluded. */
export const workflowCheckpointWarningGroupSchema = Schema.Struct({
  /** Never `warnings_truncated`: its `omitted` count is folded into `uncaptured_dirty_path`. */
  reason: workflowCheckpointWarningReasonSchema,
  count: positiveInteger,
  /** The first paths by inventory order; empty for path-less reasons. */
  samples: Schema.Array(nonEmptyString).pipe(Schema.maxItems(5)),
});

/** Inline on the execution record so the inspector needs no extra fetch for a checkpoint visit. */
export const workflowExecutionCheckpointSchema = Schema.Struct({
  checkpointId: nonEmptyString,
  title: nonEmptyString,
  base: workflowCheckpointBaseSchema,
  counts: workflowCheckpointCountsSchema,
});

export const workflowCheckpointSchema = Schema.extend(
  workflowCheckpointSummarySchema,
  Schema.Struct({
    /** The run's previously committed checkpoint, frozen at capture. */
    parentCheckpointId: Schema.NullOr(nonEmptyString),
    artifactHash: nonEmptyString,
    /** Descriptive provenance; never a credential and never proof the path still exists. */
    provenance: Schema.Struct({ repositoryRootPath: Schema.NullOr(nonEmptyString) }),
    counts: workflowCheckpointCountsSchema,
    /** Ordered by the reason vocabulary's order. */
    warningGroups: Schema.Array(workflowCheckpointWarningGroupSchema),
    links: Schema.Struct({ inventory: nonEmptyString, manifest: nonEmptyString }),
  }),
);

const warningFields = {
  reason: workflowCheckpointWarningReasonSchema,
  path: Schema.NullOr(nonEmptyString),
  scopeId: Schema.NullOr(nonEmptyString),
  /** Reason-specific scalars, e.g. `{ omitted }` for `warnings_truncated`. */
  detail: Schema.NullOr(
    Schema.Record({ key: Schema.String, value: Schema.Union(Schema.String, Schema.Number) }),
  ),
};

/**
 * One entry of a resolved inventory: final declarative state, never an ordered instruction.
 *
 * A `file` path and an `absent` path never name the same entry, and no two `file` entries do, so the
 * entries can be applied in any order.
 */
export const workflowCheckpointInventoryEntrySchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('scope'),
    scopeId: nonEmptyString,
    scopeKind: workflowCheckpointScopeKindSchema,
    path: nonEmptyString,
    exclusions: Schema.Array(nonEmptyString),
    /** The checkpoint whose capture produced this coverage. */
    capturedBy: nonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal('file'),
    path: nonEmptyString,
    /** `wcf_<uuid>`, the content route's key. */
    fileId: nonEmptyString,
    sha256: hex64,
    sizeBytes: nonNegativeInteger,
    /** The owner-execute bit, the only preserved mode. */
    executable: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal('absent'), path: nonEmptyString }),
  Schema.Struct({ kind: Schema.Literal('warning'), ...warningFields, observedBy: nonEmptyString }),
);

/** Lineage for inspection: each layer's own scopes, changes and observations. */
export const workflowCheckpointManifestEntrySchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('layer'),
    checkpointId: nonEmptyString,
    parentCheckpointId: Schema.NullOr(nonEmptyString),
    title: nonEmptyString,
    createdAt: nonEmptyString,
    base: workflowCheckpointBaseSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('scope'),
    checkpointId: nonEmptyString,
    scopeId: nonEmptyString,
    scopeKind: workflowCheckpointScopeKindSchema,
    path: nonEmptyString,
    exclusions: Schema.Array(nonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal('change'),
    checkpointId: nonEmptyString,
    operation: workflowCheckpointChangeOperationSchema,
    path: nonEmptyString,
    sha256: Schema.optional(hex64),
    sizeBytes: Schema.optional(nonNegativeInteger),
    executable: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal('warning'),
    checkpointId: nonEmptyString,
    ...warningFields,
  }),
);

export const workflowCheckpointRouteParamsSchema = Schema.Struct({
  runId: positiveInteger,
  checkpointId: nonEmptyString,
});

export const workflowCheckpointFileRouteParamsSchema = Schema.Struct({
  runId: positiveInteger,
  checkpointId: nonEmptyString,
  fileId: nonEmptyString,
});

export const listWorkflowCheckpointsQuerySchema = Schema.extend(
  paginationQuerySchema,
  Schema.Struct({
    executionId: Schema.optional(positiveInteger),
    /**
     * Include every execution beneath the named execution's child frames. The evidence route spells
     * the same relation `subtree`; this route keeps the spelling its story fixed rather than renaming
     * the older parameter.
     */
    descendants: Schema.optional(booleanStringSchema),
  }),
).pipe(
  Schema.filter((query) => {
    const wantsDescendants = query.descendants === true || query.descendants === 'true';
    if (wantsDescendants && query.executionId === undefined) {
      return 'descendants requires executionId';
    }
    return true;
  }),
);

export const listWorkflowCheckpointsOutputSchema = Schema.Struct({
  items: Schema.Array(workflowCheckpointSummarySchema),
  nextCursor: Schema.NullOr(cursorSchema),
});

export const getWorkflowCheckpointOutputSchema = Schema.Struct({
  checkpoint: workflowCheckpointSchema,
});

export const listWorkflowCheckpointInventoryOutputSchema = Schema.Struct({
  checkpointId: nonEmptyString,
  entries: Schema.Array(workflowCheckpointInventoryEntrySchema),
  nextCursor: Schema.NullOr(cursorSchema),
});

export const listWorkflowCheckpointManifestOutputSchema = Schema.Struct({
  checkpointId: nonEmptyString,
  entries: Schema.Array(workflowCheckpointManifestEntrySchema),
  nextCursor: Schema.NullOr(cursorSchema),
});

/** The same `download` flag as the evidence content route. */
export const workflowCheckpointContentQuerySchema = workflowEvidenceContentQuerySchema;

export type WorkflowCheckpointWarningReason = typeof workflowCheckpointWarningReasonSchema.Type;
export type WorkflowCheckpointRegionWarningReason =
  typeof workflowCheckpointRegionWarningReasonSchema.Type;
export type WorkflowCheckpointScopeKind = typeof workflowCheckpointScopeKindSchema.Type;
export type WorkflowCheckpointChangeOperation = typeof workflowCheckpointChangeOperationSchema.Type;
export type WorkflowCheckpointBaseReason = typeof workflowCheckpointBaseReasonSchema.Type;
export type WorkflowCheckpointBase = typeof workflowCheckpointBaseSchema.Type;
export type WorkflowCheckpointSummaryDto = typeof workflowCheckpointSummarySchema.Type;
export type WorkflowCheckpointCounts = typeof workflowCheckpointCountsSchema.Type;
export type WorkflowCheckpointWarningGroup = typeof workflowCheckpointWarningGroupSchema.Type;
export type WorkflowExecutionCheckpointDto = typeof workflowExecutionCheckpointSchema.Type;
export type WorkflowCheckpointDto = typeof workflowCheckpointSchema.Type;
export type WorkflowCheckpointInventoryEntry = typeof workflowCheckpointInventoryEntrySchema.Type;
export type WorkflowCheckpointManifestEntry = typeof workflowCheckpointManifestEntrySchema.Type;
export type WorkflowCheckpointRouteParams = typeof workflowCheckpointRouteParamsSchema.Type;
export type WorkflowCheckpointFileRouteParams = typeof workflowCheckpointFileRouteParamsSchema.Type;
export type ListWorkflowCheckpointsQuery = typeof listWorkflowCheckpointsQuerySchema.Type;
export type ListWorkflowCheckpointsOutput = typeof listWorkflowCheckpointsOutputSchema.Type;
export type GetWorkflowCheckpointOutput = typeof getWorkflowCheckpointOutputSchema.Type;
export type ListWorkflowCheckpointInventoryOutput =
  typeof listWorkflowCheckpointInventoryOutputSchema.Type;
export type ListWorkflowCheckpointManifestOutput =
  typeof listWorkflowCheckpointManifestOutputSchema.Type;
export type WorkflowCheckpointContentQuery = typeof workflowCheckpointContentQuerySchema.Type;
