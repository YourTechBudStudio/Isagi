import { contract } from "@isagi/contract/api";
import { implement } from "@orpc/server";
import { uuidv7 } from "uuidv7";

import { runtimeConfig } from "../../lib/config";
import { db } from "../../lib/db/client";
import { sparks } from "../../lib/db/schema";
import { createSparkTitle, writeSparkFile } from "../../lib/sparks";

const os = implement(contract.user.sparks);

export const capture = os.capture.handler(async ({ input }) => {
  const sparkId = uuidv7();
  const createdAt = new Date();
  const text = input.text.trim();
  const title = createSparkTitle(text);

  const filePath = await writeSparkFile({
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
});
