import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    // How this project's environments are maintained. Assigned once at
    // registration and never rewritten: reconciliation, restart, relocation and
    // recovery all read it and none of them reclassifies. The SQL default exists
    // so the upgrade can backfill historical rows, every one of which has
    // Git-validated provenance. Keep it: dropping it later would make
    // drizzle-kit emit a table rebuild to remove the constraint.
    kind: text('kind', { enum: ['git', 'folder'] })
      .notNull()
      .default('git'),
    status: text('status', { enum: ['present', 'missing'] }).notNull(),
    // Durable display rank among present sibling projects. Meaningless while a
    // project is missing: restoration always appends. See the rail reordering
    // plan; the value never leaves the repository.
    sortOrder: integer('sort_order').notNull().default(0),
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
    // Durable display rank among the project's worktrees. The root worktree is
    // derived (path === project.rootPath) and pinned first at snapshot
    // composition, so its stored rank carries no meaning.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at'),
  },
  (table) => [uniqueIndex('worktrees_project_path_unique').on(table.projectId, table.path)],
);
