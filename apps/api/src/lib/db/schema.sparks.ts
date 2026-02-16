import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sparks = sqliteTable("sparks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  path: text("path").notNull(),
  originalPath: text("original_path"),
  workingPath: text("working_path"),
  triagePath: text("triage_path"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
