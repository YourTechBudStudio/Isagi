import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { defineConfig } from "drizzle-kit";

const dataRoot =
  process.env.ISAGI_ROOT?.trim() || path.join(os.homedir(), ".isagi", "data");
const databaseUrl =
  process.env.ISAGI_DATABASE_URL?.trim() ||
  pathToFileURL(path.join(dataRoot, "isagi.db")).toString();

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./migrations",
  dialect: "turso",
  dbCredentials: {
    url: databaseUrl,
  },
});
