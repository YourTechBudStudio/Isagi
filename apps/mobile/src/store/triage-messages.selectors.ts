import type { MessageInfo, MessagePart, SessionStatus } from "@/types/triage";

import { useTriageMessagesStore } from "./triage-messages";

// ── Selector hooks (subscribe to minimal slices) ──

/** Ordered list of message IDs. */
export function useMessageOrder(): string[] {
  return useTriageMessagesStore(s => s.messageOrder);
}

/** Message info for a single message. */
export function useMessageInfo(messageId: string): MessageInfo | undefined {
  return useTriageMessagesStore(s => s.messages[messageId]);
}

/** Ordered parts for a single message. */
export function useMessageParts(messageId: string): MessagePart[] {
  return useTriageMessagesStore(s => {
    const partIds = s.partsByMessage[messageId] ?? [];
    return partIds.map(id => s.parts[id]).filter(Boolean) as MessagePart[];
  });
}

/** Ordered part IDs for a single message. */
export function useMessagePartIds(messageId: string): string[] {
  return useTriageMessagesStore(s => s.partsByMessage[messageId] ?? []);
}

/** Single part by id. */
export function useMessagePart(partId: string): MessagePart | undefined {
  return useTriageMessagesStore(s => s.parts[partId]);
}

/** Current session status. */
export function useSessionStatus(): SessionStatus | null {
  return useTriageMessagesStore(s => s.sessionStatus);
}

/** Store actions (stable reference, never causes re-render). */
export function useTriageMessagesActions() {
  return useTriageMessagesStore(s => s.actions);
}

// ── Direct access (for SSE callbacks outside React) ──

export function getTriageMessagesActions() {
  return useTriageMessagesStore.getState().actions;
}
