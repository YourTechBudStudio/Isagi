/**
 * Lightweight SSE client for triage event streaming.
 *
 * Uses `react-native-sse` which provides an EventSource implementation
 * compatible with React Native + custom auth headers.
 */
import EventSource from "react-native-sse";

import type { SSEEvent } from "@/types/triage";

interface SSEEnvelope {
  readonly payload?: SSEEvent;
}

export interface SSEConnection {
  /** Close the SSE connection. Safe to call multiple times. */
  close(): void;
}

export interface SSEHandlers {
  onEvent(event: SSEEvent): void;
  onError(error: unknown): void;
  onOpen?(): void;
  onClose?(): void;
}

/**
 * Open an SSE connection to the triage event stream for a given spark.
 *
 * @param apiUrl  - Base API URL (e.g. `http://host:13000/api`)
 * @param sparkId - The spark whose triage events to stream
 * @param token   - Bearer token for auth
 * @param handlers - Callbacks for events, errors, and lifecycle
 */
export function connectTriageSSE(
  apiUrl: string,
  sparkId: string,
  token: string,
  handlers: SSEHandlers,
): SSEConnection {
  const url = `${apiUrl}/user/triage/${sparkId}/events`;

  const es = new EventSource(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  es.addEventListener("open", () => {
    handlers.onOpen?.();
  });

  es.addEventListener("message", event => {
    if (!event.data) return;

    try {
      const parsed = JSON.parse(event.data as string) as SSEEnvelope | SSEEvent;
      if (parsed && typeof parsed === "object" && "payload" in parsed) {
        if (parsed.payload) {
          handlers.onEvent(parsed.payload);
        }
        return;
      }

      handlers.onEvent(parsed as SSEEvent);
    } catch {
      // Ignore malformed events — don't crash the stream.
    }
  });

  es.addEventListener("error", event => {
    handlers.onError(event);
  });

  return {
    close() {
      es.close();
    },
  };
}
