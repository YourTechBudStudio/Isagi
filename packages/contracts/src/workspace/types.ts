import { Schema } from 'effect';

const positiveIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.positive());

export const projectStatusSchema = Schema.Literal('present', 'missing');
export const paneSessionKindSchema = Schema.Literal('agent_session', 'terminal_session');
export const surfaceSchema = Schema.Struct({
  id: positiveIntegerSchema,
  title: Schema.String,
  paneKinds: Schema.Array(paneSessionKindSchema),
});

export const worktreeSchema = Schema.Struct({
  id: positiveIntegerSchema,
  projectId: positiveIntegerSchema,
  title: Schema.String,
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  isRoot: Schema.Boolean,
  parked: Schema.Boolean,
  surfaces: Schema.Array(surfaceSchema),
  activeSurfaceId: Schema.NullOr(positiveIntegerSchema),
});

const projectBaseFields = {
  id: positiveIntegerSchema,
  name: Schema.String,
  rootPath: Schema.String,
  worktrees: Schema.Array(worktreeSchema),
} as const;

export const projectSchema = Schema.Union(
  Schema.Struct({
    ...projectBaseFields,
    status: Schema.Literal('present'),
    missingReason: Schema.optional(Schema.Undefined),
  }),
  Schema.Struct({
    ...projectBaseFields,
    status: Schema.Literal('missing'),
    missingReason: Schema.String.pipe(Schema.minLength(1)),
  }),
);

const activeSelectionSchema = Schema.Struct({
  projectId: positiveIntegerSchema,
  worktreeId: positiveIntegerSchema,
});

const activeProjectOnlySchema = Schema.Struct({
  projectId: positiveIntegerSchema,
  worktreeId: Schema.Null,
});

const emptyActiveContextSchema = Schema.Struct({
  projectId: Schema.Null,
  worktreeId: Schema.Null,
});

export const activeContextSchema = Schema.Union(
  activeSelectionSchema,
  activeProjectOnlySchema,
  emptyActiveContextSchema,
);

export const workspaceSnapshotSchema = Schema.Struct({
  projects: Schema.Array(projectSchema),
});

export const setActiveContextInputSchema = Schema.Union(
  activeSelectionSchema,
  emptyActiveContextSchema,
);

export const activeContextPersistenceInputSchema = Schema.Struct({
  activeContext: setActiveContextInputSchema,
  revision: Schema.Number.pipe(Schema.int(), Schema.positive()),
});

export const activeContextOutputSchema = Schema.Struct({
  activeContext: activeContextSchema,
});

export const reconcileWorkspaceInputSchema = Schema.Struct({
  projectId: Schema.NullOr(positiveIntegerSchema),
});

export const reconciliationFindingSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('project_missing'),
    projectId: positiveIntegerSchema,
    path: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('project_restored'),
    projectId: positiveIntegerSchema,
    path: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('worktree_added'),
    projectId: positiveIntegerSchema,
    worktreeId: positiveIntegerSchema,
    path: Schema.String,
    branch: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('worktree_missing'),
    projectId: positiveIntegerSchema,
    worktreeId: positiveIntegerSchema,
    path: Schema.String,
    branch: Schema.NullOr(Schema.String),
  }),
);

export const reconcileWorkspaceOutputSchema = Schema.Struct({
  findings: Schema.Array(reconciliationFindingSchema),
});

export type ProjectStatus = Schema.Schema.Type<typeof projectStatusSchema>;
export type WorkspaceSnapshot = Schema.Schema.Type<typeof workspaceSnapshotSchema>;
export type SetActiveContextInput = Schema.Schema.Type<typeof setActiveContextInputSchema>;
export type ActiveContextPersistenceInput = Schema.Schema.Type<
  typeof activeContextPersistenceInputSchema
>;
export type ActiveContextOutput = Schema.Schema.Type<typeof activeContextOutputSchema>;
export type SetActiveContextOutput = ActiveContextOutput;
export type ReconcileWorkspaceInput = Schema.Schema.Type<typeof reconcileWorkspaceInputSchema>;
export type ReconcileWorkspaceOutput = Schema.Schema.Type<typeof reconcileWorkspaceOutputSchema>;
export type ReconciliationFinding = Schema.Schema.Type<typeof reconciliationFindingSchema>;
export type Project = Schema.Schema.Type<typeof projectSchema>;
export type Worktree = Schema.Schema.Type<typeof worktreeSchema>;
export type ActiveContext = Schema.Schema.Type<typeof activeContextSchema>;
export type WorkspaceSurfaceMetadata = Schema.Schema.Type<typeof surfaceSchema>;
