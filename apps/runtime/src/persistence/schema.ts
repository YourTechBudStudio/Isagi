import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    status: text('status', { enum: ['present', 'missing'] }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastSeenAt: text('last_seen_at'),
    missingReason: text('missing_reason'),
  },
  (table) => [uniqueIndex('projects_root_path_unique').on(table.rootPath)],
);

export const worktrees = sqliteTable(
  'worktrees',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    branch: text('branch'),
    head: text('head'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at'),
  },
  (table) => [uniqueIndex('worktrees_project_path_unique').on(table.projectId, table.path)],
);
