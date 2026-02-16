import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { sparks } from "./schema.sparks";

export const opencodeInstances = sqliteTable(
  "opencode_instances",
  {
    id: text("id").primaryKey(),
    rootPath: text("root_path").notNull(),
    baseUrl: text("base_url").notNull(),
    port: integer("port").notNull(),
    pid: integer("pid").notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  table => [uniqueIndex("opencode_instances_root_path_idx").on(table.rootPath)],
);

export const opencodeSessions = sqliteTable(
  "opencode_sessions",
  {
    id: text("id").primaryKey(),
    opencodeInstanceId: text("opencode_instance_id")
      .notNull()
      .references(() => opencodeInstances.id, { onDelete: "cascade" }),
    opencodeSessionId: text("opencode_session_id").notNull(),
    agent: text("agent").notNull(),
    statusType: text("status_type").notNull().default("idle"),
    isWaitingOnUser: integer("is_waiting_on_user", { mode: "boolean" })
      .notNull()
      .default(false),
    lastMessageRole: text("last_message_role"),
    statusUpdatedAt: integer("status_updated_at", {
      mode: "timestamp_ms",
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  table => [
    uniqueIndex("opencode_sessions_opencode_session_id_idx").on(
      table.opencodeSessionId,
    ),
    index("opencode_sessions_agent_idx").on(table.agent),
    index("opencode_sessions_waiting_idx").on(table.isWaitingOnUser),
  ],
);

export const sparkTriage = sqliteTable(
  "spark_triage",
  {
    id: text("id").primaryKey(),
    sparkId: text("spark_id")
      .notNull()
      .references(() => sparks.id, { onDelete: "cascade" }),
    opencodeSessionId: text("opencode_session_id").notNull(),
    triagePath: text("triage_path").notNull(),
    lastValidationError: text("last_validation_error"),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  table => [
    uniqueIndex("spark_triage_spark_id_idx").on(table.sparkId),
    uniqueIndex("spark_triage_opencode_session_id_idx").on(
      table.opencodeSessionId,
    ),
    index("spark_triage_closed_at_idx").on(table.closedAt),
  ],
);
