import { Effect, Schema } from 'effect';
import { useEffect } from 'react';

import { runtimeEventSchema, type RuntimeEvent } from '@isagi/contracts';

import { queryClient } from '../query/client.js';
import { surfaceDetailQueryKey, workspaceQueryKey } from './queries.js';
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

          socket = new WebSocket(url);
          socket.addEventListener('open', () => {
            reconnectDelayMs = initialReconnectDelayMs;
          });
          socket.addEventListener('message', (event) => {
            const runtimeEvent = decodeRuntimeEvent(event.data);
            if (runtimeEvent) {
              handleRuntimeEvent(runtimeEvent);
            }
          });
          socket.addEventListener('close', () => {
            socket = null;
            scheduleReconnect();
          });
          socket.addEventListener('error', () => {
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
    case 'pty_session_changed':
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
      void queryClient.invalidateQueries({
        queryKey: surfaceDetailQueryKey(event.payload.surfaceId),
      });
      break;
  }
}
