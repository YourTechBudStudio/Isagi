import { access } from "node:fs/promises";
import path from "node:path";

import { migrate } from "drizzle-orm/libsql/migrator";

import { db } from "./client";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

export async function runMigrations(): Promise<void> {
  try {
    await access(MIGRATIONS_DIR);
  } catch {
    throw new Error(
      `Migrations folder not found at ${MIGRATIONS_DIR}. Run \"pnpm --filter @isagi/api db:generate\" first.`,
    );
  }

  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
