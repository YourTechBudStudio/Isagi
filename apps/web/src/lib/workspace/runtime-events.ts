import { Schema } from 'effect';
import { useEffect } from 'react';

import {
  runtimeEventInputMessageSchema,
  runtimeEventSchema,
  type CommandStatus,
  type CommandSummary,
  type RuntimeEvent,
  type RuntimeEventInputMessage,
  type WorktreeCommandsOutput,
} from '@isagi/contracts';

import { queryClient } from '../query/client.js';
import { runRuntimeEffect } from '../runtime/run.js';
import { cancelWorkbenchFocusPersistence } from './activation.js';
import { useAttentionStore } from './attention.js';
import {
  commandLogMetadataQueryKey,
  surfaceDetailQueryKey,
  workspaceQueryKey,
  worktreeCommandsQueryKey,
} from './query-keys.js';
import { resolveRuntimeEventsWebSocketUrl } from './runtime-data.js';
import { useWorkspaceStore } from './store.js';
import { publishTerminalWorkspaceFact } from './terminal-presentation/coordinator-events.js';
import { useWorkflowRunStore } from './workflow-runs.js';

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

      void runRuntimeEffect(resolveRuntimeEventsWebSocketUrl()).then(
        (url) => {
          if (stopped) {
            return;
          }

          const nextSocket = new WebSocket(url);
          socket = nextSocket;
          nextSocket.addEventListener('open', () => {
            reconnectDelayMs = initialReconnectDelayMs;
            publishTerminalWorkspaceFact({ type: 'runtime_connected' });
            sendRuntimeEventInput(nextSocket, { type: 'attention_snapshot_requested' });
            sendRuntimeEventInput(nextSocket, { type: 'workflow_run_snapshot_requested' });
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
  publishTerminalWorkspaceFact({ type: 'runtime_event', event });
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
    case 'workflow_run_snapshot':
      useWorkflowRunStore.getState().replace(event.payload.summaries);
      break;
    case 'workflow_run_changed':
      useWorkflowRunStore.getState().upsert(event.payload);
      break;
    case 'workflow_run_cleared':
      useWorkflowRunStore.getState().clear(event.payload);
      break;
    case 'durable_session_deleted':
      break;
    case 'agent_session_changed':
    case 'terminal_session_changed':
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
      void queryClient.invalidateQueries({
        queryKey: surfaceDetailQueryKey(event.payload.surfaceId),
      });
      break;
    case 'editor_context_changed':
      // Surface detail only, unlike the session cases above. An editor status
      // change alters nothing the workspace snapshot carries — not `paneKinds`,
      // not titles, not `activeSurfaceId`. Placement changes still arrive as
      // `surface_changed`, which invalidates both.
      void queryClient.invalidateQueries({
        queryKey: surfaceDetailQueryKey(event.payload.surfaceId),
      });
      break;
    case 'surface_changed':
      handleSurfaceChangedEvent(event);
      break;
    case 'command_changed':
      // Flip the command's status in the cached catalog right away so its
      // attention dot is honest immediately, then invalidate to reconcile the
      // facts the event does not carry (ports, removed/managed membership).
      queryClient.setQueryData<WorktreeCommandsOutput>(
        worktreeCommandsQueryKey(event.payload.worktreeId),
        (data) => patchCommandStatus(data, event.payload.commandName, event.payload.status),
      );
      void queryClient.invalidateQueries({
        queryKey: worktreeCommandsQueryKey(event.payload.worktreeId),
        exact: true,
      });
      void queryClient.invalidateQueries({
        queryKey: commandLogMetadataQueryKey(event.payload.worktreeId, event.payload.commandName),
      });
      break;
  }
}

function handleSurfaceChangedEvent(
  event: Extract<RuntimeEvent, { readonly type: 'surface_changed' }>,
) {
  void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });

  if (event.payload.change === 'deleted') {
    cancelWorkbenchFocusPersistence(event.payload.worktreeId);
    queryClient.removeQueries({
      queryKey: surfaceDetailQueryKey(event.payload.surfaceId),
      exact: true,
    });
    const store = useWorkspaceStore.getState();
    store.forgetSurface(event.payload.worktreeId, event.payload.surfaceId);
    store.forgetPane(event.payload.surfaceId);
    return;
  }

  void queryClient.invalidateQueries({
    queryKey: surfaceDetailQueryKey(event.payload.surfaceId),
  });

  if (event.payload.change === 'pane_deleted') {
    const store = useWorkspaceStore.getState();
    for (const paneId of event.payload.deletedPaneIds) {
      store.forgetPane(event.payload.surfaceId, paneId);
    }
  }
}

function patchCommandStatus(
  data: WorktreeCommandsOutput | undefined,
  commandName: string,
  status: CommandStatus,
): WorktreeCommandsOutput | undefined {
  if (!data) return data;
  // Resolved ports belong to an incarnation, and a status-only event cannot
  // vouch for one. On a restart the intermediate stop is suppressed, so the
  // cached entries here belong to the *dead* incarnation — carrying them
  // forward would present a possibly-wrong port as current. Clearing on every
  // transition leaves the refetch as the only route by which authoritative
  // endpoint facts enter the cache.
  //
  // `[]` and not `null`: the patcher must never be able to write the
  // authoritative degraded value, or an ordinary launch would flash the
  // "unavailable for this run" notice during every refetch window.
  const patch = (commands: readonly CommandSummary[]): CommandSummary[] =>
    commands.map((command) =>
      command.name === commandName ? { ...command, status, ports: [] } : command,
    );
  if (data.status === 'configured') {
    return {
      ...data,
      commands: patch(data.commands),
      removedCommands: patch(data.removedCommands),
    };
  }
  return { ...data, managedCommands: patch(data.managedCommands) };
}

function sendRuntimeEventInput(socket: WebSocket, message: RuntimeEventInputMessage) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const encoded = Schema.decodeUnknownSync(runtimeEventInputMessageSchema)(message);
  socket.send(JSON.stringify(encoded));
}
