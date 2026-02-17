import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useAppConfig } from "@/services/AppConfigContext";
import { useORPC } from "@/services/ORPCContext";
import { connectTriageSSE, type SSEConnection } from "@/services/sse";
import { getTriageMessagesActions } from "@/store/triage-messages.selectors";
import type { SSEEvent } from "@/types/triage";

/**
 * Manage an SSE connection for a triage conversation.
 *
 * - Opens the stream on mount.
 * - Dispatches events into the Zustand message store.
 * - Refreshes triage state on file-related events or session idle.
 * - Retries on disconnect with exponential backoff.
 * - Closes on unmount.
 */
export function useTriageSSE(sparkId: string): void {
  const { config } = useAppConfig();
  const orpc = useORPC();
  const queryClient = useQueryClient();
  const connectionRef = useRef<SSEConnection | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (!config || !sparkId) return;

    const { apiUrl, userApiKey } = config;
    const actions = getTriageMessagesActions();

    function handleEvent(event: SSEEvent): void {
      // Reset retry count on successful event
      retryCountRef.current = 0;

      switch (event.type) {
        case "message.updated":
          actions.applyMessageUpdated(event.properties.info);
          break;

        case "message.part.updated":
          actions.applyPartUpdated(event.properties.part);
          break;

        case "message.part.delta":
          actions.applyPartDelta(
            event.properties.partID,
            event.properties.field,
            event.properties.delta,
          );
          break;

        case "message.part.removed":
          actions.applyPartRemoved(event.properties.partID);
          break;

        case "session.status":
          actions.setSessionStatus(event.properties.status);

          // Refresh triage state when session goes idle (agent finished a turn)
          if (event.properties.status.type === "idle") {
            void queryClient.invalidateQueries({
              queryKey: orpc.user.triage.state.queryOptions({
                input: { sparkId },
              }).queryKey,
            });
          }
          break;

        default:
          // Unknown event type — ignore safely
          break;
      }
    }

    function connect(): void {
      connectionRef.current?.close();

      connectionRef.current = connectTriageSSE(apiUrl, sparkId, userApiKey, {
        onEvent: handleEvent,
        onError() {
          // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
          const delay = Math.min(1000 * 2 ** retryCountRef.current, 30_000);
          retryCountRef.current += 1;

          retryTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        },
        onOpen() {
          retryCountRef.current = 0;
        },
      });
    }

    connect();

    return () => {
      connectionRef.current?.close();
      connectionRef.current = null;
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, [config, sparkId, queryClient, orpc]);
}
