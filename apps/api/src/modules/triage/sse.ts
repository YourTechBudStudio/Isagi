import type express from "express";

import { runtimeConfig } from "../../lib/config";
import {
  findOpencodeSessionByExternalId,
  getOpencodeInstanceById,
  getSparkTriageBySparkId,
} from "../../lib/db/opencode.repository";
import { getOpencodeClient } from "../../lib/opencode";

function isAuthorized(request: express.Request): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const token = authorization.slice("Bearer ".length);
  return token === runtimeConfig.userApiKey;
}

function extractSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const properties = Reflect.get(payload, "properties");
  if (!properties || typeof properties !== "object") {
    return undefined;
  }

  const direct = Reflect.get(properties, "sessionID");
  if (typeof direct === "string") {
    return direct;
  }

  const info = Reflect.get(properties, "info");
  if (info && typeof info === "object") {
    const nested = Reflect.get(info, "sessionID");
    if (typeof nested === "string") {
      return nested;
    }
  }

  const part = Reflect.get(properties, "part");
  if (part && typeof part === "object") {
    const nested = Reflect.get(part, "sessionID");
    if (typeof nested === "string") {
      return nested;
    }
  }

  return undefined;
}

export function registerTriageSseRoute(app: express.Express): void {
  app.get("/api/user/triage/:sparkId/events", async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ message: "Invalid user API key" });
      return;
    }

    const sparkId = req.params.sparkId;
    const triage = await getSparkTriageBySparkId(sparkId);
    if (!triage) {
      res.status(404).json({ message: "Triage session not found" });
      return;
    }

    const session = await findOpencodeSessionByExternalId(
      triage.opencodeSessionId,
    );
    if (!session) {
      res.status(404).json({ message: "OpenCode session not found" });
      return;
    }

    const instance = await getOpencodeInstanceById(session.opencodeInstanceId);
    if (!instance) {
      res.status(404).json({ message: "OpenCode instance not found" });
      return;
    }

    const client = getOpencodeClient({
      baseUrl: instance.baseUrl,
      rootPath: instance.rootPath,
    });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const abortController = new AbortController();
    req.on("close", () => {
      abortController.abort();
    });

    try {
      const events = await client.global.event({
        signal: abortController.signal,
      });

      for await (const event of events.stream as AsyncIterable<unknown>) {
        if (abortController.signal.aborted) {
          break;
        }

        if (!event || typeof event !== "object") {
          continue;
        }

        const payload = Reflect.get(event, "payload");
        const sessionId = extractSessionId(payload);
        if (sessionId && sessionId !== triage.opencodeSessionId) {
          continue;
        }

        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        res.write(
          `data: ${JSON.stringify({ error: error instanceof Error ? error.message : "Event stream failed" })}\n\n`,
        );
      }
    } finally {
      res.end();
    }
  });
}
