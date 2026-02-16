import { desc, eq } from "drizzle-orm";

import { db } from "./client";
import { sparks } from "./schema";

export async function createSpark(input: {
  id: string;
  title: string;
  path: string;
  originalPath: string;
  workingPath: string;
  triagePath: string;
  createdAt: Date;
}): Promise<typeof sparks.$inferSelect> {
  const row: typeof sparks.$inferSelect = {
    id: input.id,
    title: input.title,
    path: input.path,
    originalPath: input.originalPath,
    workingPath: input.workingPath,
    triagePath: input.triagePath,
    createdAt: input.createdAt,
  };

  await db.insert(sparks).values(row);
  return row;
}

export async function getSparkById(
  sparkId: string,
): Promise<typeof sparks.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(sparks)
    .where(eq(sparks.id, sparkId))
    .limit(1);

  return rows[0];
}

export async function listSparks(
  limit = 50,
): Promise<Array<typeof sparks.$inferSelect>> {
  return db.select().from(sparks).orderBy(desc(sparks.createdAt)).limit(limit);
}
