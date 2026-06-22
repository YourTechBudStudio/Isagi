import { appendHarnessEventSource, writeHarnessMetadataSource } from '../ledger.common.js';

export function piExtensionSource() {
  return String.raw`${writeHarnessMetadataSource({ typescript: true })}
${appendHarnessEventSource('pi')}
${writePiContextSource()}

let lastBeforeAgentStart: unknown = null;

async function observeStart(event: unknown, ctx: any) {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  await writeHarnessMetadata(sessionId);
  await appendHarnessEvent(sessionId, "agent_start", {
    nativeEvent: "agent_start",
    event: safeJsonValue(event),
    beforeAgentStart: lastBeforeAgentStart,
    context: piContext(ctx),
  });
  lastBeforeAgentStart = null;
}

async function observeEnd(event: unknown, ctx: any) {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  await writeHarnessMetadata(sessionId);
  await appendHarnessEvent(sessionId, "agent_end", {
    nativeEvent: "agent_end",
    event: safeJsonValue(event),
    context: piContext(ctx),
  });
}

async function observeMessageEnd(event: any, ctx: any) {
  const message = event?.message;
  const role = message?.role;
  if (role === "toolResult") {
    // v1: intentionally skipping tool-call parts
    return undefined;
  }
  if (role !== "user" && role !== "assistant") return undefined;
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  await writeHarnessMetadata(sessionId);
  await appendHarnessEvent(sessionId, "message_end", {
    nativeEvent: "message_end",
    event: safeJsonValue(event),
    context: piContext(ctx),
  });
  return undefined;
}

export default function (pi: any) {
  pi.on("before_agent_start", async (event) => {
    lastBeforeAgentStart = safeJsonValue(event);
  });
  pi.on("agent_start", async (event, ctx) => observeStart(event, ctx));
  pi.on("message_end", async (event, ctx) => observeMessageEnd(event, ctx));
  pi.on("agent_end", async (event, ctx) => observeEnd(event, ctx));
}
`;
}

function writePiContextSource() {
  return String.raw`function callBoolean(fn) {
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
`;
}
