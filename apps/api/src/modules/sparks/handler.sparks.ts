import { contract } from "@isagi/contract/api";
import { implement, ORPCError } from "@orpc/server";
import { uuidv7 } from "uuidv7";

import { runtimeConfig } from "../../lib/config";
import { db } from "../../lib/db/client";
import { sparks } from "../../lib/db/schema";
import { extractSparkTitle, writeSparkFile } from "../../lib/sparks";

const os = implement(contract.user.sparks);

export const capture = os.capture.handler(async ({ input }) => {
  let sparkId: string | undefined;
  let extractedTitle: string | undefined;
  let title: string | undefined;
  let filePath: string | undefined;

  try {
    sparkId = uuidv7();
    const createdAt = new Date();
    const text = input.text.trim();
    title = extractSparkTitle(text);

    filePath = await writeSparkFile({
      dataRoot: runtimeConfig.dataRoot,
      sparkId,
      title,
      text,
      createdAt,
    });

    await db.insert(sparks).values({
      id: sparkId,
      title,
      path: filePath,
      createdAt,
    });

    return { sparkId, title };
  } catch (error) {
    console.error("oRPC user.sparks.capture failed", {
      sparkId,
      extractedTitle,
      title,
      filePath,
      dataRoot: runtimeConfig.dataRoot,
      textLength: input.text.length,
      error,
    });

    if (error instanceof ORPCError) {
      throw error;
    }

    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to capture spark",
    });
  }
});
