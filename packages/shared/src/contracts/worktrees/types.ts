import { Schema } from 'effect';

import { positiveInteger } from '../scalars.js';

export const projectWorktreeRouteParamsSchema = Schema.Struct({
  projectId: positiveInteger,
});

export const worktreeRouteParamsSchema = Schema.Struct({
  projectId: positiveInteger,
  worktreeId: positiveInteger,
});

export const worktreeBranchSchema = Schema.Struct({
  name: Schema.String,
  worktreeId: Schema.NullOr(positiveInteger),
});

export const listProjectBranchesOutputSchema = Schema.Struct({
  branches: Schema.Array(worktreeBranchSchema),
});

export const worktreeBaseRefSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('branch'),
    ref: Schema.String.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal('detached_worktree'),
    worktreeId: positiveInteger,
  }),
  // An already-resolved commit. A caller that resolved a ref itself branches from the commit it
  // actually saw, rather than re-resolving a moving ref and silently branching from somewhere else.
  // Caller-supplied and crossing a trust boundary, so the shape is validated here.
  Schema.Struct({
    kind: Schema.Literal('commit'),
    commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  }),
]);

/**
 * Why a destination cannot hold a new worktree. One vocabulary for every place the rule is checked:
 * the runtime's detached creation, the rejection it reports, and a client's own precheck.
 */
export const worktreeDestinationIssueSchema = Schema.Literals([
  /** The runtime requires an absolute path. */
  'not_absolute',
  /** It exists and has entries. */
  'not_empty',
  /** It exists and is a file, a symlink or something else that is not a directory. */
  'not_directory',
  /** It is equal to, or inside, a project root or worktree Isagi knows. */
  'inside_checkout',
  /** It cannot be inspected, or its parent cannot be created. */
  'inaccessible',
]);

export const openWorktreeInputSchema = Schema.Struct({
  branch: Schema.String.check(Schema.isMinLength(1)),
  base: Schema.optional(worktreeBaseRefSchema),
  /**
   * `open` (default) adopts an existing worktree or branch; `create_new` refuses both. A caller that
   * has already decided it is creating something wants the collision reported, not absorbed into a
   * silent reuse of somebody else's checkout.
   */
  mode: Schema.optional(Schema.Literals(['open', 'create_new'])),
});

export const checkoutRemovalModeSchema = Schema.Literals(['normal', 'force']);

export const branchRemovalModeSchema = Schema.Literals(['preserve', 'delete_if_safe']);

export const deleteWorktreePreflightOutputSchema = Schema.Struct({
  projectId: positiveInteger,
  worktreeId: positiveInteger,
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
  isRoot: Schema.Boolean,
  dirty: Schema.Boolean,
});

// `checkoutRemovalMode: "force"` applies only to `git worktree remove --force`.
// It deliberately does not force branch deletion; branch cleanup only supports
// safe deletion through `branchRemovalMode: "delete_if_safe"`.
export const deleteWorktreeInputSchema = Schema.Struct({
  checkoutRemovalMode: checkoutRemovalModeSchema,
  branchRemovalMode: branchRemovalModeSchema,
});

export const worktreeBranchRemovalSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('not_requested'),
  }),
  Schema.Struct({
    status: Schema.Literal('not_applicable'),
  }),
  Schema.Struct({
    status: Schema.Literal('deleted'),
    branch: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal('failed'),
    branch: Schema.String,
    diagnostic: Schema.String,
  }),
]);

export const deleteWorktreeOutputSchema = Schema.Struct({
  projectId: positiveInteger,
  deletedWorktreeId: positiveInteger,
  selectedWorktreeId: positiveInteger,
  branchRemoval: worktreeBranchRemovalSchema,
});

/** A one-member set: `Literals` keeps `.literals` so the set can grow without changing its shape. */
export const worktreeSetupLifecycleSchema = Schema.Literals(['post_create']);

export const worktreeSetupHookTypeSchema = Schema.Literals(['copy', 'symlink', 'command']);

export const worktreeSetupSummarySchema = Schema.Struct({
  index: positiveInteger,
  type: worktreeSetupHookTypeSchema,
  label: Schema.String,
  detail: Schema.optional(Schema.String),
  envKeys: Schema.optional(Schema.Array(Schema.String)),
});

export const worktreeSetupPreflightStatusSchema = Schema.Literals([
  'not_configured',
  'trusted',
  'always_trusted',
  'disabled',
  'needs_approval',
]);

export const worktreeSetupPreflightOutputSchema = Schema.Struct({
  projectId: positiveInteger,
  status: worktreeSetupPreflightStatusSchema,
  hash: Schema.optional(Schema.String),
  summary: Schema.Array(worktreeSetupSummarySchema),
});

export const worktreeSetupTrustInputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal('trust_hook_config'),
    hash: Schema.String.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    action: Schema.Literal('always_trust_project'),
    hash: Schema.String.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    action: Schema.Literal('disable_hooks'),
  }),
]);

export const worktreeSetupTrustOutputSchema = Schema.Struct({
  projectId: positiveInteger,
  status: worktreeSetupPreflightStatusSchema,
  hash: Schema.optional(Schema.String),
});

