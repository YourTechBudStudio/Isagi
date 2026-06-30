import { appendHarnessEventSource, writeHarnessMetadataSource } from '../ledger.common.js';

export function piExtensionSource() {
  return String.raw`${writeHarnessMetadataSource({ typescript: true })}
${appendHarnessEventSource('pi')}
${writePiContextSource()}

async function observeStart(event: unknown, ctx: any) {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  await writeHarnessMetadata(sessionId);
  await appendHarnessEvent(sessionId, "agent_start", {
    nativeEvent: "agent_start",
    context: piContext(ctx),
  });
}

async function observeEnd(event: unknown, ctx: any) {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  await writeHarnessMetadata(sessionId);
  await appendHarnessEvent(sessionId, "agent_end", {
    nativeEvent: "agent_end",
    context: piContext(ctx),
  });
}

async function observeMessageEnd(event: any, ctx: any) {
  const message = event?.message;
  if (message?.role !== "assistant") return undefined;
  const stopReason = message?.stopReason;
  if (stopReason !== "error" && stopReason !== "aborted") return undefined;
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  await writeHarnessMetadata(sessionId);
  await appendHarnessEvent(sessionId, "agent_error", {
    nativeEvent: "agent_error",
    sourceNativeEvent: "message_end",
    stopReason,
    context: piContext(ctx),
  });
  return undefined;
}

export default function (pi: any) {
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
