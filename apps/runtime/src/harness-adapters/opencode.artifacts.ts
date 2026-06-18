import { writeHarnessMetadataSource } from './artifacts.common.js';

export function opencodePluginSource() {
  return String.raw`${writeHarnessMetadataSource()}
${writeOpenCodeHarnessEventSource()}

function sessionIdFromEvent(event) {
  const properties = event?.properties;
  return (
    properties?.sessionID ??
    properties?.sessionId ??
    properties?.session?.id ??
    properties?.info?.id ??
    null
  );
}

function sessionIdFromHookInput(input) {
  return input?.sessionID ?? input?.sessionId ?? input?.session?.id ?? null;
}

export const IsagiSessionObserver = async () => {
  return {
    event: async ({ event }) => {
      if (!event) return;
      if (event.type === "session.status") {
        const sessionId = sessionIdFromEvent(event);
        await writeHarnessMetadata(sessionId);
        await appendOpenCodeHarnessEvent(sessionId, "session.status", {
          nativeEvent: "session.status",
          event: safeJsonValue(event),
          status: sessionStatusFromEvent(event),
        });
        return;
      }
      if (event.type === "session.created" || event.type === "session.updated") {
        await writeHarnessMetadata(sessionIdFromEvent(event));
      }
    },
    "chat.params": async (input) => {
      await writeHarnessMetadata(sessionIdFromHookInput(input));
    },
    "chat.message": async (input) => {
      await writeHarnessMetadata(sessionIdFromHookInput(input));
    },
  };
};
`;
}

function writeOpenCodeHarnessEventSource() {
  return String.raw`function safeJsonValue(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

function sessionStatusFromEvent(event) {
  const status = event?.properties?.status ?? event?.properties?.session?.status ?? event?.status;
  if (typeof status === "string" && status) return status;
  if (status && typeof status === "object" && typeof status.type === "string" && status.type) {
    return status.type;
  }
  return null;
}

function harnessSessionLogFileName(harnessSessionId) {
  return Buffer.from(harnessSessionId, "utf8").toString("hex") + ".harness.jsonl";
}

async function appendOpenCodeHarnessEvent(harnessSessionId, nativeEvent, event) {
  if (
    !harnessArtifactDirectory ||
    !harnessSessionId ||
    !Number.isSafeInteger(agentSessionId) ||
    agentSessionId <= 0
  ) {
    return;
  }
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(harnessArtifactDirectory, { recursive: true });
    const jsonlPath = path.join(
      harnessArtifactDirectory,
      harnessSessionLogFileName(harnessSessionId),
    );
    await fs.appendFile(
      jsonlPath,
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        agentSessionId,
        harnessSessionId,
        ptyProcessId: Number.isSafeInteger(ptyProcessId) && ptyProcessId > 0 ? ptyProcessId : null,
        harness: "opencode",
        nativeEvent,
        event,
      }) + "\n",
      "utf8",
    );
  } catch {
    // Observation must never block or fail the user's harness interaction.
  }
}
`;
}
