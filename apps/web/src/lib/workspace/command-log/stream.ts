import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Schema } from 'effect';
import { useEffect, useMemo, useReducer, useState } from 'react';

import {
  commandLogStreamOutputMessageSchema,
  type CommandLogMetadataLatestRun,
  type CommandLogStreamErrorCode,
  type CommandLogStreamOutputMessage,
  type CommandStatus,
} from '@isagi/contracts';

import { workbenchCopy } from '../../../copy/index.js';
import { runRuntimeEffect } from '../../runtime/run.js';
import { commandLogMetadataQueryKey, worktreeCommandsQueryKey } from '../query-keys.js';
import { formatRuntimeError, resolveCommandLogStreamWebSocketUrl } from '../runtime-data.js';
import { createCommandLogTransport, type CommandLogTransport } from './transport.js';

export type CommandLogStreamPhase =
  | 'idle'
  | 'connecting'
  | 'replaying'
  | 'streaming'
  | 'frozen'
  | 'closed'
  | 'errored';

export type CommandLogStreamNotice =
  | {
      readonly kind: 'protocol';
      readonly code: CommandLogStreamErrorCode;
      readonly message?: string | undefined;
    }
  | {
      readonly kind: 'transport';
      readonly message: string;
    };

export type CommandLogStreamState = {
  readonly phase: CommandLogStreamPhase;
  readonly status: CommandStatus | null;
  readonly latestRun: CommandLogMetadataLatestRun | null;
  readonly live: boolean;
  readonly exit: { readonly exitCode: number | null; readonly signal: string | null } | null;
  readonly notice: CommandLogStreamNotice | null;
};

type CommandLogStreamEvent =
  | { readonly type: 'connect' }
  | {
      readonly type: 'state';
      readonly message: Extract<CommandLogStreamOutputMessage, { type: 'command_log_state' }>;
    }
  | { readonly type: 'replay_start' }
  | { readonly type: 'replay_end' }
  | { readonly type: 'exit'; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly type: 'closed' }
  | { readonly type: 'error'; readonly notice: CommandLogStreamNotice };

export const initialCommandLogStreamState: CommandLogStreamState = {
  phase: 'idle',
  status: null,
  latestRun: null,
  live: false,
  exit: null,
  notice: null,
};

export function commandLogStreamReducer(
  state: CommandLogStreamState,
  event: CommandLogStreamEvent,
): CommandLogStreamState {
  switch (event.type) {
    case 'connect':
      return { ...initialCommandLogStreamState, phase: 'connecting' };
    case 'state':
      return {
        ...state,
        phase: event.message.live ? 'streaming' : state.phase,
        status: event.message.status,
        latestRun: event.message.latestRun,
        live: event.message.live,
        notice: null,
      };
    case 'replay_start':
      return { ...state, phase: 'replaying' };
    case 'replay_end':
      return { ...state, phase: state.live ? 'streaming' : 'closed' };
    case 'exit':
      return {
        ...state,
        phase: 'frozen',
        exit: { exitCode: event.exitCode, signal: event.signal },
        live: false,
      };
    case 'closed':
      return state.phase === 'frozen' || state.phase === 'errored'
        ? state
        : { ...state, phase: 'closed', live: false };
    case 'error':
      return { ...state, phase: 'errored', live: false, notice: event.notice };
  }
}

export function useCommandLogStream({
  worktreeId,
  commandName,
  latestRunId,
}: {
  readonly worktreeId: number;
  readonly commandName: string;
  readonly latestRunId: number;
}): {
  readonly transport: CommandLogTransport;
  readonly streamKey: string;
  readonly state: CommandLogStreamState;
  readonly rendererWarning: string | null;
  readonly setRendererWarning: (message: string | null) => void;
} {
  const queryClient = useQueryClient();
  const streamKey = `${worktreeId}:${commandName}:${latestRunId}`;
  const transport = useMemo(() => createCommandLogTransport(), [streamKey]);
  const [state, dispatch] = useReducer(commandLogStreamReducer, initialCommandLogStreamState);
  const [rendererWarning, setRendererWarning] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;

    dispatch({ type: 'connect' });
    setRendererWarning(null);

    void runRuntimeEffect(resolveCommandLogStreamWebSocketUrl(worktreeId, commandName)).then(
      (url) => {
        if (disposed) {
          return;
        }
        socket = new WebSocket(url);
        socket.addEventListener('message', (event) => {
          const message = decodeCommandLogStreamMessage(event.data);
          if (!message) {
            transport.freeze();
            dispatch({
              type: 'error',
              notice: { kind: 'protocol', code: 'invalid_message' },
            });
            socket?.close();
            return;
          }
          switch (message.type) {
            case 'command_log_state':
              dispatch({ type: 'state', message });
              return;
            case 'replay_start':
              dispatch({ type: 'replay_start' });
              return;
            case 'output':
              transport.pushOutput(message.data);
              return;
            case 'replay_end':
              dispatch({ type: 'replay_end' });
              return;
            case 'exit':
              transport.freeze();
              dispatch({ type: 'exit', exitCode: message.exitCode, signal: message.signal });
              void invalidateCommandReadModel(queryClient, worktreeId, commandName);
              socket?.close();
              return;
            case 'error':
              transport.freeze();
              dispatch({
                type: 'error',
                notice: { kind: 'protocol', code: message.code, message: message.message },
              });
              socket?.close();
              return;
          }
        });
        socket.addEventListener('close', () => {
          if (!disposed) {
            dispatch({ type: 'closed' });
          }
        });
        socket.addEventListener('error', () => {
          transport.freeze();
          dispatch({
            type: 'error',
            notice: { kind: 'transport', message: workbenchCopy.commandLogConnectionFailed },
          });
          socket?.close();
        });
      },
      (error: unknown) => {
        if (disposed) {
          return;
        }
        dispatch({
          type: 'error',
          notice: { kind: 'transport', message: formatRuntimeError(error) },
        });
        transport.freeze();
      },
    );

    return () => {
      disposed = true;
      socket?.close();
      transport.freeze();
    };
  }, [commandName, queryClient, transport, worktreeId]);

  return { transport, streamKey, state, rendererWarning, setRendererWarning };
}

export function decodeCommandLogStreamMessage(data: unknown): CommandLogStreamOutputMessage | null {
  try {
    return Schema.decodeUnknownSync(commandLogStreamOutputMessageSchema)(JSON.parse(String(data)));
  } catch {
    return null;
  }
}

async function invalidateCommandReadModel(
  queryClient: QueryClient,
  worktreeId: number,
  commandName: string,
) {
  await queryClient.invalidateQueries({
    queryKey: worktreeCommandsQueryKey(worktreeId),
    exact: true,
  });
  await queryClient.invalidateQueries({
    queryKey: commandLogMetadataQueryKey(worktreeId, commandName),
  });
}
