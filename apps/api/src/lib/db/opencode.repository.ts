import { and, desc, eq, isNull } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

import { db } from "./client";
import { opencodeInstances, opencodeSessions, sparkTriage } from "./schema";

export async function getOpencodeInstanceByRootPath(
  rootPath: string,
): Promise<typeof opencodeInstances.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(opencodeInstances)
    .where(eq(opencodeInstances.rootPath, rootPath))
    .limit(1);

  return rows[0];
}

export async function getOpencodeInstanceById(
  id: string,
): Promise<typeof opencodeInstances.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(opencodeInstances)
    .where(eq(opencodeInstances.id, id))
    .limit(1);

  return rows[0];
}

export async function upsertOpencodeInstance(input: {
  rootPath: string;
  baseUrl: string;
  port: number;
  pid: number;
  seenAt: Date;
}): Promise<typeof opencodeInstances.$inferSelect> {
  const existing = await getOpencodeInstanceByRootPath(input.rootPath);
  const now = input.seenAt;

  if (existing) {
    await db
      .update(opencodeInstances)
      .set({
        baseUrl: input.baseUrl,
        port: input.port,
        pid: input.pid,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(opencodeInstances.id, existing.id));

    return {
      ...existing,
      baseUrl: input.baseUrl,
      port: input.port,
      pid: input.pid,
      lastSeenAt: now,
      updatedAt: now,
    };
  }

  const row: typeof opencodeInstances.$inferSelect = {
    id: uuidv7(),
    rootPath: input.rootPath,
    baseUrl: input.baseUrl,
    port: input.port,
    pid: input.pid,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(opencodeInstances).values(row);
  return row;
}

export async function touchOpencodeInstance(
  instanceId: string,
  seenAt: Date,
): Promise<void> {
  await db
    .update(opencodeInstances)
    .set({
      lastSeenAt: seenAt,
      updatedAt: seenAt,
    })
    .where(eq(opencodeInstances.id, instanceId));
}

export async function createOpencodeSession(input: {
  opencodeInstanceId: string;
  opencodeSessionId: string;
  agent: string;
  createdAt: Date;
}): Promise<typeof opencodeSessions.$inferSelect> {
  const row: typeof opencodeSessions.$inferSelect = {
    id: uuidv7(),
    opencodeInstanceId: input.opencodeInstanceId,
    opencodeSessionId: input.opencodeSessionId,
    agent: input.agent,
    statusType: "idle",
    isWaitingOnUser: false,
    lastMessageRole: null,
    statusUpdatedAt: input.createdAt,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };

  await db.insert(opencodeSessions).values(row);
  return row;
}

export async function findOpencodeSessionByExternalId(
  opencodeSessionId: string,
): Promise<typeof opencodeSessions.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(opencodeSessions)
    .where(eq(opencodeSessions.opencodeSessionId, opencodeSessionId))
    .limit(1);

  return rows[0];
}

export async function setOpencodeSessionStatus(input: {
  opencodeSessionId: string;
  statusType: "idle" | "busy" | "retry";
  statusUpdatedAt: Date;
  waitingOnUser: boolean;
}): Promise<void> {
  await db
    .update(opencodeSessions)
    .set({
      statusType: input.statusType,
      isWaitingOnUser: input.waitingOnUser,
      statusUpdatedAt: input.statusUpdatedAt,
      updatedAt: input.statusUpdatedAt,
    })
    .where(eq(opencodeSessions.opencodeSessionId, input.opencodeSessionId));
}

export async function setOpencodeSessionLastMessageRole(input: {
  opencodeSessionId: string;
  role: "user" | "assistant";
  updatedAt: Date;
}): Promise<void> {
  await db
    .update(opencodeSessions)
    .set({
      lastMessageRole: input.role,
      updatedAt: input.updatedAt,
    })
    .where(eq(opencodeSessions.opencodeSessionId, input.opencodeSessionId));
}

export async function createSparkTriage(input: {
  sparkId: string;
  opencodeSessionId: string;
  triagePath: string;
  createdAt: Date;
}): Promise<typeof sparkTriage.$inferSelect> {
  const row: typeof sparkTriage.$inferSelect = {
    id: uuidv7(),
    sparkId: input.sparkId,
    opencodeSessionId: input.opencodeSessionId,
    triagePath: input.triagePath,
    lastValidationError: null,
    closedAt: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };

  await db.insert(sparkTriage).values(row);
  return row;
}

export async function getSparkTriageBySparkId(
  sparkId: string,
): Promise<typeof sparkTriage.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(sparkTriage)
    .where(eq(sparkTriage.sparkId, sparkId))
    .limit(1);

  return rows[0];
}

export async function getSparkTriageBySessionId(
  opencodeSessionId: string,
): Promise<typeof sparkTriage.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(sparkTriage)
    .where(eq(sparkTriage.opencodeSessionId, opencodeSessionId))
    .limit(1);

  return rows[0];
}

export async function setSparkTriageValidationError(input: {
  sparkId: string;
  error: string | null;
  updatedAt: Date;
}): Promise<void> {
  await db
    .update(sparkTriage)
    .set({
      lastValidationError: input.error,
      updatedAt: input.updatedAt,
    })
    .where(eq(sparkTriage.sparkId, input.sparkId));
}

export async function closeSparkTriage(
  sparkId: string,
  closedAt: Date,
): Promise<void> {
  await db
    .update(sparkTriage)
    .set({
      closedAt,
      updatedAt: closedAt,
    })
    .where(eq(sparkTriage.sparkId, sparkId));
}

export async function listOpenTriage(): Promise<
  Array<
    typeof sparkTriage.$inferSelect & {
      session: typeof opencodeSessions.$inferSelect;
    }
  >
> {
  const rows = await db
    .select({ triage: sparkTriage, session: opencodeSessions })
    .from(sparkTriage)
    .innerJoin(
      opencodeSessions,
      eq(sparkTriage.opencodeSessionId, opencodeSessions.opencodeSessionId),
    )
    .where(
      and(eq(opencodeSessions.agent, "triage"), isNull(sparkTriage.closedAt)),
    )
    .orderBy(desc(opencodeSessions.updatedAt));

  return rows.map(row => ({ ...row.triage, session: row.session }));
}
