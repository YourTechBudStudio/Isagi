import { appendHarnessEventSource, writeHarnessMetadataSource } from './artifacts.common.js';

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

export default function (pi: any) {
  pi.on("before_agent_start", async (event) => {
    lastBeforeAgentStart = safeJsonValue(event);
  });
  pi.on("agent_start", async (event, ctx) => observeStart(event, ctx));
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
