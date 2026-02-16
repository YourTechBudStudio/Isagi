import { contract } from "@isagi/contract/api";
import { implement, ORPCError } from "@orpc/server";
import { uuidv7 } from "uuidv7";

import { runtimeConfig } from "../../lib/config";
import { createSpark } from "../../lib/db/sparks.repository";
import {
  extractSparkTitle,
  resolveOriginalSparkPath,
  resolveSparkTriagePath,
  resolveWorkingSparkPath,
  slugifySparkTitle,
  writeSparkFile,
  writeSparkTriageFile,
} from "../../lib/sparks";
import { startSparkTriage } from "../../lib/triage-service";

const os = implement(contract.user.sparks);

export const capture = os.capture.handler(async ({ input }) => {
  let sparkId: string | undefined;
  let title: string | undefined;
  let titleSlug: string | undefined;
  let originalPath: string | undefined;
  let workingPath: string | undefined;
  let triagePath: string | undefined;

  try {
    sparkId = uuidv7();
    const createdAt = new Date();
    const text = input.text.trim();
    title = extractSparkTitle(text);
    titleSlug = slugifySparkTitle(title);

    originalPath = resolveOriginalSparkPath({
      dataRoot: runtimeConfig.dataRoot,
      sparkId,
      titleSlug,
    });
    workingPath = resolveWorkingSparkPath({
      dataRoot: runtimeConfig.dataRoot,
      sparkId,
      titleSlug,
    });
    triagePath = resolveSparkTriagePath({
      dataRoot: runtimeConfig.dataRoot,
      sparkId,
      titleSlug,
    });

    await writeSparkFile({
      filePath: originalPath,
      sparkId,
      title,
      text,
      createdAt,
    });

    await writeSparkFile({
      filePath: workingPath,
      sparkId,
      title,
      text,
      createdAt,
    });

    await writeSparkTriageFile(triagePath);

    await createSpark({
      id: sparkId,
      title,
      path: workingPath,
      originalPath,
      workingPath,
      triagePath,
      createdAt,
    });

    void startSparkTriage(sparkId).catch(error => {
      console.error("Failed to start spark triage", {
        sparkId,
        title,
        error,
      });
    });

    return { sparkId, title };
  } catch (error) {
    console.error("oRPC user.sparks.capture failed", {
      sparkId,
      title,
      titleSlug,
      originalPath,
      workingPath,
      triagePath,
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
