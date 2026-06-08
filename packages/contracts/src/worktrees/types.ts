import { Schema } from 'effect';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const projectWorktreeRouteParamsSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
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

export const worktreeSetupResultSchema = Schema.Union(
  Schema.Struct({
    status: Schema.Literal('not_run'),
    reason: Schema.Literal('existing_worktree'),
  }),
  Schema.Struct({
    status: Schema.Literal('skipped'),
    reason: Schema.Literal('not_configured', 'hooks_disabled'),
  }),
  Schema.Struct({
    status: Schema.Literal('succeeded'),
    runId: positiveIntegerSchema,
  }),
  Schema.Struct({
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
    stdoutExcerpt: Schema.optional(Schema.String),
    stderrExcerpt: Schema.optional(Schema.String),
  }),
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
    setup: Schema.Struct({
      status: Schema.Literal('not_run'),
      reason: Schema.Literal('existing_worktree'),
    }),
  }),
  Schema.Struct({
    projectId: positiveIntegerSchema,
    worktreeId: positiveIntegerSchema,
    branch: Schema.String,
    status: Schema.Literal('created'),
    setup: Schema.Union(
      Schema.Struct({
        status: Schema.Literal('skipped'),
        reason: Schema.Literal('not_configured', 'hooks_disabled'),
      }),
      Schema.Struct({
        status: Schema.Literal('succeeded'),
        runId: positiveIntegerSchema,
      }),
    ),
  }),
  Schema.Struct({
    projectId: positiveIntegerSchema,
    worktreeId: positiveIntegerSchema,
    branch: Schema.String,
    status: Schema.Literal('created_setup_failed'),
    setup: Schema.Struct({
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
      stdoutExcerpt: Schema.optional(Schema.String),
      stderrExcerpt: Schema.optional(Schema.String),
    }),
  }),
);

export type ProjectWorktreeRouteParams = Schema.Schema.Type<
  typeof projectWorktreeRouteParamsSchema
>;
export type WorktreeBranch = Schema.Schema.Type<typeof worktreeBranchSchema>;
export type ListProjectBranchesOutput = Schema.Schema.Type<typeof listProjectBranchesOutputSchema>;
export type WorktreeBaseRef = Schema.Schema.Type<typeof worktreeBaseRefSchema>;
export type OpenWorktreeInput = Schema.Schema.Type<typeof openWorktreeInputSchema>;
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
