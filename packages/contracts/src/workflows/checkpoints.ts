import { Schema } from 'effect';

import { pagedSchema, paginationQueryFields, queryTextSchema } from './pagination.js';
import { nonEmptyString, nonNegativeInteger, positiveInteger } from './primitives.js';

/**
 * Checkpoints: what one visit to a checkpoint node saved.
 *
 * A checkpoint is self-contained: the Git HEAD commit at capture (none for a folder project or a
 * repository with no commits) plus an exact copy of the scopes its plan named. Nothing is inherited
 * from earlier checkpoints. The commit is recorded, not retained, so exporting fails if it has since
 * been discarded.
 */

const hex64 = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
/** Git's object format is read at capture, so a commit id is SHA-1 or SHA-256 hex. */
const commitShaSchema = Schema.String.pipe(Schema.pattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));

export const workflowCheckpointScopeKindSchema = Schema.Literal('directory', 'file');

export const workflowCheckpointFileSchema = Schema.Struct({
  /** Destination-root-relative, like the scope's own path, so it is what the file route takes. */
  path: nonEmptyString,
  sha256: hex64,
  sizeBytes: nonNegativeInteger,
  /** The owner-execute bit, the only preserved mode. */
  executable: Schema.Boolean,
});

const scopeFields = {
  /** The stable name the plan gave this scope, for listing and comparison. */
  scope: nonEmptyString,
  kind: workflowCheckpointScopeKindSchema,
  /** Destination-root-relative path of the directory or file. */
  path: nonEmptyString,
  /** Scope-relative paths left out of a directory scope. Export leaves them untouched. */
  exclude: Schema.Array(nonEmptyString),
  /** The path did not exist at capture. Export makes it absent. */
  missing: Schema.Boolean,
};

export const workflowCheckpointScopeSummarySchema = Schema.Struct({
  ...scopeFields,
  fileCount: nonNegativeInteger,
});

export const workflowCheckpointScopeSchema = Schema.Struct({
  ...scopeFields,
  files: Schema.Array(workflowCheckpointFileSchema),
});

const checkpointFields = {
  checkpointId: positiveInteger,
  runId: positiveInteger,
  executionId: positiveInteger,
  /** The instance title `prepare` returned, or the node's static title, or its id. */
  title: nonEmptyString,
  commitSha: Schema.NullOr(commitShaSchema),
  createdAt: nonEmptyString,
};

export const workflowCheckpointSummarySchema = Schema.Struct({
  ...checkpointFields,
  scopes: Schema.Array(workflowCheckpointScopeSummarySchema),
});

export const workflowCheckpointSchema = Schema.Struct({
  ...checkpointFields,
  scopes: Schema.Array(workflowCheckpointScopeSchema),
});

export const workflowCheckpointRouteParamsSchema = Schema.Struct({
  checkpointId: positiveInteger,
});

export const listWorkflowCheckpointsQuerySchema = Schema.Struct({
  ...paginationQueryFields,
  /** Only checkpoints that captured a scope with this name. */
  scope: Schema.optional(queryTextSchema),
  executionId: Schema.optional(positiveInteger),
});

export const listWorkflowCheckpointsOutputSchema = pagedSchema(workflowCheckpointSummarySchema);

export const getWorkflowCheckpointOutputSchema = Schema.Struct({
  checkpoint: workflowCheckpointSchema,
});

/** A saved file's bytes, addressed by its destination-root-relative path. */
export const workflowCheckpointFileQuerySchema = Schema.Struct({ path: queryTextSchema });

/**
 * Rebuilds the checkpoint in a new folder: a detached worktree at the commit, or an empty folder
 * when there is none, with every captured scope made to match its copy exactly.
 */
export const exportWorkflowCheckpointInputSchema = Schema.Struct({
  destinationPath: nonEmptyString,
});

export const exportWorkflowCheckpointOutputSchema = Schema.Struct({
  /** The canonical absolute path the runtime wrote. */
  destinationPath: nonEmptyString,
  /** The Isagi worktree created at the commit. Null when the export is a plain folder. */
  worktreeId: Schema.NullOr(positiveInteger),
});

export type WorkflowCheckpointScopeKind = typeof workflowCheckpointScopeKindSchema.Type;
export type WorkflowCheckpointFileDto = typeof workflowCheckpointFileSchema.Type;
export type WorkflowCheckpointScopeSummaryDto = typeof workflowCheckpointScopeSummarySchema.Type;
export type WorkflowCheckpointScopeDto = typeof workflowCheckpointScopeSchema.Type;
export type WorkflowCheckpointSummaryDto = typeof workflowCheckpointSummarySchema.Type;
export type WorkflowCheckpointDto = typeof workflowCheckpointSchema.Type;
export type WorkflowCheckpointRouteParams = typeof workflowCheckpointRouteParamsSchema.Type;
export type ListWorkflowCheckpointsQuery = typeof listWorkflowCheckpointsQuerySchema.Type;
export type ListWorkflowCheckpointsOutput = typeof listWorkflowCheckpointsOutputSchema.Type;
export type GetWorkflowCheckpointOutput = typeof getWorkflowCheckpointOutputSchema.Type;
export type WorkflowCheckpointFileQuery = typeof workflowCheckpointFileQuerySchema.Type;
export type ExportWorkflowCheckpointInput = typeof exportWorkflowCheckpointInputSchema.Type;
export type ExportWorkflowCheckpointOutput = typeof exportWorkflowCheckpointOutputSchema.Type;
