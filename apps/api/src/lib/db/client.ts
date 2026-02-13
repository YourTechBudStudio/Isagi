import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { runtimeConfig } from "../config";
import * as schema from "./schema";

const client = createClient({
  url: runtimeConfig.databaseUrl,
  authToken: runtimeConfig.databaseAuthToken,
});

export const db = drizzle(client, { schema });

export async function closeDb(): Promise<void> {
  await client.close();
}
