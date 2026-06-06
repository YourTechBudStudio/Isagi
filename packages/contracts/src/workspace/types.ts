import { z } from 'zod';

export const attentionStateSchema = z.enum(['idle', 'working', 'waiting', 'error']);
export const projectStatusSchema = z.enum(['present', 'missing']);
export const surfaceSchema = z.object({
  id: z.string(),
  kind: z.enum(['agent', 'terminal', 'browser', 'editor', 'artifact']),
  title: z.string(),
  attention: attentionStateSchema.optional(),
  source: z.string().optional(),
});

export const commandSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['running', 'stopped', 'exited']),
  attention: attentionStateSchema,
  ports: z.array(z.number().int().nonnegative()),
  log: z.array(z.string()),
});

export const worktreeSchema = z.object({
  id: z.number().int().positive(),
  projectId: z.number().int().positive(),
  title: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  isRoot: z.boolean(),
  attention: attentionStateSchema,
  parked: z.boolean(),
  surfaces: z.array(surfaceSchema),
  activeSurfaceId: z.string().nullable(),
  commands: z.array(commandSchema),
});

const projectBaseSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  rootPath: z.string(),
  worktrees: z.array(worktreeSchema),
});

export const projectSchema = z.discriminatedUnion('status', [
  projectBaseSchema.extend({
    status: z.literal('present'),
    missingReason: z.undefined().optional(),
  }),
  projectBaseSchema.extend({
    status: z.literal('missing'),
    missingReason: z.string().min(1),
  }),
]);

const activeSelectionSchema = z.object({
  projectId: z.number().int().positive(),
  worktreeId: z.number().int().positive(),
});

const emptyActiveContextSchema = z.object({
  projectId: z.null(),
  worktreeId: z.null(),
});

export const activeContextSchema = z.union([activeSelectionSchema, emptyActiveContextSchema]);

export const workspaceSnapshotSchema = z.object({
  projects: z.array(projectSchema),
  activeContext: activeContextSchema,
});

export const setActiveContextInputSchema = z.object({
  worktreeId: z.number().int().positive(),
});

export const addProjectInputSchema = z.object({
  path: z.string().min(1),
});

export type AttentionState = z.infer<typeof attentionStateSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Worktree = z.infer<typeof worktreeSchema>;
export type ActiveContext = z.infer<typeof activeContextSchema>;
