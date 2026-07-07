import { Schema } from 'effect';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import {
  workflowEventsStreamOutputMessageSchema,
  type WorkflowEvent,
  type WorkflowEventsStreamOutputMessage,
} from '@isagi/contracts';

import { runRuntimeEffect } from '../../runtime/run.js';
import {
  initialPtyStreamConnectionState,
  ptyStreamConnectionReducer,
  type PtyStreamConnectionState,
} from '../pty-stream/connection.js';
import { resolveWorkflowEventsStreamWebSocketUrl } from '../runtime-data.js';

export interface WorkflowEventStreamState {
  readonly events: readonly WorkflowEvent[];
  readonly connection: PtyStreamConnectionState;
}

export function useWorkflowEventStream({
  runId,
  includeChildren = false,
  enabled,
}: {
  readonly runId: number | null;
  readonly includeChildren?: boolean | undefined;
  readonly enabled: boolean;
}): WorkflowEventStreamState {
  const [events, setEvents] = useState<readonly WorkflowEvent[]>([]);
  const [connection, dispatch] = useReducer(
    ptyStreamConnectionReducer,
    initialPtyStreamConnectionState,
  );
  const streamKey = `${runId ?? 'none'}:${includeChildren ? 'children' : 'single'}:${enabled ? 'enabled' : 'disabled'}`;

  useEffect(() => {
    setEvents([]);
    dispatch({ type: 'reset' });
  }, [streamKey]);

  const resolveUrl = useCallback(() => {
    if (runId === null) throw new Error('Workflow event stream requires a run id.');
    return resolveWorkflowEventsStreamWebSocketUrl(runId, { includeChildren });
  }, [includeChildren, runId]);

  useEffect(() => {
    if (!enabled || runId === null) return;

    let disposed = false;
    let socket: WebSocket | null = null;

    dispatch({ type: 'connect_started' });
    void runRuntimeEffect(resolveUrl()).then(
      (url) => {
        if (disposed) return;
        socket = new WebSocket(url);
        socket.addEventListener('open', () => {
          dispatch({ type: 'socket_open' });
          socket?.send(JSON.stringify({ type: 'workflow_events_requested' }));
        });
        socket.addEventListener('message', (event) => {
          const message = decodeWorkflowEventsStreamMessage(event.data);
          if (!message) {
            dispatch({
              type: 'errored',
              notice: { kind: 'protocol', code: 'invalid_message' },
            });
            socket?.close();
            return;
          }
          if (message.type === 'error') {
            dispatch({
              type: 'errored',
              notice: { kind: 'transport', message: message.message ?? message.code },
            });
            socket?.close();
            return;
          }
          if (message.type === 'workflow_events_snapshot') {
            setEvents(capRecentEvents([...message.events].sort(compareWorkflowEvents)));
            return;
          }
          if (message.type === 'workflow_event_appended') {
            setEvents((current) =>
              capRecentEvents([...current, message.event].sort(compareWorkflowEvents)),
            );
          }
        });
        socket.addEventListener('close', () => {
          if (!disposed) dispatch({ type: 'socket_closed' });
        });
        socket.addEventListener('error', () => {
          dispatch({
            type: 'errored',
            notice: { kind: 'transport', message: 'Workflow event stream connection failed.' },
          });
          socket?.close();
        });
      },
      (error: unknown) => {
        if (disposed) return;
        dispatch({
          type: 'errored',
          notice: {
            kind: 'transport',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );

    return () => {
      disposed = true;
      socket?.close();
    };
  }, [enabled, resolveUrl, runId]);

  return useMemo(() => ({ events, connection }), [connection, events]);
}

export function decodeWorkflowEventsStreamMessage(
  data: unknown,
): WorkflowEventsStreamOutputMessage | null {
  try {
    return Schema.decodeUnknownSync(workflowEventsStreamOutputMessageSchema)(
      JSON.parse(String(data)),
    );
  } catch {
    return null;
  }
}

// Cap the in-memory buffer (and its per-append re-sort) so a long-running or fan-out
// workflow can't grow it without bound. The panel is a recent-activity log, so the
// most recent N events suffice; older lines scroll out. Keep this aligned with the
// server snapshot cap in apps/runtime/src/workflows/api.ts.
const maxBufferedWorkflowEvents = 1000;

function capRecentEvents(events: readonly WorkflowEvent[]): readonly WorkflowEvent[] {
  return events.length > maxBufferedWorkflowEvents
    ? events.slice(events.length - maxBufferedWorkflowEvents)
    : events;
}

function compareWorkflowEvents(left: WorkflowEvent, right: WorkflowEvent) {
  const ts = left.ts.localeCompare(right.ts);
  if (ts !== 0) return ts;
  return left.runId - right.runId;
}