// Single source of truth for each setup-status shape. Both worktreeSetupResult
// (the runner's return) and openWorktreeOutput (the wire response that spreads
// it) compose these same structs, so a field only ever needs adding in one
// place — without this, a field added to one copy and missed in the other would
// pass `satisfies` and then be silently dropped by the encoder.
const worktreeSetupNotRunSchema = Schema.Struct({
  status: Schema.Literal('not_run'),
  reason: Schema.Literal('existing_worktree'),
});

const worktreeSetupSkippedSchema = Schema.Struct({
  status: Schema.Literal('skipped'),
  reason: Schema.Literals(['not_configured', 'hooks_disabled']),
});

const worktreeSetupSucceededSchema = Schema.Struct({
  status: Schema.Literal('succeeded'),
  runId: positiveInteger,
});

const worktreeSetupFailedSchema = Schema.Struct({
  status: Schema.Literal('failed'),
  runId: positiveInteger,
  failedHookIndex: positiveInteger,
  failedHookType: worktreeSetupHookTypeSchema,
  message: Schema.String,
  command: Schema.optional(Schema.String),
  src: Schema.optional(Schema.String),
  dest: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number.check(Schema.isInt()))),
  signal: Schema.optional(Schema.NullOr(Schema.String)),
  outputExcerpt: Schema.optional(Schema.String),
});

export const worktreeSetupResultSchema = Schema.Union([
  worktreeSetupNotRunSchema,
  worktreeSetupSkippedSchema,
  worktreeSetupSucceededSchema,
  worktreeSetupFailedSchema,
]);

export const openWorktreeStatusSchema = Schema.Literals([
  'opened_existing',
  'created',
  'created_setup_failed',
]);

export const openWorktreeOutputSchema = Schema.Union([
  Schema.Struct({
    projectId: positiveInteger,
    worktreeId: positiveInteger,
    branch: Schema.String,
    status: Schema.Literal('opened_existing'),
    setup: worktreeSetupNotRunSchema,
  }),
  Schema.Struct({
    projectId: positiveInteger,
    worktreeId: positiveInteger,
    branch: Schema.String,
    status: Schema.Literal('created'),
    setup: Schema.Union([worktreeSetupSkippedSchema, worktreeSetupSucceededSchema]),
  }),
  Schema.Struct({
    projectId: positiveInteger,
    worktreeId: positiveInteger,
    branch: Schema.String,
    status: Schema.Literal('created_setup_failed'),
    setup: worktreeSetupFailedSchema,
  }),
]);

/**
 * One bounded move within a single project's non-root worktrees. `null` appends
 * after the last non-root sibling. The root worktree is never a legal source or
 * anchor, so this shape cannot express placing a worktree above it.
 */
export const moveWorktreeOrderInputSchema = Schema.Struct({
  beforeWorktreeId: Schema.NullOr(positiveInteger),
});

export const moveWorktreeOrderOutputSchema = Schema.Struct({
  projectId: positiveInteger,
  worktreeId: positiveInteger,
});

export type ProjectWorktreeRouteParams = typeof projectWorktreeRouteParamsSchema.Type;
export type MoveWorktreeOrderInput = typeof moveWorktreeOrderInputSchema.Type;
export type MoveWorktreeOrderOutput = typeof moveWorktreeOrderOutputSchema.Type;
export type WorktreeRouteParams = typeof worktreeRouteParamsSchema.Type;
export type WorktreeBranch = typeof worktreeBranchSchema.Type;
export type ListProjectBranchesOutput = typeof listProjectBranchesOutputSchema.Type;
export type WorktreeBaseRef = typeof worktreeBaseRefSchema.Type;
export type WorktreeDestinationIssue = typeof worktreeDestinationIssueSchema.Type;
export type OpenWorktreeInput = typeof openWorktreeInputSchema.Type;
export type CheckoutRemovalMode = typeof checkoutRemovalModeSchema.Type;
export type BranchRemovalMode = typeof branchRemovalModeSchema.Type;
export type DeleteWorktreePreflightOutput = typeof deleteWorktreePreflightOutputSchema.Type;
export type DeleteWorktreeInput = typeof deleteWorktreeInputSchema.Type;
export type WorktreeBranchRemoval = typeof worktreeBranchRemovalSchema.Type;
export type DeleteWorktreeOutput = typeof deleteWorktreeOutputSchema.Type;
export type WorktreeSetupLifecycle = typeof worktreeSetupLifecycleSchema.Type;
export type WorktreeSetupHookType = typeof worktreeSetupHookTypeSchema.Type;
export type WorktreeSetupSummary = typeof worktreeSetupSummarySchema.Type;
export type WorktreeSetupPreflightStatus = typeof worktreeSetupPreflightStatusSchema.Type;
export type WorktreeSetupPreflightOutput = typeof worktreeSetupPreflightOutputSchema.Type;
export type WorktreeSetupTrustInput = typeof worktreeSetupTrustInputSchema.Type;
export type WorktreeSetupTrustOutput = typeof worktreeSetupTrustOutputSchema.Type;
export type WorktreeSetupResult = typeof worktreeSetupResultSchema.Type;
export type OpenWorktreeStatus = typeof openWorktreeStatusSchema.Type;
export type OpenWorktreeOutput = typeof openWorktreeOutputSchema.Type;
