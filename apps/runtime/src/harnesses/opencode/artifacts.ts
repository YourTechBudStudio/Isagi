import { appendHarnessEventSource, writeHarnessMetadataSource } from '../ledger.common.js';

export function opencodePluginSource() {
  return String.raw`${writeHarnessMetadataSource()}
${appendHarnessEventSource('opencode')}

function sessionIdFromEvent(event) {
  const sessionId = event?.properties?.sessionID;
  return typeof sessionId === "string" && sessionId ? sessionId : null;
}

function sessionIdFromHookInput(input) {
  const sessionId = input?.sessionID;
  return typeof sessionId === "string" && sessionId ? sessionId : null;
}

function isQuestionEvent(event) {
  return event?.type === "question.asked" || event?.type === "question.replied" || event?.type === "question.rejected";
}

const establishedRootSessionIds = new Set();
const resumedRootSessionId = process.env.ISAGI_OPENCODE_RESUMED_ROOT_SESSION_ID;
let latestRootSessionId = null;
if (typeof resumedRootSessionId === "string" && resumedRootSessionId) {
  establishedRootSessionIds.add(resumedRootSessionId);
  latestRootSessionId = resumedRootSessionId;
}
let ignoredUnknownRootEvents = 0;

function rootSessionIdFromCreated(event) {
  const info = event?.properties?.info;
  if (!info || typeof info !== "object") return null;
  if (typeof info.id !== "string" || !info.id) return null;
  if (info.parentID !== undefined && info.parentID !== null) return null;
  return info.id;
}

function establishRootSession(sessionId) {
  establishedRootSessionIds.add(sessionId);
  latestRootSessionId = sessionId;
}

function isEstablishedRootSession(sessionId) {
  return typeof sessionId === "string" && establishedRootSessionIds.has(sessionId);
}

async function writeLatestRootMetadata(sessionId) {
  if (sessionId !== latestRootSessionId) return;
  await writeHarnessMetadata(sessionId);
}

function diagnoseUnknownRootEvent() {
  if (ignoredUnknownRootEvents >= 16) return;
  ignoredUnknownRootEvents += 1;
  console.error("[isagi] OpenCode observation skipped: root session is not established.");
}

export const IsagiSessionObserver = async () => {
  return {
    event: async ({ event }) => {
      if (!event) return;
      if (event.type === "session.created") {
        const sessionId = rootSessionIdFromCreated(event);
        if (!sessionId) return;
        establishRootSession(sessionId);
        await writeLatestRootMetadata(sessionId);
        await appendHarnessEvent(sessionId, "session.created", safeJsonValue(event));
        return;
      }
      if (event.type === "session.status") {
        const sessionId = sessionIdFromEvent(event);
        if (!isEstablishedRootSession(sessionId)) {
          diagnoseUnknownRootEvent();
          return;
        }
        await writeLatestRootMetadata(sessionId);
        await appendHarnessEvent(sessionId, "session.status", safeJsonValue(event));
        return;
      }
      if (event.type === "session.error") {
        const sessionId = sessionIdFromEvent(event);
        if (!isEstablishedRootSession(sessionId)) {
          diagnoseUnknownRootEvent();
          return;
        }
        await writeLatestRootMetadata(sessionId);
        await appendHarnessEvent(sessionId, event.type, safeJsonValue(event));
        return;
      }
      if (isQuestionEvent(event)) {
        const sessionId = sessionIdFromEvent(event);
        if (!isEstablishedRootSession(sessionId)) {
          diagnoseUnknownRootEvent();
          return;
        }
        await writeLatestRootMetadata(sessionId);
        await appendHarnessEvent(sessionId, event.type, safeJsonValue(event));
        return;
      }
      if (event.type === "session.updated") {
        const sessionId = sessionIdFromEvent(event);
        if (isEstablishedRootSession(sessionId)) await writeLatestRootMetadata(sessionId);
      }
    },
    "chat.params": async (input) => {
      const sessionId = sessionIdFromHookInput(input);
      if (isEstablishedRootSession(sessionId)) await writeLatestRootMetadata(sessionId);
    },
  };
};
`;
}
