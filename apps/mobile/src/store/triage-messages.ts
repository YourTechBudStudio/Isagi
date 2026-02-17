import { create } from "zustand";

import type { MessageInfo, MessagePart, SessionStatus } from "@/types/triage";

// ── Store shape ──

interface TriageMessagesState {
  /** Ordered message IDs (insertion order). */
  messageOrder: string[];
  /** Message info keyed by message ID. */
  messages: Record<string, MessageInfo>;
  /** Parts keyed by part ID. */
  parts: Record<string, MessagePart>;
  /** Part IDs grouped by message ID (preserves order). */
  partsByMessage: Record<string, string[]>;
  /** Current session status from SSE. */
  sessionStatus: SessionStatus | null;

  actions: TriageMessagesActions;
}

interface TriageMessagesActions {
  /**
   * Seed the store with the initial transcript fetched via
   * `user.triage.messages`. Clears any existing state first.
   */
  hydrate(
    messages: readonly { info: MessageInfo; parts: MessagePart[] }[],
  ): void;

  /** SSE: message.updated — upsert message info. */
  applyMessageUpdated(info: MessageInfo): void;

  /** SSE: message.part.updated — upsert a part (add or replace). */
  applyPartUpdated(part: MessagePart): void;

  /** SSE: message.part.delta — append to a field on an existing part. */
  applyPartDelta(partId: string, field: string, delta: string): void;

  /** SSE: message.part.removed — remove a part. */
  applyPartRemoved(partId: string): void;

  /** SSE: session.status — update session status indicator. */
  setSessionStatus(status: SessionStatus): void;

  /** Reset the store (e.g. when leaving the conversation screen). */
  clear(): void;
}

// ── Store implementation ──

export const useTriageMessagesStore = create<TriageMessagesState>(set => ({
  messageOrder: [],
  messages: {},
  parts: {},
  partsByMessage: {},
  sessionStatus: null,

  actions: {
    hydrate(incoming) {
      const messages: Record<string, MessageInfo> = {};
      const parts: Record<string, MessagePart> = {};
      const partsByMessage: Record<string, string[]> = {};
      const messageOrder: string[] = [];

      for (const msg of incoming) {
        const msgId = msg.info.id;
        messages[msgId] = msg.info;
        messageOrder.push(msgId);
        partsByMessage[msgId] = [];

        for (const part of msg.parts) {
          parts[part.id] = part;
          partsByMessage[msgId].push(part.id);
        }
      }

      set({
        messages,
        parts,
        partsByMessage,
        messageOrder,
        sessionStatus: null,
      });
    },

    applyMessageUpdated(info) {
      set(state => {
        const isNew = !(info.id in state.messages);
        return {
          messages: { ...state.messages, [info.id]: info },
          messageOrder: isNew
            ? [...state.messageOrder, info.id]
            : state.messageOrder,
          partsByMessage: isNew
            ? { ...state.partsByMessage, [info.id]: [] }
            : state.partsByMessage,
        };
      });
    },

    applyPartUpdated(part) {
      set(state => {
        const existingPartIds = state.partsByMessage[part.messageID] ?? [];
        const isNew = !existingPartIds.includes(part.id);

        return {
          parts: { ...state.parts, [part.id]: part },
          partsByMessage: isNew
            ? {
                ...state.partsByMessage,
                [part.messageID]: [...existingPartIds, part.id],
              }
            : state.partsByMessage,
        };
      });
    },

    applyPartDelta(partId, field, delta) {
      set(state => {
        const existing = state.parts[partId];
        if (!existing) return state;

        const currentValue =
          typeof existing[field] === "string"
            ? (existing[field] as string)
            : "";

        return {
          parts: {
            ...state.parts,
            [partId]: { ...existing, [field]: currentValue + delta },
          },
        };
      });
    },

    applyPartRemoved(partId) {
      set(state => {
        const existing = state.parts[partId];
        if (!existing) return state;

        const { [partId]: _, ...remainingParts } = state.parts;
        const msgPartIds = state.partsByMessage[existing.messageID];

        return {
          parts: remainingParts,
          partsByMessage: msgPartIds
            ? {
                ...state.partsByMessage,
                [existing.messageID]: msgPartIds.filter(id => id !== partId),
              }
            : state.partsByMessage,
        };
      });
    },

    setSessionStatus(status) {
      set({ sessionStatus: status });
    },

    clear() {
      set({
        messageOrder: [],
        messages: {},
        parts: {},
        partsByMessage: {},
        sessionStatus: null,
      });
    },
  },
}));
