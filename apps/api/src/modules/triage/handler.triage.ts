import { contract } from "@isagi/contract/api";
import { implement, ORPCError } from "@orpc/server";

import {
  closeSparkTriage,
  findOpencodeSessionByExternalId,
  getOpencodeInstanceById,
  getSparkTriageBySparkId,
  listOpenTriage,
} from "../../lib/db/opencode.repository";
import { getSparkById } from "../../lib/db/sparks.repository";
import { getOpencodeClient } from "../../lib/opencode";
import {
  applyAndCloseTriageFile,
  readAndValidateTriageFile,
} from "../../lib/triage";

const os = implement(contract.user.triage);

export const list = os.list.handler(async () => {
  try {
    const rows = await listOpenTriage();

    const result = await Promise.all(
      rows.map(async row => {
        const spark = await getSparkById(row.sparkId);
        if (!spark) {
          throw new ORPCError("NOT_FOUND", {
            message: `Spark missing for triage ${row.sparkId}`,
          });
        }

        return {
          sparkId: row.sparkId,
          sparkTitle: spark.title,
          opencodeSessionId: row.opencodeSessionId,
          statusType: row.session.statusType as "idle" | "busy" | "retry",
          waitingOnUser: row.session.isWaitingOnUser,
          closedAt: row.closedAt ? row.closedAt.getTime() : null,
          updatedAt: row.updatedAt.getTime(),
          lastValidationError: row.lastValidationError,
        };
      }),
    );

    return result;
  } catch (error) {
    console.error("oRPC user.triage.list failed", { error });
    if (error instanceof ORPCError) {
      throw error;
    }

    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to list triage items",
    });
  }
});

export const state = os.state.handler(async ({ input }) => {
  try {
    const triage = await getSparkTriageBySparkId(input.sparkId);
    if (!triage) {
      throw new ORPCError("NOT_FOUND", {
        message: `Triage state not found for spark ${input.sparkId}`,
      });
    }

    const validation = await readAndValidateTriageFile(triage.triagePath);
    return {
      sparkId: input.sparkId,
      opencodeSessionId: triage.opencodeSessionId,
      triagePath: triage.triagePath,
      rawYaml: validation.raw,
      parsed: validation.parsed,
      validationError: validation.error,
    };
  } catch (error) {
    console.error("oRPC user.triage.state failed", {
      sparkId: input.sparkId,
      error,
    });
    if (error instanceof ORPCError) {
      throw error;
    }

    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to load triage state",
    });
  }
});

export const send = os.send.handler(async ({ input }) => {
  try {
    const triage = await getSparkTriageBySparkId(input.sparkId);
    if (!triage) {
      throw new ORPCError("NOT_FOUND", {
        message: `Triage session not found for spark ${input.sparkId}`,
      });
    }

    if (triage.closedAt) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Triage conversation is already closed",
      });
    }

    const session = await findOpencodeSessionByExternalId(
      triage.opencodeSessionId,
    );
    if (!session) {
      throw new ORPCError("NOT_FOUND", {
        message: `OpenCode session missing for spark ${input.sparkId}`,
      });
    }

    const instance = await getOpencodeInstanceById(session.opencodeInstanceId);
    if (!instance) {
      throw new ORPCError("NOT_FOUND", {
        message: "OpenCode instance not found",
      });
    }

    const client = getOpencodeClient({
      baseUrl: instance.baseUrl,
      rootPath: instance.rootPath,
    });

    await client.session.promptAsync({
      sessionID: session.opencodeSessionId,
      parts: [
        {
          type: "text",
          text: input.text,
        },
      ],
    });

    return { accepted: true };
  } catch (error) {
    console.error("oRPC user.triage.send failed", {
      sparkId: input.sparkId,
      error,
    });

    if (error instanceof ORPCError) {
      throw error;
    }

    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to send triage message",
    });
  }
});

export const apply = os.apply.handler(async ({ input }) => {
  try {
    const triage = await getSparkTriageBySparkId(input.sparkId);
    if (!triage) {
      throw new ORPCError("NOT_FOUND", {
        message: `Triage state not found for spark ${input.sparkId}`,
      });
    }

    const applied = await applyAndCloseTriageFile(triage.triagePath);
    if (applied.error) {
      return {
        sparkId: input.sparkId,
        status: "closed" as const,
        validationError: applied.error,
      };
    }

    await closeSparkTriage(input.sparkId, new Date());
    return {
      sparkId: input.sparkId,
      status: "closed" as const,
      validationError: null,
    };
  } catch (error) {
    console.error("oRPC user.triage.apply failed", {
      sparkId: input.sparkId,
      error,
    });

    if (error instanceof ORPCError) {
      throw error;
    }

    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to apply triage state",
    });
  }
});

export const messages = os.messages.handler(async ({ input }) => {
  try {
    const triage = await getSparkTriageBySparkId(input.sparkId);
    if (!triage) {
      throw new ORPCError("NOT_FOUND", {
        message: `Triage session not found for spark ${input.sparkId}`,
      });
    }

    const session = await findOpencodeSessionByExternalId(
      triage.opencodeSessionId,
    );
    if (!session) {
      throw new ORPCError("NOT_FOUND", {
        message: `OpenCode session missing for spark ${input.sparkId}`,
      });
    }

    const instance = await getOpencodeInstanceById(session.opencodeInstanceId);
    if (!instance) {
      throw new ORPCError("NOT_FOUND", {
        message: "OpenCode instance not found",
      });
    }

    const client = getOpencodeClient({
      baseUrl: instance.baseUrl,
      rootPath: instance.rootPath,
    });
    const result = await client.session.messages({
      sessionID: session.opencodeSessionId,
      limit: input.limit,
    });

    console.log("[triage-debug][api.messages] loaded", {
      sparkId: input.sparkId,
      opencodeSessionId: session.opencodeSessionId,
      count: result.data?.length ?? 0,
      firstMessageIds: (result.data ?? []).slice(0, 3).map(msg => msg.info.id),
    });

    return result.data ?? [];
  } catch (error) {
    console.error("oRPC user.triage.messages failed", {
      sparkId: input.sparkId,
      error,
    });

    if (error instanceof ORPCError) {
      throw error;
    }

    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to load triage messages",
    });
  }
});
