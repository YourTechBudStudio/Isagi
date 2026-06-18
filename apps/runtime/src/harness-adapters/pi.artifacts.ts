import { writeHarnessMetadataSource } from './artifacts.common.js';

export function piExtensionSource() {
  return String.raw`${writeHarnessMetadataSource({ typescript: true })}
${writePiHarnessEventSource()}

let lastBeforeAgentStart: unknown = null;

async function observeStart(event: unknown, ctx: any) {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  await writeHarnessMetadata(sessionId);
  await appendPiHarnessEvent("agent_start", {
    nativeEvent: "agent_start",
    event: safeJsonValue(event),
    beforeAgentStart: lastBeforeAgentStart,
    context: piContext(ctx),
  });
  lastBeforeAgentStart = null;
}

async function observeEnd(event: unknown, ctx: any) {
  await appendPiHarnessEvent("agent_end", {
    nativeEvent: "agent_end",
    event: safeJsonValue(event),
    context: piContext(ctx),
  });
}

export default function (pi: any) {
  pi.on("before_agent_start", async (event) => {
    lastBeforeAgentStart = safeJsonValue(event);
  });
  pi.on("agent_start", async (event, ctx) => observeStart(event, ctx));
  pi.on("agent_end", async (event, ctx) => observeEnd(event, ctx));
}
`;
}

function writePiHarnessEventSource() {
  return String.raw`const jsonlPath = process.env.ISAGI_HARNESS_JSONL_PATH;

function safeJsonValue(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

function callBoolean(fn) {
  try {
    const value = fn?.();
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

function piContext(ctx) {
  return {
    isIdle: callBoolean(ctx?.isIdle?.bind?.(ctx) ?? ctx?.isIdle),
    hasPendingMessages: callBoolean(ctx?.hasPendingMessages?.bind?.(ctx) ?? ctx?.hasPendingMessages),
  };
}

async function appendPiHarnessEvent(nativeEvent, event) {
  if (
    !jsonlPath ||
    !Number.isSafeInteger(agentSessionId) ||
    agentSessionId <= 0 ||
    !Number.isSafeInteger(ptyProcessId) ||
    ptyProcessId <= 0
  ) {
    return;
  }
  try {
    const fs = await import("node:fs/promises");
    await fs.access(jsonlPath);
    await fs.appendFile(
      jsonlPath,
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        agentSessionId,
        ptyProcessId,
        harness: "pi",
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
