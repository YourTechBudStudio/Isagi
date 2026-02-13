import { sql } from "drizzle-orm";

import { db } from "./client";

export async function ensureDatabaseReady(): Promise<void> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS sparks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}
