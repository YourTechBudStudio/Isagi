import { Effect, Schema } from 'effect';
import { useEffect } from 'react';

import {
  runtimeEventInputMessageSchema,
  runtimeEventSchema,
  type RuntimeEvent,
  type RuntimeEventInputMessage,
} from '@isagi/contracts';

import { queryClient } from '../query/client.js';
import { useAttentionStore } from './attention.js';
import { surfaceDetailQueryKey, workspaceQueryKey } from './query-keys.js';
import { resolveRuntimeEventsWebSocketUrl } from './runtime-data.js';

const initialReconnectDelayMs = 500;
const maxReconnectDelayMs = 20_000;

export function useRuntimeEventSubscription() {
  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectDelayMs = initialReconnectDelayMs;
    let reconnectTimer: number | null = null;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer !== null) {
        return;
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxReconnectDelayMs);
    };

    const connect = () => {
      if (stopped) {
        return;
      }

      void Effect.runPromise(resolveRuntimeEventsWebSocketUrl()).then(
        (url) => {
          if (stopped) {
            return;
          }

          const nextSocket = new WebSocket(url);
          socket = nextSocket;
          nextSocket.addEventListener('open', () => {
            reconnectDelayMs = initialReconnectDelayMs;
            sendRuntimeEventInput(nextSocket, { type: 'attention_snapshot_requested' });
          });
          nextSocket.addEventListener('message', (event) => {
            const runtimeEvent = decodeRuntimeEvent(event.data);
            if (runtimeEvent) {
              handleRuntimeEvent(runtimeEvent);
            }
          });
          nextSocket.addEventListener('close', () => {
            socket = null;
            scheduleReconnect();
          });
          nextSocket.addEventListener('error', () => {
            socket?.close();
          });
        },
        () => {
          scheduleReconnect();
        },
      );
    };

    connect();

    return () => {
      stopped = true;
      clearReconnectTimer();
      socket?.close();
      socket = null;
    };
  }, []);
}

function decodeRuntimeEvent(data: unknown): RuntimeEvent | null {
  try {
    return Schema.decodeUnknownSync(runtimeEventSchema)(JSON.parse(String(data)));
  } catch (error: unknown) {
    console.error('[workspace] runtime event decode failed', error);
    return null;
  }
}

export function handleRuntimeEvent(event: RuntimeEvent) {
  switch (event.type) {
    case 'attention_snapshot':
      useAttentionStore.getState().replaceSources(event.payload.sources);
      break;
    case 'attention_source_changed':
      useAttentionStore.getState().upsertSource(event.payload);
      break;
    case 'attention_source_removed':
      useAttentionStore.getState().removeSource(event.payload.source);
      break;
    case 'agent_session_changed':
    case 'terminal_session_changed':
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
      void queryClient.invalidateQueries({
        queryKey: surfaceDetailQueryKey(event.payload.surfaceId),
      });
      break;
  }
}

function sendRuntimeEventInput(socket: WebSocket, message: RuntimeEventInputMessage) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const encoded = Schema.decodeUnknownSync(runtimeEventInputMessageSchema)(message);
  socket.send(JSON.stringify(encoded));
}
