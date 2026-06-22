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

function writeOpenCodeStatusSource() {
  return String.raw`function sessionStatusFromEvent(event) {
  const status = event?.properties?.status ?? event?.properties?.session?.status ?? event?.status;
  if (typeof status === "string" && status) return status;
  if (status && typeof status === "object" && typeof status.type === "string" && status.type) {
    return status.type;
  }
  return null;
}
`;
}
