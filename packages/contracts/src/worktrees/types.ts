import { Schema } from 'effect';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const projectWorktreeRouteParamsSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
});

export const worktreeRouteParamsSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
  worktreeId: positiveIntegerSchema,
});

export const worktreeBranchSchema = Schema.Struct({
  name: Schema.String,
  worktreeId: Schema.NullOr(positiveIntegerSchema),
});

export const listProjectBranchesOutputSchema = Schema.Struct({
  branches: Schema.Array(worktreeBranchSchema),
});

export const worktreeBaseRefSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('branch'),
    ref: Schema.String.pipe(Schema.minLength(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal('detached_worktree'),
    worktreeId: positiveIntegerSchema,
  }),
);

export const openWorktreeInputSchema = Schema.Struct({
  branch: Schema.String.pipe(Schema.minLength(1)),
  base: Schema.optional(worktreeBaseRefSchema),
});

export const checkoutRemovalModeSchema = Schema.Literal('normal', 'force');

export const branchRemovalModeSchema = Schema.Literal('preserve', 'delete_if_safe');

export const deleteWorktreePreflightOutputSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
  worktreeId: positiveIntegerSchema,
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

export const worktreeBranchRemovalSchema = Schema.Union(
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
);

export const deleteWorktreeOutputSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
  deletedWorktreeId: positiveIntegerSchema,
  selectedWorktreeId: positiveIntegerSchema,
  branchRemoval: worktreeBranchRemovalSchema,
});

export const worktreeSetupLifecycleSchema = Schema.Literal('post_create');

export const worktreeSetupHookTypeSchema = Schema.Literal('copy', 'symlink', 'command');

export const worktreeSetupSummarySchema = Schema.Struct({
  index: positiveIntegerSchema,
  type: worktreeSetupHookTypeSchema,
  label: Schema.String,
  detail: Schema.optional(Schema.String),
  envKeys: Schema.optional(Schema.Array(Schema.String)),
});

export const worktreeSetupPreflightStatusSchema = Schema.Literal(
  'not_configured',
  'trusted',
  'always_trusted',
  'disabled',
  'needs_approval',
);

export const worktreeSetupPreflightOutputSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
  status: worktreeSetupPreflightStatusSchema,
  hash: Schema.optional(Schema.String),
  summary: Schema.Array(worktreeSetupSummarySchema),
});

export const worktreeSetupTrustInputSchema = Schema.Union(
  Schema.Struct({
    action: Schema.Literal('trust_hook_config'),
    hash: Schema.String.pipe(Schema.minLength(1)),
  }),
  Schema.Struct({
    action: Schema.Literal('always_trust_project'),
    hash: Schema.String.pipe(Schema.minLength(1)),
  }),
  Schema.Struct({
    action: Schema.Literal('disable_hooks'),
  }),
);

export const worktreeSetupTrustOutputSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
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
  reason: Schema.Literal('not_configured', 'hooks_disabled'),
});

const worktreeSetupSucceededSchema = Schema.Struct({
  status: Schema.Literal('succeeded'),
  runId: positiveIntegerSchema,
});

const worktreeSetupFailedSchema = Schema.Struct({
  status: Schema.Literal('failed'),
  runId: positiveIntegerSchema,
  failedHookIndex: positiveIntegerSchema,
  failedHookType: worktreeSetupHookTypeSchema,
  message: Schema.String,
  command: Schema.optional(Schema.String),
  src: Schema.optional(Schema.String),
  dest: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number.pipe(Schema.int()))),
  signal: Schema.optional(Schema.NullOr(Schema.String)),
  outputExcerpt: Schema.optional(Schema.String),
});

export const worktreeSetupResultSchema = Schema.Union(
  worktreeSetupNotRunSchema,
  worktreeSetupSkippedSchema,
  worktreeSetupSucceededSchema,
  worktreeSetupFailedSchema,
);

export const openWorktreeStatusSchema = Schema.Literal(
  'opened_existing',
  'created',
  'created_setup_failed',
);

export const openWorktreeOutputSchema = Schema.Union(
  Schema.Struct({
    projectId: positiveIntegerSchema,
    worktreeId: positiveIntegerSchema,
    branch: Schema.String,
    status: Schema.Literal('opened_existing'),
    setup: worktreeSetupNotRunSchema,
  }),
  Schema.Struct({
    projectId: positiveIntegerSchema,
    worktreeId: positiveIntegerSchema,
    branch: Schema.String,
    status: Schema.Literal('created'),
    setup: Schema.Union(worktreeSetupSkippedSchema, worktreeSetupSucceededSchema),
  }),
  Schema.Struct({
    projectId: positiveIntegerSchema,
    worktreeId: positiveIntegerSchema,
    branch: Schema.String,
    status: Schema.Literal('created_setup_failed'),
    setup: worktreeSetupFailedSchema,
  }),
);

export type ProjectWorktreeRouteParams = Schema.Schema.Type<
  typeof projectWorktreeRouteParamsSchema
>;
export type WorktreeRouteParams = Schema.Schema.Type<typeof worktreeRouteParamsSchema>;
export type WorktreeBranch = Schema.Schema.Type<typeof worktreeBranchSchema>;
export type ListProjectBranchesOutput = Schema.Schema.Type<typeof listProjectBranchesOutputSchema>;
export type WorktreeBaseRef = Schema.Schema.Type<typeof worktreeBaseRefSchema>;
export type OpenWorktreeInput = Schema.Schema.Type<typeof openWorktreeInputSchema>;
export type CheckoutRemovalMode = Schema.Schema.Type<typeof checkoutRemovalModeSchema>;
export type BranchRemovalMode = Schema.Schema.Type<typeof branchRemovalModeSchema>;
export type DeleteWorktreePreflightOutput = Schema.Schema.Type<
  typeof deleteWorktreePreflightOutputSchema
>;
export type DeleteWorktreeInput = Schema.Schema.Type<typeof deleteWorktreeInputSchema>;
export type WorktreeBranchRemoval = Schema.Schema.Type<typeof worktreeBranchRemovalSchema>;
export type DeleteWorktreeOutput = Schema.Schema.Type<typeof deleteWorktreeOutputSchema>;
export type WorktreeSetupLifecycle = Schema.Schema.Type<typeof worktreeSetupLifecycleSchema>;
export type WorktreeSetupHookType = Schema.Schema.Type<typeof worktreeSetupHookTypeSchema>;
export type WorktreeSetupSummary = Schema.Schema.Type<typeof worktreeSetupSummarySchema>;
export type WorktreeSetupPreflightStatus = Schema.Schema.Type<
  typeof worktreeSetupPreflightStatusSchema
>;
export type WorktreeSetupPreflightOutput = Schema.Schema.Type<
  typeof worktreeSetupPreflightOutputSchema
>;
export type WorktreeSetupTrustInput = Schema.Schema.Type<typeof worktreeSetupTrustInputSchema>;
export type WorktreeSetupTrustOutput = Schema.Schema.Type<typeof worktreeSetupTrustOutputSchema>;
export type WorktreeSetupResult = Schema.Schema.Type<typeof worktreeSetupResultSchema>;
export type OpenWorktreeStatus = Schema.Schema.Type<typeof openWorktreeStatusSchema>;
export type OpenWorktreeOutput = Schema.Schema.Type<typeof openWorktreeOutputSchema>;
