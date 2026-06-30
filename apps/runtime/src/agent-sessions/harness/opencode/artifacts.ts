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
  return {
    event: async ({ event }) => {
      if (!event) return;
      if (event.type === "session.status") {
        const sessionId = sessionIdFromEvent(event);
        await writeHarnessMetadata(sessionId);
        await appendHarnessEvent(sessionId, "session.status", {
          nativeEvent: "session.status",
          event: minimalOpenCodeEvent(event),
          orderKey: openCodeEventOrderKey(event),
          status: sessionStatusFromEvent(event),
        });
        return;
      }
      if (event.type === "session.idle" || event.type === "session.error") {
        const sessionId = sessionIdFromEvent(event);
        await writeHarnessMetadata(sessionId);
        await appendHarnessEvent(sessionId, event.type, {
          nativeEvent: event.type,
          event: minimalOpenCodeEvent(event),
          orderKey: openCodeEventOrderKey(event),
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
      await appendHarnessEvent(sessionIdFromHookInput(input), "agent_start", {
        nativeEvent: "agent_start",
        sessionId: sessionIdFromHookInput(input),
        messageId: openCodeHookMessageId(input),
        orderKey: openCodeHookOrderKey(input),
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

function minimalOpenCodeEvent(event) {
  return {
    id: stringOrNull(event?.id),
    type: stringOrNull(event?.type),
    properties: {
      sessionID: sessionIdFromEvent(event),
      status: sessionStatusFromEvent(event),
    },
  };
}

function openCodeEventOrderKey(event) {
  return sortableOpenCodeId(stringOrNull(event?.id));
}

function openCodeHookOrderKey(input) {
  return sortableOpenCodeId(openCodeHookMessageId(input) ?? stringOrNull(input?.event?.id));
}

function openCodeHookMessageId(input) {
  return (
    stringOrNull(input?.messageID) ??
    stringOrNull(input?.messageId) ??
    stringOrNull(input?.message?.id) ??
    stringOrNull(input?.info?.id) ??
    null
  );
}

function sortableOpenCodeId(id) {
  if (!id) return null;
  const separator = id.indexOf("_");
  return separator >= 0 ? id.slice(separator + 1) : id;
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}
`;
}
