import { appendHarnessEventSource, writeHarnessMetadataSource } from '../ledger.common.js';

export function opencodePluginSource() {
  return String.raw`${writeHarnessMetadataSource()}
${appendHarnessEventSource('opencode')}
${writeOpenCodeStatusSource()}

function sessionIdFromEvent(event) {
  const properties = event?.properties;
  return (
    properties?.sessionID ??
    properties?.sessionId ??
    properties?.info?.sessionID ??
    properties?.info?.sessionId ??
    properties?.part?.sessionID ??
    properties?.part?.sessionId ??
    properties?.session?.id ??
    properties?.info?.id ??
    null
  );
}

function sessionIdFromHookInput(input) {
  return input?.sessionID ?? input?.sessionId ?? input?.session?.id ?? null;
}

export const IsagiSessionObserver = async () => {
  const completedAssistantMessageIds = new Set();
  const completedTextPartIds = new Set();
  return {
    event: async ({ event }) => {
      if (!event) return;
      if (event.type === "session.status") {
        const sessionId = sessionIdFromEvent(event);
        await writeHarnessMetadata(sessionId);
        await appendHarnessEvent(sessionId, "session.status", {
          nativeEvent: "session.status",
          event: safeJsonValue(event),
          status: sessionStatusFromEvent(event),
        });
        return;
      }
      if (event.type === "session.idle" || event.type === "session.error") {
        const sessionId = sessionIdFromEvent(event);
        await writeHarnessMetadata(sessionId);
        await appendHarnessEvent(sessionId, event.type, {
          nativeEvent: event.type,
          event: safeJsonValue(event),
        });
        return;
      }
      if (event.type === "message.part.updated" && isCompletedTextPartEvent(event)) {
        const partId = event?.properties?.part?.id;
        if (completedTextPartIds.has(partId)) return;
        completedTextPartIds.add(partId);
        const sessionId = sessionIdFromEvent(event);
        await appendHarnessEvent(sessionId, "message.part.updated", {
          nativeEvent: "message.part.updated",
          event: safeJsonValue(event),
        });
        return;
      }
      if (event.type === "message.updated" && isCompletedAssistantMessageEvent(event)) {
        const messageId = event?.properties?.info?.id;
        if (completedAssistantMessageIds.has(messageId)) return;
        completedAssistantMessageIds.add(messageId);
        const sessionId = sessionIdFromEvent(event);
        await appendHarnessEvent(sessionId, "message.updated", {
          nativeEvent: "message.updated",
          event: safeJsonValue(event),
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
    "chat.message": async (input, output) => {
      await writeHarnessMetadata(sessionIdFromHookInput(input));
      await appendHarnessEvent(sessionIdFromHookInput(input), "chat.message", {
        nativeEvent: "chat.message",
        input: safeJsonValue(input),
        output: safeJsonValue(output),
      });
    },
  };
};
`;
}

function writeOpenCodeStatusSource() {
  return String.raw`function sessionStatusFromEvent(event) {
  const status = event?.properties?.status ?? event?.properties?.session?.status ?? event?.status;
  if (typeof status === "string" && status) return status;
  if (status && typeof status === "object" && typeof status.type === "string" && status.type) {
    return status.type;
  }
  return null;
}

function isCompletedAssistantMessageEvent(event) {
  const info = event?.properties?.info;
  return typeof info?.id === "string" && info?.role === "assistant" && typeof info?.time?.completed === "number";
}

function isCompletedTextPartEvent(event) {
  const part = event?.properties?.part;
  // v1: intentionally skipping tool-call parts
  return typeof part?.id === "string" && part?.type === "text" && typeof part?.text === "string" && typeof part?.time?.end === "number";
}
`;
}
