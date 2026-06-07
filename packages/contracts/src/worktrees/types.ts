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

export const openWorktreeInputSchema = Schema.Struct({
  branch: Schema.String.pipe(Schema.minLength(1)),
});

export const openWorktreeOutputSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
  worktreeId: positiveIntegerSchema,
  branch: Schema.String,
});

export type ProjectWorktreeRouteParams = Schema.Schema.Type<
  typeof projectWorktreeRouteParamsSchema
>;
export type WorktreeBranch = Schema.Schema.Type<typeof worktreeBranchSchema>;
export type ListProjectBranchesOutput = Schema.Schema.Type<typeof listProjectBranchesOutputSchema>;
export type OpenWorktreeInput = Schema.Schema.Type<typeof openWorktreeInputSchema>;
export type OpenWorktreeOutput = Schema.Schema.Type<typeof openWorktreeOutputSchema>;
